import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  type SkillLibraryFile,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  SkillResourceDeliverySchema,
  SKILL_RESOURCE_MAX_SKILLS,
  type SkillResourceDelivery,
} from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { hasActiveDiagnosticTracePropagation } from "../../infra/diagnostic-trace-propagation.js";
import { isMissingPathError } from "../../infra/errors.js";
import { acquireFileLock } from "../../infra/file-lock.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { removeTemporaryArtifacts } from "../../infra/temp-artifact-cleanup.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  copyExplicitSkillSelectionFileHost,
  resolveExplicitSkillSelectionFileHost,
} from "../discovery/skill-command-provenance.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  prepareSkillBundle,
  readSkillBundleTree,
  readSkillLibraryManifestTree,
  skillLibraryRevisionDir,
  SkillTreeDirectoryError,
} from "../library/bundle.js";
import { readSkillLibrarySelectionManifests } from "../library/selection-read.js";
import {
  captureSkillLibraryPreparation,
  prepareSkillLibrarySelection,
} from "../library/selection.js";
import { loadSingleSkillDirectory } from "../loading/local-loader.js";
import {
  createSyntheticSourceInfo,
  escapeSkillXml,
  type Skill,
} from "../loading/skill-contract.js";
import { shouldSyncSkillPath } from "../loading/skill-paths.js";
import { parseSkillsPromptCatalog } from "../loading/skill-prompt-catalog.js";
import { formatSkillsForPromptBounded } from "../loading/skill-prompt-limits.js";
import { recordSkillFileHost, resolveSkillFileHost } from "../skill-file-host.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { ExplicitSkillSelection, SkillSnapshot, SkillResourceSourceReader } from "../types.js";
import { resolveSkillReadPath } from "../workspace-skill-read-path.js";
import { getSkillsResourceVersion, type SkillsSourceScope } from "./refresh-state.js";
import { resolveSkillResourceCandidates } from "./resource-candidates.js";
import { SkillResourceDeliveryLimitError } from "./resource-delivery-error.js";

const log = createSubsystemLogger("skills/resources");

function contextualizeSkillResourceError(skill: { name: string; baseDir: string }, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const message =
    `Failed to prepare skill resources: skill=${JSON.stringify(skill.name)} ` +
    `root=${JSON.stringify(skill.baseDir)} error=${detail}`;
  if (error instanceof SkillLibraryError) {
    return new SkillLibraryError(error.code, message, error.currentRevision, { cause: error });
  }
  return new SkillLibraryError("INVALID_BUNDLE", message, undefined, { cause: error });
}

function isMissingDiscoveredSkillRoot(error: unknown): error is SkillTreeDirectoryError {
  return (
    error instanceof SkillTreeDirectoryError &&
    path.resolve(error.failedPath) === path.resolve(error.rootPath) &&
    isMissingPathError(error.cause)
  );
}

export async function resolveExplicitSkillResource(
  selection: ExplicitSkillSelection,
): Promise<Skill | null> {
  const skillDir = path.dirname(selection.path);
  const rootRealPath = await fs.realpath(skillDir);
  return (
    loadSingleSkillDirectory({
      skillDir,
      rootRealPath,
      source: "openclaw-resources",
      maxBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
    })?.skill ?? null
  );
}

export async function readSkillResourceFiles(
  skill: Skill,
  options: {
    allowMissingRoot: boolean;
    assertFileAccess?: (requestedPath: string, canonicalPath: string) => void;
  },
): Promise<SkillLibraryFile[] | null> {
  try {
    return await readSkillBundleTree(skill.baseDir, shouldSyncSkillPath, {
      symlinks: "follow-within-root",
      assertFileAccess: options.assertFileAccess,
    });
  } catch (error) {
    // Translate the native root-only disappearance on the host, before transport serialization.
    if (options.allowMissingRoot && isMissingDiscoveredSkillRoot(error)) {
      log.warn("Skipping stale discovered skill during worker resource preparation.", {
        skill: skill.name,
        root: skill.baseDir,
        failedPath: error.failedPath,
        error: error.message,
      });
      return null;
    }
    throw error;
  }
}

const localSkillResourceReader: SkillResourceSourceReader = {
  readInstructions: (filePath, options) => fs.readFile(filePath, { ...options, encoding: "utf8" }),
  resolveExplicitSkill: resolveExplicitSkillResource,
  readSkillFiles: readSkillResourceFiles,
};

/**
 * Stamps the retained bundle identity onto discovered directory-skill entries
 * at the catalog intake. The fingerprint identifies the loaded skill bundle —
 * the bundle the entry's owning host reader gathers at discovery — never the
 * exact bytes a later delivery serves: identity is a property of the loaded
 * bundle, computed here once per loaded version per bundle directory through
 * the existing `prepareSkillBundle` digest over the walked tree, and every
 * emission looks the retained field up. Discovery identity caches key by host
 * identity (the reader object), bundle directory, and the skills resource
 * version, so a Gateway skill and a same-path workspace skill never share an
 * identity, a remote path absent on the Gateway is read through the workspace
 * that owns it, and a watcher reload (or any skills source refresh) restamps
 * from the reloaded tree: future spans carry the new fingerprint while a live
 * delivery keeps its generation's identity for the turn. A skill that already
 * carries a fingerprint keeps it verbatim — worker materialization, the node
 * session route, the remote transfer adapter, and library pins stamp their own
 * identities, and discovery never re-hashes another producer's stamp.
 * `node://` locators, unreadable roots, and unavailable owning readers omit
 * the field; a telemetry-only read failure omits rather than weakens resource
 * integrity or fails the run. Stamping copies skills instead of mutating them
 * so loader caches and caller-owned snapshots stay untouched, and a skill
 * whose identity is unchanged keeps the original object. The whole pass is
 * gated on the active tracing consumer, checked once per intake: zero bundle
 * hashing or filesystem walks while tracing is disabled.
 */
const MAX_DISCOVERED_IDENTITY_CACHE_ENTRIES = 256;
const discoveredBundleIdentityCaches = new WeakMap<
  SkillResourceSourceReader,
  Map<string, Promise<string | undefined>>
>();

async function readDiscoveredBundleIdentity(
  skill: Skill,
  reader: SkillResourceSourceReader,
): Promise<string | undefined> {
  try {
    const files = await reader.readSkillFiles(skill, { allowMissingRoot: true });
    return files ? prepareSkillBundle(files).revision : undefined;
  } catch {
    // Telemetry-only acquisition: omit rather than weaken resource integrity.
    return undefined;
  }
}

/** Options that scope the identity lookup or re-derive carried stamps. */
export type DiscoveredSkillIdentityOptions = {
  /** Source scope the watcher records resource versions under. */
  sourceScope?: SkillsSourceScope;
  /** Recompute directory identities despite carried stamps; library pins and
   * `node://` locators keep theirs. Reserved for a watcher-observed reload. */
  recompute?: boolean;
};

/** Stamps the loaded-bundle identity onto discovered skills, by lookup per loaded version. */
export async function stampDiscoveredSkillBundleIdentities(
  skills: readonly Skill[],
  workspaceDir?: string,
  options?: DiscoveredSkillIdentityOptions,
): Promise<Skill[]> {
  if (
    !skills.length ||
    // Zero telemetry-driven hashing while no exporter-owned tracing consumer
    // is active: the gate is the trace-propagation bridge, never the
    // process-diagnostics dispatcher flag.
    !hasActiveDiagnosticTracePropagation()
  ) {
    return [...skills];
  }
  // Host-aware reader selection mirrors prepareSkillResourceDelivery: entries
  // owned by the Gateway read locally; every other entry reads through the
  // remote workspace's owning reader when that workspace owns skill loading.
  // Reader object identity doubles as host identity in the cache below, so
  // same-path cross-host bundles hash their own host's bytes.
  let workspaceAccess: AgentWorkspaceAccess | undefined;
  let workspaceAccessUnavailable = false;
  if (workspaceDir) {
    try {
      workspaceAccess = getAgentWorkspaceAccess(workspaceDir, "loadSkills");
    } catch {
      // A stale workspace binding must never fail a run for telemetry: omit
      // non-Gateway identities instead of guessing which host owns the bytes.
      workspaceAccessUnavailable = true;
    }
  }
  const isLibraryPin = (skill: Skill): boolean => skill.source === "openclaw-library";
  const resolveSourceReader = (skill: Skill): SkillResourceSourceReader | undefined => {
    if (resolveSkillFileHost(skill) === "gateway" || isLibraryPin(skill)) {
      return localSkillResourceReader;
    }
    if (workspaceAccess?.loadSkills) {
      return workspaceAccess.skillResources;
    }
    return workspaceAccessUnavailable ? undefined : localSkillResourceReader;
  };
  // The resource version is the watcher/reload signal: one identity per bundle
  // directory per loaded version, so a reload restamps and a steady state
  // reuses the cached walk without re-hashing. The scoped read is a superset of
  // the unscoped one: execution-root support edits publish under their source
  // scope, and those bumps must invalidate identities inside that root.
  const version = getSkillsResourceVersion(workspaceDir ?? "", options?.sourceScope);
  return await Promise.all(
    skills.map(async (skill) => {
      // Another producer's retained identity is trusted verbatim: worker
      // materialization, the session route, the transfer adapter, and library
      // pins stamp their own, and discovery never re-hashes a carried stamp —
      // except an explicit refresh after the resource version advanced, which
      // recomputes directory identities for the watcher-observed reload.
      // node:// locators have no bundle directory on this host: omit.
      if (skill.filePath.startsWith("node://")) {
        return skill;
      }
      const restamp = options?.recompute === true && skill.source !== "openclaw-library";
      if (skill.bundleFingerprint && !restamp) {
        return skill;
      }
      const reader = resolveSourceReader(skill);
      if (!reader) {
        // A refresh after the resource version advanced cannot verify the
        // carried stamp: omit it rather than keep a possibly stale identity.
        return restamp && skill.bundleFingerprint
          ? { ...skill, bundleFingerprint: undefined }
          : skill;
      }
      let caches = discoveredBundleIdentityCaches.get(reader);
      if (!caches) {
        caches = new Map();
        discoveredBundleIdentityCaches.set(reader, caches);
      }
      const key = `${path.resolve(skill.baseDir)}\u0000${version}`;
      let identity = caches.get(key);
      if (!identity) {
        identity = readDiscoveredBundleIdentity(skill, reader);
        caches.set(key, identity);
        pruneMapToMaxSize(caches, MAX_DISCOVERED_IDENTITY_CACHE_ENTRIES);
        // Do not pin a failed lookup: a later intake may legitimately retry.
        void identity.then((acquired) => {
          if (acquired === undefined) {
            caches?.delete(key);
          }
        });
      }
      const fingerprint = await identity;
      if (fingerprint === undefined) {
        // A refresh after the resource version advanced cannot re-verify a
        // carried stamp: the watcher already observed the change, so an
        // identity that cannot be recomputed omits rather than describe the
        // previous bundle. The failed lookup is never pinned; a later
        // intake retries at the same version.
        return restamp && skill.bundleFingerprint
          ? { ...skill, bundleFingerprint: undefined }
          : skill;
      }
      return skill.bundleFingerprint === fingerprint
        ? skill
        : { ...skill, bundleFingerprint: fingerprint };
    }),
  );
}

function matchesExplicitSelection(skill: Skill, selection: ExplicitSkillSelection): boolean {
  const selectionHost = resolveExplicitSkillSelectionFileHost(selection);
  return (
    skill.filePath === selection.path &&
    (selectionHost === undefined || resolveSkillFileHost(skill) === selectionHost)
  );
}

// The caller retains these bytes for its turn. Catalog versions do not version supporting files.
export async function prepareSkillResourceDelivery(
  inputSnapshot: SkillSnapshot | undefined,
  assertCurrent: () => void,
  inputExplicitSelections: readonly ExplicitSkillSelection[] = [],
  workspaceDir?: string,
): Promise<SkillResourceDelivery | undefined> {
  if (!inputSnapshot) {
    return undefined;
  }
  assertCurrent();
  if (
    !inputSnapshot.resolvedSkills?.length &&
    !inputSnapshot.discoverySkills?.length &&
    !inputSnapshot.librarySelections?.length &&
    !inputExplicitSelections.length
  ) {
    return undefined;
  }
  const library = captureSkillLibraryPreparation(
    inputSnapshot.librarySelections ?? [],
    assertCurrent,
  );
  const snapshot = {
    ...inputSnapshot,
    librarySelections: library.librarySelections,
    skills: inputSnapshot.skills.map((skill) => ({ ...skill })),
    resolvedSkills: inputSnapshot.resolvedSkills?.map((skill) => ({ ...skill })),
    skillRoots: inputSnapshot.skillRoots && { ...inputSnapshot.skillRoots },
  };
  const explicitSelections = inputExplicitSelections.map((selection) =>
    copyExplicitSkillSelectionFileHost(selection, { ...selection }),
  );
  // Library-only and node-native catalogs need no workspace filesystem access.
  let sourceReader: SkillResourceSourceReader | undefined;
  const getSourceReader = (skill?: Skill) => {
    if (skill && resolveSkillFileHost(skill) === "gateway") {
      return localSkillResourceReader;
    }
    if (!sourceReader) {
      const sourceWorkspace = snapshot.skillRoots?.agentWorkspaceDir ?? workspaceDir;
      const access = sourceWorkspace
        ? getAgentWorkspaceAccess(sourceWorkspace, "loadSkills")
        : undefined;
      if (access?.loadSkills && !access.skillResources) {
        throw new WorkspaceAccessUnavailableError(
          "Remote workspace skill resources are unavailable",
        );
      }
      sourceReader =
        (access?.loadSkills ? access.skillResources : undefined) ?? localSkillResourceReader;
    }
    return sourceReader;
  };
  const skills: SkillResourceDelivery["skills"] = [];
  let total = 0;
  const libraryOptions = { env: library.libraryContext?.environment };
  const libraryEntries = library.libraryContext
    ? await prepareSkillLibrarySelection(
        snapshot.librarySelections ?? [],
        libraryOptions,
        library.assertCurrent,
      )
    : [];
  library.assertCurrent();
  const candidates = resolveSkillResourceCandidates(snapshot, libraryEntries)!;
  for (const selected of explicitSelections) {
    if (
      selected.path.startsWith("node://") ||
      candidates.some((skill) => matchesExplicitSelection(skill, selected))
    ) {
      continue;
    }
    // Explicit references are host-resolved command paths, including eligible hidden skills.
    // Read only that directory; a resource turn must not repeat global skill discovery.
    const skillDir = path.dirname(selected.path);
    const selectedFileHost = resolveExplicitSkillSelectionFileHost(selected);
    const gatewayOwned = snapshot.skills.some((skill) => skill.gatewayFilePath === selected.path);
    let fileHost = selectedFileHost ?? (gatewayOwned ? "gateway" : undefined);
    if (!fileHost) {
      const sourceWorkspace = snapshot.skillRoots?.agentWorkspaceDir ?? workspaceDir;
      const hasRemoteWorkspace = sourceWorkspace
        ? Boolean(getAgentWorkspaceAccess(sourceWorkspace, "loadSkills")?.loadSkills)
        : false;
      fileHost = hasRemoteWorkspace ? "workspace" : "gateway";
    }
    let loaded: Skill | null;
    try {
      loaded = await (
        fileHost === "gateway" ? localSkillResourceReader : getSourceReader()
      ).resolveExplicitSkill(selected);
      if (loaded) {
        loaded = recordSkillFileHost({ ...loaded }, fileHost);
      }
    } catch (error) {
      throw contextualizeSkillResourceError({ name: selected.name, baseDir: skillDir }, error);
    }
    library.assertCurrent();
    if (
      !loaded ||
      loaded.filePath !== selected.path ||
      !snapshot.skills.some(
        (skill) =>
          skill.name === loaded.name &&
          (fileHost === "gateway"
            ? skill.gatewayFilePath === selected.path ||
              (selectedFileHost === undefined && skill.gatewayFilePath === undefined)
            : skill.gatewayFilePath === undefined),
      ) ||
      candidates.some((skill) => skill.name === loaded.name)
    ) {
      throw new Error(
        `Explicit skill no longer matches the prepared catalog: skill=${JSON.stringify(selected.name)} ` +
          `root=${JSON.stringify(skillDir)} path=${JSON.stringify(selected.path)}. ` +
          "Refresh skill selection and retry.",
      );
    }
    candidates.push(loaded);
  }
  const pins = [
    ...new Set(
      candidates.flatMap((skill) => {
        const pin =
          !skill.filePath.startsWith("node://") &&
          snapshot.librarySelections?.find((selection) => selection.name === skill.name);
        return pin ? [pin] : [];
      }),
    ),
  ];
  let manifests: Awaited<ReturnType<typeof readSkillLibrarySelectionManifests>>;
  for (const skill of candidates) {
    if (skill.filePath.startsWith("node://")) {
      continue;
    }
    const pin = snapshot.librarySelections?.find((selection) => selection.name === skill.name);
    const explicitlySelected = explicitSelections.some((selection) =>
      matchesExplicitSelection(skill, selection),
    );
    let files: SkillLibraryFile[] | null;
    try {
      if (pin) {
        library.assertCurrent();
        if (!manifests) {
          manifests = await readSkillLibrarySelectionManifests(pins, libraryOptions);
          library.assertCurrent();
        }
        const manifest = manifests?.[pins.indexOf(pin)];
        if (!manifest) {
          throw new SkillLibraryError("NOT_FOUND", "Selected skill revision is unavailable.");
        }
        files = await readSkillLibraryManifestTree(
          skillLibraryRevisionDir(pin.skillId, pin.revision, library.libraryContext?.environment),
          manifest.files_json,
          pin.revision,
        );
      } else {
        files = await getSourceReader(skill).readSkillFiles(skill, {
          allowMissingRoot: !explicitlySelected,
        });
      }
    } catch (error) {
      throw contextualizeSkillResourceError(skill, error);
    }
    library.assertCurrent();
    if (files === null) {
      if (explicitlySelected) {
        throw contextualizeSkillResourceError(
          skill,
          new Error("Explicit skill root is unavailable"),
        );
      }
      continue;
    }
    let bundle: ReturnType<typeof prepareSkillBundle>;
    try {
      bundle = prepareSkillBundle(files);
    } catch (error) {
      throw contextualizeSkillResourceError(skill, error);
    }
    total += bundle.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > SKILL_LIBRARY_MAX_BUNDLE_BYTES) {
      throw new SkillResourceDeliveryLimitError();
    }
    const sourcePath =
      resolveSkillFileHost(skill) === "workspace" &&
      candidates.some(
        (candidate) =>
          candidate !== skill &&
          candidate.filePath === skill.filePath &&
          resolveSkillFileHost(candidate) === "gateway",
      )
        ? resolveSkillReadPath(skill)
        : skill.filePath;
    skills.push({
      name: skill.name,
      sourcePath,
      modelVisible:
        (snapshot.resolvedSkills?.some((selected) => selected.filePath === skill.filePath) ??
          false) ||
        explicitlySelected,
      ...(skill.displayName ? { displayName: skill.displayName } : {}),
      description: skill.description,
      revision: bundle.revision,
      files,
    });
  }
  // Discovery is optional; prompted, explicit, and pinned resources keep their slots.
  const required = new Set(
    skills.filter(
      (skill) => skill.modelVisible || pins.some((selection) => selection.name === skill.name),
    ),
  );
  let discoverySlots = Math.max(0, SKILL_RESOURCE_MAX_SKILLS - required.size);
  const delivery = {
    version: 1 as const,
    skills: skills.filter((skill) => required.has(skill) || discoverySlots-- > 0),
  };
  if (!Value.Check(SkillResourceDeliverySchema, delivery)) {
    throw new Error("Selected skill catalog exceeds the worker resource contract.");
  }
  return delivery;
}

/** Owns private turn inputs independently of credential-bearing worker state. */
export async function materializeSkillResources(
  delivery: SkillResourceDelivery,
  assertCurrent: () => void,
  scope?: { sessionId: string; workspaceDir: string },
) {
  if (!Value.Check(SkillResourceDeliverySchema, delivery)) {
    throw new Error("Invalid skill resource delivery.");
  }
  const bundles = delivery.skills
    .map((skill) => ({ skill, bundle: prepareSkillBundle(skill.files) }))
    .toSorted((left, right) => {
      const a = JSON.stringify([left.skill.name, left.skill.sourcePath, left.bundle.revision]);
      const b = JSON.stringify([right.skill.name, right.skill.sourcePath, right.bundle.revision]);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (
    bundles.some(({ skill, bundle }) => skill.revision !== bundle.revision) ||
    bundles.reduce(
      (sum, { bundle }) => sum + bundle.files.reduce((bytes, file) => bytes + file.sizeBytes, 0),
      0,
    ) > SKILL_LIBRARY_MAX_BUNDLE_BYTES
  ) {
    throw new Error("Skill resource integrity or delivery limit check failed.");
  }
  assertCurrent();
  const directory = scope
    ? path.join(
        resolvePreferredOpenClawTmpDir(),
        `skill-resources-${sha256Hex(JSON.stringify([scope.sessionId, scope.workspaceDir])).slice(0, 16)}`,
      )
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-resources-"));
  // The lock covers deletion as well as use. Only a definitely dead process may
  // surrender a crashed turn's path; elapsed time never evicts a live reader.
  const lock = scope
    ? await acquireFileLock(directory, {
        retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
        stale: 0,
        staleRecovery: "remove-if-definitely-stale",
      })
    : undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      try {
        await removeTemporaryArtifacts(directory, "Materialized skill");
      } finally {
        await lock?.release();
      }
    })());
  try {
    if (scope) {
      assertCurrent();
      await fs.rm(directory, { recursive: true, force: true });
      assertCurrent();
      await fs.mkdir(directory, { mode: 0o700 });
    }
    const pathMappings: [source: string, target: string, name?: string][] = [];
    const resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]> = [];
    for (const { skill, bundle } of bundles) {
      const name = normalizeSkillIndexName(skill.name).slice(0, 40) || "skill";
      const baseDir = path.join(
        directory,
        `${name}-${sha256Hex(JSON.stringify([skill.name, skill.sourcePath, bundle.revision])).slice(0, 12)}`,
      );
      for (const file of bundle.files) {
        assertCurrent();
        const target = path.join(baseDir, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        assertCurrent();
        await fs.writeFile(target, file.bytes, {
          mode: file.executable ? 0o500 : 0o400,
          flag: "wx",
        });
      }
      const filePath = path.join(baseDir, "SKILL.md");
      const virtualPath = resolveSkillReadPath(
        { name: skill.name, filePath: skill.sourcePath ?? filePath },
        "workspace",
      );
      for (const source of skill.sourcePath ? [virtualPath, skill.sourcePath] : [virtualPath]) {
        pathMappings.push(
          [source, filePath, skill.name],
          [source.slice(0, -"SKILL.md".length), `${baseDir}${path.sep}`],
        );
      }
      resolvedSkills.push({
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        contentHash: bundle.revision,
        // Retained delivery identity consumed by skill.used telemetry; never a
        // freshness probe. It equals the supplied worker revision by integrity check.
        bundleFingerprint: bundle.revision,
        filePath,
        baseDir,
        source: "openclaw-resources",
        sourceInfo: createSyntheticSourceInfo(filePath, { source: "openclaw-resources", baseDir }),
        disableModelInvocation: skill.modelVisible === false,
      });
    }
    assertCurrent();
    const rewritePaths = (text: string) =>
      pathMappings.reduce(
        (rewritten, [source, target]) => rewritten.replaceAll(source, target),
        text,
      );
    return {
      directory,
      snapshot: {
        skills: resolvedSkills.map((skill) => ({ name: skill.name, skillKey: skill.name })),
        resolvedSkills,
        discoverySkills: resolvedSkills.filter((skill) => !skill.disableModelInvocation),
        prompt: formatSkillsForPromptBounded({
          skills: resolvedSkills.filter((skill) => !skill.disableModelInvocation),
          preserveOrder: true,
        }),
      },
      rewriteReferences: (text: string) => {
        let cursor = Math.max(0, text.indexOf("<available_skills>\n"));
        const parts = [rewritePaths(text.slice(0, cursor))];
        for (const { name, location } of parseSkillsPromptCatalog(text)) {
          const nameStart = text.indexOf(`<name>${escapeSkillXml(name)}</name>`, cursor);
          const tag = `<location>${escapeSkillXml(location)}</location>`;
          const start = nameStart < 0 ? -1 : text.indexOf(tag, nameStart);
          if (start < 0) {
            continue;
          }
          const named = pathMappings.filter((mapping) => mapping[2] === name);
          const exact = named.filter(([source]) => source === location);
          const candidates = exact.length ? exact : location.startsWith("~/") ? named : [];
          const targets = [...new Set(candidates.map(([, target]) => target))];
          const target = targets.length === 1 ? targets[0]! : location;
          // Catalog locations are XML and may be compact; other references retain raw path syntax.
          parts.push(
            rewritePaths(text.slice(cursor, start)),
            `<location>${escapeSkillXml(target)}</location>`,
          );
          cursor = start + tag.length;
        }
        parts.push(rewritePaths(text.slice(cursor)));
        return parts.join("");
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

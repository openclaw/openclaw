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
  type SkillResourceDelivery,
} from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import type { SkillDeliveredIdentityAcquirer } from "../../agents/agent-tools.read.js";
import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { isMissingPathError } from "../../infra/errors.js";
import { acquireFileLock } from "../../infra/file-lock.js";
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
import type {
  ExplicitSkillSelection,
  SkillEntry,
  SkillSnapshot,
  SkillResourceSourceReader,
} from "../types.js";
import { resolveSkillReadPath } from "../workspace-skill-read-path.js";
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
 * Stamps the retained bundle identity onto ordinary local entries at the
 * preparation boundary, and arms delivery-time identity acquisition for the
 * entries a live tree serves. Discovery entries (the skills_read and command
 * matcher input) carry the discovered bundle's identity, hashed once per
 * loaded bundle per preparation through its owning host reader; stamp caches
 * key by host identity (the reader object) and directory, so a Gateway skill
 * and a same-path workspace skill never share an identity and a remote path
 * absent on the Gateway is read through the workspace that owns it. The read
 * wrapper instead binds identity at delivery settlement for live entries: the
 * emitted fingerprint describes the bytes that delivery actually serves, each
 * fresh delivery generation acquires once, concurrent settlements coalesce,
 * and already-served re-reads never rehash. Pinned library revisions retain
 * their identified bytes, so their stamps hold at delivery. `node://` locators
 * and unreadable roots omit the field; telemetry-only acquisition never
 * weakens resource integrity, misattributes an identity, or fails the run.
 * Stamps copy entries instead of mutating them so caller-owned snapshots and
 * cached library pins stay untouched, and a restamped entry whose identity is
 * unchanged keeps the original object.
 */
export async function stampLocalSkillBundleIdentities(params: {
  snapshot: SkillSnapshot | undefined;
  libraryEntries: readonly SkillEntry[];
  /** Skills source workspace for host-aware reader selection. */
  workspaceDir?: string;
}): Promise<{
  snapshot: SkillSnapshot | undefined;
  libraryEntries: SkillEntry[];
  deliveredIdentityAcquirers: WeakMap<Skill, SkillDeliveredIdentityAcquirer>;
}> {
  const deliveredIdentityAcquirers = new WeakMap<Skill, SkillDeliveredIdentityAcquirer>();
  // Host-aware reader selection mirrors prepareSkillResourceDelivery: entries
  // owned by the Gateway read locally; every other entry reads through the
  // remote workspace's owning reader when that workspace owns skill loading.
  // Reader object identity doubles as host identity in the caches below, so
  // same-path cross-host bundles hash their own host's bytes.
  const sourceWorkspace = params.snapshot?.skillRoots?.agentWorkspaceDir ?? params.workspaceDir;
  let workspaceAccess: AgentWorkspaceAccess | undefined;
  let workspaceAccessUnavailable = false;
  if (sourceWorkspace) {
    try {
      workspaceAccess = getAgentWorkspaceAccess(sourceWorkspace, "loadSkills");
    } catch {
      // A stale workspace binding must never fail a run for telemetry: omit
      // non-Gateway identities instead of guessing which host owns the bytes.
      workspaceAccessUnavailable = true;
    }
  }
  // A pinned library revision's bytes live in the Gateway library store behind
  // the pin, never on a workspace host, so its owning reader is Gateway-local —
  // the same split the installed-skill catalog applies to pins.
  const isLibraryPin = (skill: Skill): boolean =>
    (params.snapshot?.librarySelections ?? []).some((selection) => selection.name === skill.name);
  const resolveSourceReader = (skill: Skill): SkillResourceSourceReader | undefined => {
    if (resolveSkillFileHost(skill) === "gateway" || isLibraryPin(skill)) {
      return localSkillResourceReader;
    }
    if (workspaceAccess?.loadSkills) {
      return workspaceAccess.skillResources;
    }
    return workspaceAccessUnavailable ? undefined : localSkillResourceReader;
  };
  const readBundleIdentity = async (
    skill: Skill,
    reader: SkillResourceSourceReader,
  ): Promise<string | undefined> => {
    try {
      const files = await reader.readSkillFiles(skill, { allowMissingRoot: true });
      return files ? prepareSkillBundle(files).revision : undefined;
    } catch {
      // Telemetry-only acquisition: omit rather than weaken resource integrity.
      return undefined;
    }
  };
  type BundleIdentityCaches = {
    /** Preparation-boundary discovery identities: one walk per bundle. */
    discovered: Map<string, Promise<string | undefined>>;
    /** In-flight delivery acquisitions; never cached across generations. */
    acquiring: Map<string, Promise<string | undefined>>;
  };
  const cachesByReader = new WeakMap<SkillResourceSourceReader, BundleIdentityCaches>();
  const resolveCaches = (reader: SkillResourceSourceReader): BundleIdentityCaches => {
    let caches = cachesByReader.get(reader);
    if (!caches) {
      caches = { discovered: new Map(), acquiring: new Map() };
      cachesByReader.set(reader, caches);
    }
    return caches;
  };
  const resolveDiscoveredIdentity = async (skill: Skill): Promise<string | undefined> => {
    if (skill.filePath.startsWith("node://")) {
      return undefined;
    }
    const reader = resolveSourceReader(skill);
    if (!reader) {
      return undefined;
    }
    const directory = path.resolve(skill.baseDir);
    const caches = resolveCaches(reader);
    let identity = caches.discovered.get(directory);
    if (!identity) {
      identity = readBundleIdentity(skill, reader);
      caches.discovered.set(directory, identity);
      // Do not pin a failed lookup: a later sibling may legitimately retry.
      void identity.then((revision) => {
        if (revision === undefined) {
          caches.discovered.delete(directory);
        }
      });
    }
    return identity;
  };
  const armDeliveredIdentityAcquirer = (skill: Skill): void => {
    if (skill.filePath.startsWith("node://")) {
      return;
    }
    deliveredIdentityAcquirers.set(skill, async () => {
      const reader = resolveSourceReader(skill);
      if (!reader) {
        return undefined;
      }
      const directory = path.resolve(skill.baseDir);
      const caches = resolveCaches(reader);
      const inFlight = caches.acquiring.get(directory);
      if (inFlight) {
        return inFlight;
      }
      // A fresh delivery generation describes the bytes this delivery serves;
      // results are never cached across generations so a delivery after an
      // epoch clear can never inherit an identity from before an edit.
      const acquisition = readBundleIdentity(skill, reader);
      caches.acquiring.set(directory, acquisition);
      void acquisition.then(() => caches.acquiring.delete(directory));
      return acquisition;
    });
  };
  // A pinned library revision retains its identified bytes behind the pin, so
  // its preparation stamp holds at delivery and no delivery acquisition runs;
  // every other entry acquires at delivery time.
  const isPinnedRevision = (skill: Skill): boolean => isLibraryPin(skill);
  const stampSkills = async (skills: readonly Skill[]): Promise<Skill[]> => {
    const stamped: Skill[] = [];
    for (const skill of skills) {
      // An entry-carried identity is the retained delivery field its producer
      // stamped: trust it instead of re-hashing the bundle behind it.
      const identity = skill.bundleFingerprint ?? (await resolveDiscoveredIdentity(skill));
      const stampedSkill =
        identity === undefined || skill.bundleFingerprint === identity
          ? skill
          : { ...skill, bundleFingerprint: identity };
      if (!isPinnedRevision(stampedSkill)) {
        armDeliveredIdentityAcquirer(stampedSkill);
      }
      stamped.push(stampedSkill);
    }
    return stamped;
  };
  const resolvedSkills = params.snapshot?.resolvedSkills;
  const discoverySkills = params.snapshot?.discoverySkills;
  const stampedResolved = resolvedSkills ? await stampSkills(resolvedSkills) : resolvedSkills;
  const stampedDiscovery = discoverySkills
    ? discoverySkills === resolvedSkills
      ? stampedResolved
      : await stampSkills(discoverySkills)
    : undefined;
  const stampedLibrary = await Promise.all(
    params.libraryEntries.map(async (entry) => {
      const identity =
        entry.skill.bundleFingerprint ?? (await resolveDiscoveredIdentity(entry.skill));
      if (identity === undefined || entry.skill.bundleFingerprint === identity) {
        if (!isPinnedRevision(entry.skill)) {
          armDeliveredIdentityAcquirer(entry.skill);
        }
        return entry;
      }
      const stampedSkill = { ...entry.skill, bundleFingerprint: identity };
      if (!isPinnedRevision(stampedSkill)) {
        armDeliveredIdentityAcquirer(stampedSkill);
      }
      return { ...entry, skill: stampedSkill };
    }),
  );
  const snapshot = params.snapshot
    ? stampedResolved !== resolvedSkills || stampedDiscovery !== discoverySkills
      ? {
          ...params.snapshot,
          ...(stampedResolved ? { resolvedSkills: stampedResolved } : {}),
          ...(stampedDiscovery ? { discoverySkills: stampedDiscovery } : {}),
        }
      : params.snapshot
    : undefined;
  return { snapshot, libraryEntries: stampedLibrary, deliveredIdentityAcquirers };
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
  const delivery = { version: 1 as const, skills };
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

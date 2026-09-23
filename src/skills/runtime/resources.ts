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
import {
  getAgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import { isMissingPathError } from "../../infra/errors.js";
import { removeTemporaryArtifacts } from "../../infra/temp-artifact-cleanup.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  prepareSkillBundle,
  readSkillBundleTree,
  readSkillLibraryManifestTree,
  skillLibraryRevisionDir,
  SkillTreeDirectoryError,
} from "../library/bundle.js";
import { SkillLibraryError } from "../library/errors.js";
import { readSkillLibrarySelectionManifests } from "../library/selection-read.js";
import {
  captureSkillLibrarySelection,
  prepareSkillLibrarySelection,
} from "../library/selection.js";
import { loadSingleSkillDirectory } from "../loading/local-loader.js";
import { createSyntheticSourceInfo, type Skill } from "../loading/skill-contract.js";
import { shouldSyncSkillPath } from "../loading/skill-paths.js";
import { formatSkillsForPromptBounded } from "../loading/skill-prompt-limits.js";
import type { ExplicitSkillSelection, SkillSnapshot, SkillResourceSourceReader } from "../types.js";
import { resolveSkillResourceCandidates } from "./resource-candidates.js";

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
  const snapshot = {
    ...inputSnapshot,
    librarySelections: captureSkillLibrarySelection(inputSnapshot.librarySelections ?? []),
    skills: inputSnapshot.skills.map((skill) => ({ ...skill })),
    resolvedSkills: inputSnapshot.resolvedSkills?.map((skill) => ({ ...skill })),
    skillRoots: inputSnapshot.skillRoots && { ...inputSnapshot.skillRoots },
  };
  const explicitSelections = inputExplicitSelections.map((selection) => ({ ...selection }));
  // Library-only and node-native catalogs need no workspace filesystem access.
  let sourceReader: SkillResourceSourceReader | undefined;
  const getSourceReader = (skill?: Skill) => {
    if (skill?.fileHost === "gateway") {
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
  const libraryContext = snapshot.librarySelections?.length
    ? captureOpenClawStateWorkerContext()
    : undefined;
  const assertLibraryCurrent = () => {
    assertCurrent();
    libraryContext?.maintenanceScope?.assertAdmission();
    libraryContext?.admission.assertCurrent();
  };
  const libraryOptions = { env: libraryContext?.environment };
  const libraryEntries = libraryContext
    ? await prepareSkillLibrarySelection(
        snapshot.librarySelections ?? [],
        libraryOptions,
        assertLibraryCurrent,
      )
    : [];
  assertLibraryCurrent();
  const candidates = resolveSkillResourceCandidates(snapshot, libraryEntries)!;
  for (const selected of explicitSelections) {
    if (
      selected.path.startsWith("node://") ||
      candidates.some((skill) => skill.filePath === selected.path)
    ) {
      continue;
    }
    // Explicit references are host-resolved command paths, including eligible hidden skills.
    // Read only that directory; a resource turn must not repeat global skill discovery.
    const skillDir = path.dirname(selected.path);
    const gatewayOwned = snapshot.skills.some((skill) => skill.gatewayFilePath === selected.path);
    let loaded: Skill | null;
    try {
      loaded = await (
        gatewayOwned ? localSkillResourceReader : getSourceReader()
      ).resolveExplicitSkill(selected);
      if (loaded) {
        loaded = { ...loaded, fileHost: gatewayOwned ? "gateway" : "workspace" };
      }
    } catch (error) {
      throw contextualizeSkillResourceError({ name: selected.name, baseDir: skillDir }, error);
    }
    assertLibraryCurrent();
    if (
      !loaded ||
      loaded.filePath !== selected.path ||
      !snapshot.skills.some((skill) => skill.name === loaded.name) ||
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
    const explicitlySelected = explicitSelections.some(
      (selection) => selection.path === skill.filePath,
    );
    let files: SkillLibraryFile[] | null;
    try {
      if (pin) {
        assertLibraryCurrent();
        if (!manifests) {
          manifests = await readSkillLibrarySelectionManifests(pins, libraryOptions);
          assertLibraryCurrent();
        }
        const manifest = manifests?.[pins.indexOf(pin)];
        if (!manifest) {
          throw new SkillLibraryError("NOT_FOUND", "Selected skill revision is unavailable.");
        }
        files = await readSkillLibraryManifestTree(
          skillLibraryRevisionDir(pin.skillId, pin.revision, libraryContext?.environment),
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
    assertLibraryCurrent();
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
      throw new Error(
        "Selected skill resources exceed the worker delivery limit (8 MiB). Select fewer skills before retrying.",
      );
    }
    skills.push({
      name: skill.name,
      sourcePath: skill.filePath,
      modelVisible:
        (snapshot.resolvedSkills?.some((selected) => selected.filePath === skill.filePath) ??
          false) ||
        explicitSelections.some((selected) => selected.path === skill.filePath),
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
): Promise<{
  directory: string;
  snapshot: SkillSnapshot;
  rewriteReferences: (text: string) => string;
  cleanup: () => Promise<void>;
}> {
  if (!Value.Check(SkillResourceDeliverySchema, delivery)) {
    throw new Error("Invalid skill resource delivery.");
  }
  const bundles = delivery.skills.map((skill) => ({
    skill,
    bundle: prepareSkillBundle(skill.files),
  }));
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-resources-"));
  const cleanup = () => removeTemporaryArtifacts(directory, "Materialized skill");
  try {
    const pathMappings: Array<[string, string]> = [];
    const resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]> = [];
    for (const [index, { skill, bundle }] of bundles.entries()) {
      const baseDir = path.join(directory, String(index));
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
      if (skill.sourcePath) {
        pathMappings.push([skill.sourcePath, filePath]);
        // Explicit supporting-file references share the same verified bundle root.
        pathMappings.push([skill.sourcePath.slice(0, -"SKILL.md".length), `${baseDir}${path.sep}`]);
      }
      resolvedSkills.push({
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        contentHash: bundle.revision,
        filePath,
        baseDir,
        source: "openclaw-resources",
        sourceInfo: createSyntheticSourceInfo(filePath, { source: "openclaw-resources", baseDir }),
        disableModelInvocation: skill.modelVisible === false,
      });
    }
    assertCurrent();
    return {
      directory,
      snapshot: {
        skills: resolvedSkills.map((skill) => ({ name: skill.name, skillKey: skill.name })),
        resolvedSkills,
        prompt: formatSkillsForPromptBounded({
          skills: resolvedSkills.filter((skill) => !skill.disableModelInvocation),
          preserveOrder: true,
        }),
      },
      rewriteReferences: (text) =>
        pathMappings.reduce(
          (rewritten, [source, target]) => rewritten.replaceAll(source, target),
          text,
        ),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

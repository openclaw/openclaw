import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_SELECTIONS,
  type SkillLibrarySelection,
  type SkillsLibraryActivateParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../../infra/boundary-file-read.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  parseSkillFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillManifestMetadata,
} from "../loading/frontmatter.js";
import { materializeSkill } from "../loading/skill-materializer.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillEntry } from "../types.js";
import { readSkillLibraryManifestTree, skillLibraryRevisionDir } from "./bundle.js";
import {
  readSkillLibrarySelectionDescriptions,
  readSkillLibrarySelectionManifests,
} from "./selection-read.js";
import { selectSkillLibraryRevisionMetadataBatch } from "./selection-read.kernel.js";
import { captureSkillLibraryAccess } from "./store-access.js";
import { readSkillLibraryStore, type SkillLibraryAuthority } from "./store.js";
const preparedSelections = new WeakMap<readonly SkillLibrarySelection[], () => void>();

/** Only uncommitted human seeds carry this closure. Persisted session pins intentionally do not. */
export function assertPreparedSkillLibrarySelection(
  selections?: readonly SkillLibrarySelection[],
): void {
  if (selections) {
    preparedSelections.get(selections)?.();
  }
}

function bindPreparedSelection(prepared: {
  value: SkillLibrarySelection[];
  assertCurrent: () => void;
}) {
  const pins = captureSkillLibrarySelection(prepared.value);
  preparedSelections.set(prepared.value, () => {
    prepared.assertCurrent();
    if (!isDeepStrictEqual(pins, prepared.value)) {
      throw new SkillLibraryError("CONFLICT", "Prepared skill selection changed. Retry.");
    }
  });
  return prepared.value;
}

const selectedEntryCache = new Map<string, SkillEntry[]>();

/** Async preparation retains pin values even when a caller later edits its snapshot. */
function captureSkillLibrarySelection(selections: readonly SkillLibrarySelection[]) {
  return selections.map(({ skillId, revision, name, ownerProfileId }) => ({
    skillId,
    revision,
    name,
    ownerProfileId,
  }));
}

export function captureSkillLibraryPreparation(
  selections: readonly SkillLibrarySelection[],
  assertCallerCurrent?: () => void,
) {
  const librarySelections = captureSkillLibrarySelection(selections);
  const libraryContext = librarySelections.length ? captureOpenClawStateWorkerContext() : undefined;
  return {
    librarySelections,
    libraryContext,
    assertCurrent: () => {
      assertCallerCurrent?.();
      libraryContext?.maintenanceScope?.assertAdmission();
      libraryContext?.admission.assertCurrent();
    },
  };
}

/** The session owner has already authorized this exact immutable pin. */
export async function readSelectedSkillLibraryFiles(
  selection: SkillLibrarySelection,
  options: OpenClawStateDatabaseOptions = {},
) {
  const directory = skillLibraryRevisionDir(selection.skillId, selection.revision, options.env);
  const metadata = (await readSkillLibrarySelectionManifests([selection], options))?.[0];
  if (!metadata) {
    throw new SkillLibraryError("NOT_FOUND", "Selected skill revision is unavailable.");
  }
  return await readSkillLibraryManifestTree(directory, metadata.files_json, selection.revision);
}

/** Called only by a fresh human-session admission, never from creator/assignee attribution. */
export async function seedSkillLibrarySelection(
  authority: SkillLibraryAuthority,
  options: OpenClawStateDatabaseOptions = {},
): Promise<SkillLibrarySelection[]> {
  if (!authority.profileId) {
    return [];
  }
  const prepared = await captureSkillLibraryAccess(authority, options).read("seed", undefined);
  return bindPreparedSelection(prepared);
}

/** Session mutation authorization is separate; retain library authority through its commit. */
export async function changeSkillLibrarySelection(
  authority: SkillLibraryAuthority,
  current: readonly SkillLibrarySelection[],
  params: SkillsLibraryActivateParams,
  options: OpenClawStateDatabaseOptions = {},
): Promise<SkillLibrarySelection[]> {
  if (params.action !== "refresh" && !params.skillId) {
    throw new SkillLibraryError("INVALID_BUNDLE", "attach/detach requires skillId.");
  }
  if (params.action === "detach") {
    authority.assertCurrent();
    return current.filter((item) => item.skillId !== params.skillId);
  }
  const prepared = await captureSkillLibraryAccess(authority, options).read("change", {
    current,
    params,
  });
  return bindPreparedSelection(prepared);
}

/** v2026.9.8 synchronous command discovery and harness createToolSurface SDK compatibility; runtime prepares pins asynchronously. */
export function loadSkillLibrarySelection(
  selections: readonly SkillLibrarySelection[],
  options: OpenClawStateDatabaseOptions = {},
): SkillEntry[] {
  if (!selections.length) {
    return [];
  }
  const cacheKey = JSON.stringify([resolveStateDir(options.env), options.path, selections]);
  const cached = selectedEntryCache.get(cacheKey);
  if (cached) {
    return [...cached];
  }
  if (selections.length > SKILL_LIBRARY_MAX_SELECTIONS) {
    throw new SkillLibraryError("LIMIT", "Invalid session skill selection.");
  }
  const entries = readSkillLibraryStore(
    (db) =>
      materializeSkillLibrarySelection(
        selections,
        selectSkillLibraryRevisionMetadataBatch(db, selections),
        options.env,
      ),
    options,
  );
  return cacheSkillLibrarySelection(cacheKey, entries);
}

/** Prepare immutable pins without borrowing a caller's synchronous database handle. */
export async function prepareSkillLibrarySelection(
  inputSelections: readonly SkillLibrarySelection[],
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
  assertCurrent: () => void,
): Promise<SkillEntry[]> {
  assertCurrent();
  if (!inputSelections.length) {
    return [];
  }
  const capturedOptions = {
    ...options,
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
  };
  const selections = captureSkillLibrarySelection(inputSelections);
  const cacheKey = JSON.stringify([
    resolveStateDir(capturedOptions.env),
    capturedOptions.path,
    selections,
  ]);
  const cached = selectedEntryCache.get(cacheKey);
  if (cached) {
    return [...cached];
  }
  if (selections.length > SKILL_LIBRARY_MAX_SELECTIONS) {
    throw new SkillLibraryError("LIMIT", "Invalid session skill selection.");
  }
  const revisions = await readSkillLibrarySelectionDescriptions(selections, capturedOptions);
  assertCurrent();
  return cacheSkillLibrarySelection(
    cacheKey,
    revisions && materializeSkillLibrarySelection(selections, revisions, capturedOptions.env),
  );
}

function materializeSkillLibrarySelection(
  selections: readonly SkillLibrarySelection[],
  revisions: ReturnType<typeof selectSkillLibraryRevisionMetadataBatch>,
  env: NodeJS.ProcessEnv | undefined,
): SkillEntry[] {
  return selections.map((selection, index) => {
    const revision = revisions[index];
    if (!revision) {
      throw new SkillLibraryError(
        "NOT_FOUND",
        "A pinned skill revision is unavailable; restore the library artifact or detach it explicitly.",
      );
    }
    const baseDir = skillLibraryRevisionDir(selection.skillId, selection.revision, env);
    const filePath = path.join(baseDir, "SKILL.md");
    const opened = openRootFileSync({
      absolutePath: filePath,
      rootPath: baseDir,
      boundaryLabel: "skill library revision",
      maxBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
      rejectHardlinks: true,
      symlinks: "reject",
    });
    if (!opened.ok) {
      throw new SkillLibraryError(
        "INVALID_BUNDLE",
        "Pinned skill instructions could not be read; restore the library artifact or detach it explicitly.",
        undefined,
        { cause: opened.error },
      );
    }
    let content: string;
    try {
      content = readFileDescriptorBoundedSync(opened.fd, SKILL_LIBRARY_MAX_FILE_BYTES).toString(
        "utf8",
      );
    } finally {
      fs.closeSync(opened.fd);
    }
    const frontmatter = parseSkillFrontmatter(content);
    const metadata = resolveSkillManifestMetadata(frontmatter);
    const invocation = resolveSkillInvocationPolicy(frontmatter);
    const name = selection.name;
    return {
      skill: materializeSkill({
        content,
        frontmatter,
        name,
        description: revision.description,
        baseDir,
        filePath,
        source: "openclaw-library",
        sourceOptions: { source: "openclaw-library" },
      }),
      frontmatter,
      invocation,
      // Untrusted frontmatter can constrain executable eligibility, but cannot claim global credentials/config.
      metadata: {
        skillKey: name,
        os: metadata?.os,
        requires: metadata?.requires,
      },
      disableCommandDispatch: true,
      syncSourceDir: baseDir,
      syncDirName: `library-${selection.skillId}-${selection.revision}`,
    } satisfies SkillEntry;
  });
}

function cacheSkillLibrarySelection(cacheKey: string, entries: SkillEntry[] | undefined) {
  if (!entries) {
    throw new SkillLibraryError(
      "NOT_FOUND",
      "Pinned skill library is unavailable; restore it before running this session.",
    );
  }
  selectedEntryCache.set(cacheKey, entries);
  if (selectedEntryCache.size > 32) {
    selectedEntryCache.delete(selectedEntryCache.keys().next().value!);
  }
  return [...entries];
}

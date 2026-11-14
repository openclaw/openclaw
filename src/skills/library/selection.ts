import { isDeepStrictEqual } from "node:util";
import {
  SKILL_LIBRARY_MAX_SELECTIONS,
  type SkillLibrarySelection,
  type SkillsLibraryActivateParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runSkillLibraryFilesystemTask } from "../runtime/refresh.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillEntry } from "../types.js";
import { readSkillLibraryManifestTree, skillLibraryRevisionDir } from "./bundle.js";
import { materializeSkillLibrarySelection } from "./filesystem.kernel.js";
import type { SkillLibraryReadQueries } from "./read.contract.js";
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

export type PreparedSkillLibrarySession = SkillLibraryReadQueries["session"]["output"] & {
  assertCurrent: () => void;
};

/** Human ingress consumes one snapshot for initial pins and authoring presentation. */
export async function prepareSkillLibrarySession(
  authority: SkillLibraryAuthority,
  options: OpenClawStateDatabaseOptions = {},
): Promise<PreparedSkillLibrarySession> {
  const prepared = await captureSkillLibraryAccess(authority, options).read("session", undefined);
  return {
    selections: bindPreparedSelection({
      value: prepared.value.selections,
      assertCurrent: prepared.assertCurrent,
    }),
    presentation: prepared.value.presentation,
    assertCurrent: prepared.assertCurrent,
  };
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
  const result =
    revisions &&
    (await runSkillLibraryFilesystemTask({
      kind: "selection",
      selections,
      revisions,
      stateDir: resolveStateDir(capturedOptions.env),
    }));
  assertCurrent();
  if (result && result.kind !== "selection") {
    throw new Error("Unexpected skill library selection response");
  }
  return cacheSkillLibrarySelection(cacheKey, result?.entries);
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

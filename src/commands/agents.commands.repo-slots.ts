import {
  describeRepoSlot,
  ensureRepoSlot,
  listRepoSlots,
  removeRepoSlot,
  resetRepoSlot,
} from "../agents/repo-slots.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { shortenHomePath } from "../utils.js";

export async function agentsRepoSlotsListCommand(
  opts: { json?: boolean },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const records = await listRepoSlots();
  if (opts.json) {
    writeRuntimeJson(runtime, records);
    return;
  }
  if (records.length === 0) {
    runtime.log("No isolated repo slots found.");
    return;
  }
  runtime.log(
    ["Isolated repo slots:", ...records.map((record) => `- ${describeRepoSlot(record)}`)].join(
      "\n",
    ),
  );
}

export async function agentsRepoSlotsEnsureCommand(
  opts: { repo?: string; slot: string; ref?: string; json?: boolean },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const repoPath = normalizeOptionalString(opts.repo) || process.cwd();
  const result = await ensureRepoSlot({ repoPath, slot: opts.slot, baseRef: opts.ref });
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(
    `${result.created ? "Prepared" : "Reused"} isolated slot ${result.record.slot} at ${shortenHomePath(result.record.workspaceDir)}`,
  );
}

export async function agentsRepoSlotsResetCommand(
  opts: { repo?: string; slot: string; ref?: string; fetch?: boolean; json?: boolean },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const repoPath = normalizeOptionalString(opts.repo) || process.cwd();
  const record = await resetRepoSlot({
    repoPath,
    slot: opts.slot,
    ref: opts.ref,
    fetch: opts.fetch,
  });
  if (opts.json) {
    writeRuntimeJson(runtime, record);
    return;
  }
  runtime.log(
    `Reset isolated slot ${record.slot} to ${record.baseRef ?? record.headSha ?? "HEAD"}.`,
  );
}

export async function agentsRepoSlotsRemoveCommand(
  opts: { repo?: string; slot: string; json?: boolean },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const repoPath = normalizeOptionalString(opts.repo) || process.cwd();
  const result = await removeRepoSlot({ repoPath, slot: opts.slot });
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(
    result.removed
      ? `Removed isolated slot ${opts.slot} at ${shortenHomePath(result.workspaceDir)}.`
      : `Isolated slot ${opts.slot} was already absent.`,
  );
}

export async function resolveWorkspaceDirForAgentRun(opts: {
  workspaceDir?: string;
  repo?: string;
  repoSlot?: string;
}): Promise<string | undefined> {
  const explicit = normalizeOptionalString(opts.workspaceDir);
  if (explicit) {
    return explicit;
  }
  const repoSlot = normalizeOptionalString(opts.repoSlot);
  if (!repoSlot) {
    return undefined;
  }
  const repoPath = normalizeOptionalString(opts.repo) || process.cwd();
  const ensured = await ensureRepoSlot({ repoPath, slot: repoSlot });
  return ensured.record.workspaceDir;
}

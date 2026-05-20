import type { SessionEntry } from "../../config/sessions/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

/**
 * Default max parent token count beyond which thread/session parent forking is skipped.
 * This prevents new thread sessions from inheriting near-full parent context.
 * See #26905.
 *
 * Bumped from the original 100k default to 1M to match modern frontier-model
 * context windows. Can be overridden via the OPENCLAW_PARENT_FORK_MAX_TOKENS
 * environment variable (set to 0 to disable the cap entirely).
 */
const DEFAULT_PARENT_FORK_MAX_TOKENS = 1_000_000;

function resolveParentForkMaxTokens(): number {
  const raw = process.env.OPENCLAW_PARENT_FORK_MAX_TOKENS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_PARENT_FORK_MAX_TOKENS;
}
const sessionForkRuntimeLoader = createLazyImportLoader(() => import("./session-fork.runtime.js"));

export type ParentForkDecision =
  | {
      status: "fork";
      maxTokens: number;
      parentTokens?: number;
    }
  | {
      status: "skip";
      reason: "parent-too-large";
      maxTokens: number;
      parentTokens: number;
      message: string;
    };

function loadSessionForkRuntime(): Promise<typeof import("./session-fork.runtime.js")> {
  return sessionForkRuntimeLoader.load();
}

function formatParentForkTooLargeMessage(params: {
  parentTokens: number;
  maxTokens: number;
}): string {
  return (
    `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); ` +
    "starting with isolated context instead."
  );
}

export async function resolveParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<ParentForkDecision> {
  const maxTokens = resolveParentForkMaxTokens();
  if (maxTokens === 0) {
    return { status: "fork", maxTokens };
  }
  const parentTokens = await resolveParentForkTokenCount({
    parentEntry: params.parentEntry,
    storePath: params.storePath,
  });
  if (typeof parentTokens === "number" && parentTokens > maxTokens) {
    return {
      status: "skip",
      reason: "parent-too-large",
      maxTokens,
      parentTokens,
      message: formatParentForkTooLargeMessage({ parentTokens, maxTokens }),
    };
  }
  return {
    status: "fork",
    maxTokens,
    ...(typeof parentTokens === "number" ? { parentTokens } : {}),
  };
}

export async function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): Promise<{ sessionId: string; sessionFile: string } | null> {
  const runtime = await loadSessionForkRuntime();
  return runtime.forkSessionFromParentRuntime(params);
}

async function resolveParentForkTokenCount(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  const runtime = await loadSessionForkRuntime();
  return runtime.resolveParentForkTokenCountRuntime(params);
}

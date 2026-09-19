import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHttpRequestAbortSignal } from "../../infra/http-request-lifecycle.js";
import type { HookAgentDispatchResult, HookAgentDispatchSuccess } from "../hooks.types.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";

type PendingHookReplay = {
  state: "pending";
  dispatch: Promise<HookAgentDispatchResult>;
  abortController?: AbortController;
  waiters: number;
};

type HookReplayEntry =
  | PendingHookReplay
  | { state: "active"; dispatch: HookAgentDispatchSuccess }
  | { state: "terminal"; ts: number; dispatch: HookAgentDispatchSuccess };

type HookReplayScope = {
  pathKey: string;
  token: string | undefined;
  idempotencyKey?: string;
  dispatchScope: Record<string, unknown>;
};

const hashReplay = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Owns HTTP hook replay identity, waiter cancellation, and completed-run retention. */
export function createHookRequestReplay() {
  const hookReplayCache = new Map<string, HookReplayEntry>();
  const pruneHookReplayCache = (now: number) => {
    for (const [key, entry] of hookReplayCache) {
      if (entry.state === "terminal" && entry.ts < now - DEDUPE_TTL_MS) {
        hookReplayCache.delete(key);
      }
    }
    const terminal = [...hookReplayCache].filter(([, entry]) => entry.state === "terminal");
    for (const [key] of terminal.slice(0, Math.max(0, terminal.length - DEDUPE_MAX))) {
      hookReplayCache.delete(key);
    }
  };

  const buildHookReplayCacheKey = (params: HookReplayScope): string | undefined => {
    const idem = params.idempotencyKey?.trim();
    if (!idem) {
      return undefined;
    }
    const scope = JSON.stringify({
      pathKey: params.pathKey,
      dispatchScope: params.dispatchScope,
    });
    return `${hashReplay(params.token ?? "")}:${hashReplay(scope)}:${hashReplay(idem)}`;
  };

  const resolveHookReplay = (key: string | undefined) => {
    if (!key) {
      return undefined;
    }
    pruneHookReplayCache(Date.now());
    const cached = hookReplayCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.state === "terminal") {
      hookReplayCache.delete(key);
      hookReplayCache.set(key, cached);
    }
    return cached;
  };

  const awaitHookReplay = async (
    replay: HookReplayEntry,
    key: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<HookAgentDispatchResult> => {
    if (replay.state !== "pending" || !replay.abortController) {
      return await replay.dispatch;
    }
    let attached = true;
    replay.waiters += 1;
    const detach = (disconnected: boolean) => {
      if (!attached) {
        return;
      }
      attached = false;
      replay.waiters -= 1;
      // Only the last disconnected waiter abandons pending admission. Retire its
      // identity before aborting so a same-key retry never joins doomed work.
      if (disconnected && replay.waiters === 0) {
        if (key && hookReplayCache.get(key) === replay) {
          hookReplayCache.delete(key);
        }
        replay.abortController?.abort(new Error("hook request disconnected"));
      }
    };
    const disconnect = () => detach(true);
    const request = createHttpRequestAbortSignal(req, res);
    request.signal.addEventListener("abort", disconnect, { once: true });
    if (request.signal.aborted) {
      disconnect();
    }
    try {
      return await replay.dispatch;
    } finally {
      request.signal.removeEventListener("abort", disconnect);
      request.cleanup();
      detach(false);
    }
  };

  const dispatchAgentHookWithReplay = (
    key: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
    dispatch: (
      abortSignal: AbortSignal,
    ) => HookAgentDispatchResult | Promise<HookAgentDispatchResult>,
    background = false,
  ): HookAgentDispatchResult | Promise<HookAgentDispatchResult> => {
    const existing = resolveHookReplay(key);
    if (existing) {
      return awaitHookReplay(existing, key, req, res);
    }
    // Fan-out work owns background admission across response deadlines and
    // producer retries, so it must not inherit the HTTP connection lifetime.
    const abortController = new AbortController();
    const pending = Promise.resolve()
      .then(() => dispatch(abortController.signal))
      .then((result) => {
        const current = key ? hookReplayCache.get(key) : undefined;
        if (key && current?.state === "pending" && current.dispatch === pending) {
          if (result.ok) {
            const active = { state: "active", dispatch: result } as const;
            hookReplayCache.set(key, active);
            const settle = () => {
              if (hookReplayCache.get(key) !== active) {
                return;
              }
              const terminal = { state: "terminal", ts: Date.now(), dispatch: result } as const;
              hookReplayCache.delete(key);
              hookReplayCache.set(key, terminal);
              pruneHookReplayCache(terminal.ts);
            };
            void result.completion.then(settle, settle);
          } else {
            hookReplayCache.delete(key);
          }
        }
        return result;
      })
      .catch((err: unknown) => {
        const current = key ? hookReplayCache.get(key) : undefined;
        if (key && current?.state === "pending" && current.dispatch === pending) {
          hookReplayCache.delete(key);
        }
        throw err;
      });
    const replay: PendingHookReplay = {
      state: "pending",
      dispatch: pending,
      abortController: background ? undefined : abortController,
      waiters: 0,
    };
    if (key) {
      hookReplayCache.set(key, replay);
    }
    return awaitHookReplay(replay, key, req, res);
  };

  return {
    buildHookReplayCacheKey,
    resolveHookReplay,
    awaitHookReplay,
    dispatchAgentHookWithReplay,
  };
}

import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { GetReplyOptions, VisibleWorkSession } from "../get-reply-options.types.js";

type VisibleWorkSessionReporter = {
  requesterSessionKey: string;
  report: NonNullable<GetReplyOptions["onVisibleWorkSessions"]>;
  active: boolean;
};

const reporters = resolveGlobalSingleton<AsyncLocalStorage<VisibleWorkSessionReporter | undefined>>(
  Symbol.for("openclaw.visibleWorkSessionReporter"),
  () => new AsyncLocalStorage<VisibleWorkSessionReporter | undefined>(),
);

/** Child runs start a fresh scope even when their caller has a channel reporter. */
export async function withVisibleWorkSessionReporter<T>(
  params: {
    requesterSessionKey?: string;
    report?: GetReplyOptions["onVisibleWorkSessions"];
  },
  run: () => Promise<T>,
): Promise<T> {
  const reporter =
    params.requesterSessionKey && params.report
      ? { requesterSessionKey: params.requesterSessionKey, report: params.report, active: true }
      : undefined;
  try {
    return await reporters.run(reporter, run);
  } finally {
    if (reporter) {
      reporter.active = false;
    }
  }
}

/** Await channel-owned initialization before a fresh visible child's first turn. */
export async function reportCreatedVisibleWorkSession(params: {
  requesterSessionKey: string;
  sessionKey: string;
  visibleSession?: Omit<VisibleWorkSession, "sessionKey">;
}): Promise<void> {
  const reporter = reporters.getStore();
  if (reporter?.active && reporter.requesterSessionKey === params.requesterSessionKey) {
    await reporter.report(
      params.visibleSession ? [{ sessionKey: params.sessionKey, ...params.visibleSession }] : [],
      { createdSessionKey: params.sessionKey },
    );
  }
}

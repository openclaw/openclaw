import fs from "node:fs";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import * as preparedReadRuntime from "./control-ui-session-pr-prepared-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";

type SubscriptionDeps = Parameters<typeof createControlUiSessionPullRequestSubscriptions>[0];
const nativeLoadSessionPullRequests = preparedReadRuntime.loadSessionPullRequests;
export type SessionPrLoader = typeof nativeLoadSessionPullRequests;

/** Lifetime-only fixtures retain a real physical source without opening a database. */
export function createTestSessionPrReadSource(
  registerCleanup: Parameters<typeof useAutoCleanupTempDirTracker>[0] = onTestFinished,
) {
  const tempDirs = useAutoCleanupTempDirTracker(registerCleanup);
  const sourcePath = path.join(tempDirs.make("session-pr-source-"), "source.sqlite");
  fs.writeFileSync(sourcePath, "");
  return { agentId: "main", path: sourcePath };
}

/** Replace repository I/O after native source admission, never the source authority. */
export function spyOnSessionPrLoader(load: SessionPrLoader = nativeLoadSessionPullRequests) {
  const loader = vi.spyOn(preparedReadRuntime, "loadSessionPullRequests").mockImplementation(load);
  onTestFinished(() => loader.mockRestore());
  return loader;
}

/** Resource-owner fixtures supply a stable visible target; access fixtures use the real reader. */
export function createTestControlUiSessionPrSubscriptions(
  options: Omit<SubscriptionDeps, "prepareRead"> &
    Partial<Pick<SubscriptionDeps, "prepareRead">> & {
      load?: SessionPrLoader;
    },
) {
  const { load, prepareRead: suppliedRead, ...deps } = options;
  spyOnSessionPrLoader(load);
  let prepareRead = suppliedRead;
  if (!prepareRead) {
    const readSource = createTestSessionPrReadSource();
    prepareRead = async (_connId, session) => {
      const parsed = parseAgentSessionKey(session.sessionKey);
      const agentId = session.agentId ?? parsed?.agentId ?? "main";
      const target = {
        params: { sessionKey: session.sessionKey, agentId },
        identity: JSON.stringify(session),
        readSource: { ...readSource, agentId },
        source: null,
      };
      return async () => target;
    };
  }
  return createControlUiSessionPullRequestSubscriptions({ ...deps, prepareRead });
}

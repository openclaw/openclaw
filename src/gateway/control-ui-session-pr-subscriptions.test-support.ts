import fs from "node:fs";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "./control-ui-contract.js";
import * as preparedReadRuntime from "./control-ui-session-pr-prepared-read.js";
import {
  createRepositorySessionReadHost,
  type RepositorySessionReads,
} from "./control-ui-session-pr-runtime.js";
import {
  guardRepositorySessionRead,
  prepareSelectedRepositorySessionRead,
} from "./control-ui-session-pr-source.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import {
  repositorySessionPrTarget,
  type ControlUiSessionPrTarget,
} from "./control-ui-session-pr-target.js";
import type {
  PreparedRepositorySessionRead,
  RepositorySessionObservation,
} from "./repository-session-read.types.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";

const nativeLoadSessionPullRequests = preparedReadRuntime.loadSessionPullRequests;
export type SessionPrLoader = typeof nativeLoadSessionPullRequests;

/** Resource-only tests still retain a real physical source; access suites use the actual service. */
export function createTestSessionPrReadSource(
  registerCleanup: Parameters<typeof useAutoCleanupTempDirTracker>[0] = onTestFinished,
) {
  const tempDirs = useAutoCleanupTempDirTracker(registerCleanup);
  const sourcePath = path.join(tempDirs.make("session-pr-source-"), "source.sqlite");
  fs.writeFileSync(sourcePath, "");
  return { agentId: "main", path: sourcePath };
}

export type TestSessionPrTarget = Partial<ControlUiSessionPrTarget> &
  Pick<ControlUiSessionPrTarget, "identity" | "params" | "source"> & {
    readSource?: { agentId: string; path: string };
  };

export function spyOnSessionPrLoader(load: SessionPrLoader = nativeLoadSessionPullRequests) {
  const loader = vi.spyOn(preparedReadRuntime, "loadSessionPullRequests").mockImplementation(load);
  onTestFinished(() => loader.mockRestore());
  return loader;
}

type Options = {
  scheduler: GatewayScheduler;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  isConnectionActive?: (connId: string) => boolean;
  prepareRead?: (
    connId: string,
    session: { sessionKey: string; agentId?: string },
  ) => Promise<(() => Promise<TestSessionPrTarget | undefined>) | undefined>;
  getSessionRowProjection?: () =>
    | import("./session-row-projection.js").SessionRowProjection
    | undefined;
  load?: SessionPrLoader;
  getConfig?: () => OpenClawConfig;
};

/** Union/lifetime fixtures inject only watcher admission; native physical-source retention is real. */
export function createTestControlUiSessionPrSubscriptions(options: Options) {
  const { scheduler, getConfig = () => ({}) } = options;
  if (options.load) {
    spyOnSessionPrLoader(options.load);
  }
  const sources = new WeakMap<RepositorySessionObservation, PreparedRepositorySessionRead>();
  const source = createTestSessionPrReadSource();
  const normalize = (input: TestSessionPrTarget, viewer = false): ControlUiSessionPrTarget => {
    if (
      input.read &&
      input.observation &&
      input.sessionId &&
      input.branchIdentity &&
      input.githubHost &&
      input.refreshIndex !== undefined &&
      input.includesTaskPublications !== undefined
    ) {
      sources.set(input.observation, input.read);
      return { ...repositorySessionPrTarget(input.read, getConfig(), input.read), ...input };
    }
    const { agentId, sessionKey } = input.params;
    const root = typeof input.source === "string" ? input.source : undefined;
    const selected = prepareSelectedRepositorySessionRead(
      {
        cfg: {},
        agentId,
        canonicalKey: sessionKey,
        storePath: (input.readSource ?? source).path,
        readSource: input.readSource ?? source,
        entry: {
          sessionId: input.sessionId ?? input.identity,
          updatedAt: 1,
          ...(root ? { spawnedCwd: root } : {}),
        },
      },
      null,
      { assertCurrent() {}, runSource: (run) => run() },
    );
    if (!selected) {
      throw new Error("Missing resource fixture source");
    }
    const admitted = viewer
      ? guardRepositorySessionRead(selected, {
          assertCurrent: input.assertCurrent ?? (() => {}),
          readTaskPublications: selected.readTaskPublications,
        })
      : selected;
    const prepared = {
      ...admitted,
      viewerProfileId: input.ownGitHubProfileId,
      ownGitHubIdentity: input.ownGitHubIdentity,
      boundPullRequest: input.githubPullRequest,
      identity: input.identity,
      branchIdentity: input.branchIdentity ?? input.identity,
      assertCurrent: input.assertCurrent ?? (() => {}),
    };
    sources.set(prepared, selected);
    const target = repositorySessionPrTarget(prepared, getConfig(), prepared);
    return {
      ...target,
      ...input,
      identity: target.identity,
      branchIdentity: target.branchIdentity,
      read: prepared,
      observation: prepared,
    };
  };
  const readChanges = createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig: getConfig,
    getSessionRowProjection: () => options.getSessionRowProjection?.(),
    getClient: () => undefined,
    resolveGatewayContext: () => undefined,
    broadcastToConnIds: options.broadcastToConnIds,
  }).bindService(scheduler.signal, () => scheduler.signal.throwIfAborted());
  const reads: RepositorySessionReads = {
    assertCurrent: () => scheduler.signal.throwIfAborted(),
    runDetached: (run) => run(),
    isViewerConnected: (connId) => options.isConnectionActive?.(connId) ?? true,
    invalidateViewer: (connId) =>
      options.broadcastToConnIds(
        "sessions.changed",
        { reason: "profile-identity" },
        new Set([connId]),
      ),
    publishReviewUpdates: (connIds, payload, session) =>
      options.broadcastToConnIds(
        CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
        payload,
        new Set(connIds),
        { sessionKeys: [session.sessionKey], agentId: session.agentId },
      ),
    createViewerRead(connId, session) {
      const selected = options.prepareRead
        ? options.prepareRead(connId, session)
        : Promise.resolve(async () => ({
            params: {
              ...session,
              agentId:
                session.agentId ?? parseAgentSessionKey(session.sessionKey)?.agentId ?? "main",
            },
            identity: JSON.stringify(session),
            source: null,
          }));
      return async () => {
        const read = await selected;
        const target = await read?.();
        return target ? normalize(target, true).read : undefined;
      };
    },
    prepareServiceRead: async () => undefined,
    withSource: async (observation, run) => {
      const selected = sources.get(observation);
      if (!selected) {
        throw new Error("Resource fixture source retired");
      }
      return await selected.withSource(run);
    },
    invalidate() {},
    subscribeChanges: (...args) => readChanges.subscribeChanges(...args),
    installPresentation: () => () => {},
  };
  const serviceScheduler = createPluginServiceScheduler(scheduler).scheduler;
  const subscriptions = createControlUiSessionPullRequestSubscriptions({
    reads,
    scheduler: serviceScheduler,
    getConfig,
  });
  return {
    ...subscriptions,
    read: (target: TestSessionPrTarget, assertCurrent: () => void, projection?: "publication") =>
      subscriptions.read(normalize(target), assertCurrent, projection),
    readPrepared: (target: TestSessionPrTarget, admitLoad?: () => boolean) =>
      subscriptions.readPrepared(normalize(target), admitLoad),
    async stop() {
      await subscriptions.stop();
      await serviceScheduler.stop();
    },
  };
}

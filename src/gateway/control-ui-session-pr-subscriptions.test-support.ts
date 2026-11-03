import fs from "node:fs";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "./control-ui-contract.js";
import {
  installSourceTransportProbe,
  type Load,
} from "./control-ui-session-pr-access.test-support.js";
import { createRepositorySessionReadHost } from "./control-ui-session-pr-runtime.js";
import { prepareSelectedRepositorySessionRead } from "./control-ui-session-pr-source.js";
import { startTestRepositorySessionPresentation } from "./github-account-service.test-support.js";
import type {
  PreparedRepositorySessionRead,
  RepositorySessionObservation,
  RepositorySessionIdentity,
  RepositorySessionSourceScope,
} from "./repository-session-read.types.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

/** Native authority tests retain an actual physical source; vendor cache units use plugin-local fakes. */
export function createTestSessionPrReadSource(
  registerCleanup: Parameters<typeof useAutoCleanupTempDirTracker>[0] = onTestFinished,
) {
  const dirs = useAutoCleanupTempDirTracker(registerCleanup);
  const sourcePath = path.join(dirs.make("session-pr-source-"), "source.sqlite");
  fs.writeFileSync(sourcePath, "");
  return { agentId: "main", path: sourcePath };
}

export function prepareTestSessionPrRead(input: {
  session: RepositorySessionIdentity;
  identity: string;
  readSource: ReturnType<typeof createTestSessionPrReadSource>;
  source?: RepositorySessionObservation["source"];
  assertCurrent?: () => void;
}): PreparedRepositorySessionRead {
  const assertCurrent = input.assertCurrent ?? (() => {});
  const selected = prepareSelectedRepositorySessionRead(
    {
      cfg: {},
      agentId: input.session.agentId,
      canonicalKey: input.session.sessionKey,
      storePath: input.readSource.path,
      readSource: input.readSource,
      entry: {
        sessionId: input.session.sessionId,
        updatedAt: 1,
        ...(input.source?.kind === "checkout" ? { spawnedCwd: input.source.root } : {}),
      },
    },
    null,
    { assertCurrent, runSource: (run) => run() },
  );
  if (!selected) {
    throw new Error("Missing native test source");
  }
  return {
    ...selected,
    session: input.session,
    source: input.source ?? null,
    identity: input.identity,
    branchIdentity: input.identity,
    assertCurrent,
  };
}

type Options = {
  scheduler: GatewayScheduler;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onPublication?: (
    payload: import("./control-ui-contract.js").ControlUiSessionPullRequestsChanged,
    session: { sessionKey: string; agentId: string },
  ) => void;
  isConnectionActive?: (connId: string) => boolean;
  prepareRead?: (
    connId: string,
    session: { sessionKey: string; agentId?: string },
  ) => Promise<(() => Promise<PreparedRepositorySessionRead | undefined>) | undefined>;
  getSessionRowProjection?: () =>
    | import("./session-row-projection.js").SessionRowProjection
    | undefined;
  readCheckoutFacts?: (
    observation: RepositorySessionObservation,
    native: RepositorySessionSourceScope,
    refresh?: boolean,
  ) => ReturnType<RepositorySessionSourceScope["readCheckoutFacts"]>;
  load?: Load;
  getConfig?: () => OpenClawConfig;
};

/** Compose real native change publication and source retention with the registered plugin service. */
export async function createTestControlUiSessionPrSubscriptions(options: Options) {
  const { scheduler, getConfig = () => ({}) } = options;
  const context = createContext([], getConfig);
  const source = createTestSessionPrReadSource();
  const selected = new WeakMap<RepositorySessionObservation, PreparedRepositorySessionRead>();
  context.resolveGatewayContext = () => context;
  const host = createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig: getConfig,
    getSessionRowProjection: () => options.getSessionRowProjection?.(),
    getClient: () => undefined,
    resolveGatewayContext: context.resolveGatewayContext,
    broadcastToConnIds: options.broadcastToConnIds,
  });
  context.repositorySessions = host;
  const bind = host.bindService.bind(host);
  const projectReads = (native: ReturnType<typeof bind>): ReturnType<typeof bind> => {
    return {
      ...native,
      isViewerConnected: (connId) => options.isConnectionActive?.(connId) ?? true,
      invalidateViewer: (connId) =>
        options.broadcastToConnIds(
          "sessions.changed",
          { reason: "profile-identity" },
          new Set([connId]),
        ),
      publishReviewUpdates: (connIds, payload, session) => {
        options.onPublication?.(payload, session);
        options.broadcastToConnIds(
          CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
          payload,
          new Set(connIds),
          { sessionKeys: [session.sessionKey], agentId: session.agentId },
        );
      },
      createViewerRead(connId, query) {
        const preparation = options.prepareRead
          ? options.prepareRead(connId, query)
          : Promise.resolve(async () =>
              prepareTestSessionPrRead({
                session: {
                  ...query,
                  agentId: query.agentId ?? "main",
                  sessionId: query.sessionKey,
                },
                identity: query.sessionKey,
                readSource: source,
              }),
            );
        return async () => {
          const read = await (await preparation)?.();
          if (read) {
            selected.set(read, read);
          }
          return read;
        };
      },
      prepareServiceRead: async () => undefined,
      withSource: async (observation, run) => {
        // Real row fixtures reacquire the source; synthetic physical-source tests retain their read.
        if (!options.load && options.getSessionRowProjection) {
          const readFacts = options.readCheckoutFacts;
          return await native.withSource(observation, (scope) =>
            run(
              readFacts
                ? {
                    ...scope,
                    readCheckoutFacts: (refresh) => readFacts(observation, scope, refresh),
                  }
                : scope,
            ),
          );
        }
        const read = selected.get(observation);
        if (!read) {
          throw new Error("Native fixture source retired");
        }
        return await read.withSource(run);
      },
    };
  };
  const stopProbe = options.load
    ? installSourceTransportProbe(host, options.load, scheduler.signal, projectReads)
    : undefined;
  if (!options.load) {
    vi.spyOn(host, "bindService").mockImplementation((...args) => projectReads(bind(...args)));
  }
  const service = await startTestRepositorySessionPresentation(context, scheduler, undefined, {
    cleanupOnFinish: false,
  });
  const presentation = host.presentation;
  if (!presentation) {
    throw new Error("Missing registered session presentation");
  }
  return {
    ...presentation,
    context,
    retainRead(read: PreparedRepositorySessionRead) {
      selected.set(read, read);
    },
    read(
      read: PreparedRepositorySessionRead,
      assertCurrent: () => void,
      projection?: "publication",
    ) {
      selected.set(read, read);
      return presentation.read(read, assertCurrent, projection);
    },
    async stop() {
      try {
        await service.stop({ strict: true });
      } finally {
        stopProbe?.();
        await scheduler.stop();
      }
    },
  };
}

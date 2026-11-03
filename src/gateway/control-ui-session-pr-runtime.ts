import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitMergedPullHead } from "../infra/git-read-operations.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequestsChanged,
  type ControlUiSessionPullRequestSnapshot,
} from "./control-ui-contract.js";
import { invalidatePrReader } from "./control-ui-session-pr-delivery.js";
import {
  withRepositoryInternalSessionRead,
  createRepositoryViewerRead,
} from "./control-ui-session-pr-read.js";
import { prepareSelectedRepositorySessionRead } from "./control-ui-session-pr-source.js";
import { createRepositoryTaskPublicationReader } from "./control-ui-session-task-prs.js";
import type {
  PreparedRepositorySessionRead,
  RepositorySessionObservation,
  RepositorySessionSourceScope,
} from "./repository-session-read.types.js";
import { createScheduledGatewayRunner } from "./scheduled-run-gateway-context.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestContext,
} from "./server-methods/types.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { ready, type MaterializedRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionVisibility } from "./session-sharing.js";

type RequestAdmission = Pick<
  GatewayRequestHandlerOptions,
  "client" | "signal" | "hasCurrentClientAuthority"
>;

type Query = { sessionKey: string; agentId: string };
export type RepositorySessionReadChange =
  | { kind: "reset" | "config" | "publications" }
  | {
      kind: "session";
      sessionKey: string;
      agentId?: string;
      removed: boolean;
      lineageChanged: boolean;
    };

/** The existing public review facts stay a wire contract, independent of the vendor service. */
export type RepositorySessionPresentation = {
  checks: (
    read: PreparedRepositorySessionRead,
    params: { owner: string; repo: string; number: number; headSha: string },
    assertCurrent: () => void,
  ) => Promise<import("./control-ui-contract.js").ControlUiSessionPullRequestCheckDetails>;
  readPrepared: (
    observation: RepositorySessionObservation,
    admitLoad?: () => boolean,
  ) => ControlUiSessionPullRequestSnapshot | undefined;
  read: (
    read: PreparedRepositorySessionRead,
    assertCurrent: () => void,
    projection?: "publication",
  ) => Promise<ControlUiSessionPullRequestSnapshot>;
  replace: (
    connId: string,
    sessionKeys: readonly string[],
    refresh?: ReadonlySet<string>,
    admitted?: () => void,
    passive?: ReadonlySet<string>,
  ) => Promise<void>;
  unsubscribe: (connId: string) => void;
  knownMergedHeads: (read: RepositorySessionObservation) => Promise<readonly GitMergedPullHead[]>;
  pollNow: () => Promise<void>;
  stop: () => Promise<void>;
};

/** Core retains prepared source/access owners; the installed plugin retains review data and transport. */
export function createRepositorySessionReadHost(deps: {
  signal: AbortSignal;
  getRuntimeConfig: () => OpenClawConfig;
  getSessionRowProjection: () => SessionRowProjection | undefined;
  getClient: (connId: string) => GatewayClient | undefined;
  resolveGatewayContext: () => GatewayRequestContext | undefined;
  broadcastToConnIds: import("./server-methods/types.js").GatewayBroadcastToConnIdsFn;
}) {
  let presentation: RepositorySessionPresentation | undefined;
  let requestRead:
    | (<T>(
        options: RequestAdmission,
        query: { sessionKey: string; agentId?: string; allowOwnImportedPullRequest?: boolean },
        operation: (read: PreparedRepositorySessionRead | undefined) => Promise<T>,
      ) => Promise<T>)
    | undefined;
  const runService = createScheduledGatewayRunner(deps.resolveGatewayContext);
  return {
    get presentation() {
      return deps.signal.aborted ? undefined : presentation;
    },
    async withRequestRead<T>(
      options: RequestAdmission,
      query: { sessionKey: string; agentId?: string; allowOwnImportedPullRequest?: boolean },
      operation: (read: PreparedRepositorySessionRead | undefined) => Promise<T>,
    ): Promise<T> {
      if (!requestRead || !presentation) {
        throw new Error("Repository session read service is unavailable");
      }
      return await requestRead(options, query, operation);
    },
    bindService(serviceSignal: AbortSignal, assertService: () => void) {
      const lifetime = AbortSignal.any([deps.signal, serviceSignal]);
      const assertCurrent = () => {
        lifetime.throwIfAborted();
        assertService();
      };
      assertCurrent();
      const spawnBroker = getSpawnBroker();
      const readTaskReceipts = createRepositoryTaskPublicationReader(lifetime);
      const prepareRecordRead = (projection: SessionRowProjection, record: MaterializedRow) => {
        const lookup = { key: record.key, agentId: record.agentId };
        const assertSelected = () => {
          assertCurrent();
          if (
            deps.getSessionRowProjection() !== projection ||
            projection.capture(lookup) !== record ||
            !projection.isCurrent(record)
          ) {
            throw new Error("Repository session target changed");
          }
        };
        return prepareSelectedRepositorySessionRead(
          {
            cfg: deps.getRuntimeConfig(),
            agentId: record.agentId,
            canonicalKey: record.key,
            storePath: record.storeTarget.storePath,
            readSource: { agentId: record.storeTarget.agentId, path: record.storeTarget.storePath },
            entry: record.entry,
          },
          record.materialized.row.repository ?? null,
          { assertCurrent: assertSelected, runSource: runService },
        );
      };
      const prepareServiceRead = (
        query: Query,
      ): Promise<PreparedRepositorySessionRead | undefined> =>
        runService(async () => {
          assertCurrent();
          const projection = deps.getSessionRowProjection();
          if (!projection || isIncognitoSessionKey(query.sessionKey)) {
            return undefined;
          }
          const lookup = { key: query.sessionKey, agentId: query.agentId };
          return await withReadySessionRows(
            projection,
            () => [lookup],
            (read) => {
              const record = read.describe(lookup);
              if (
                deps.getSessionRowProjection() !== projection ||
                !record ||
                record.entry.incognito ||
                resolveSessionVisibility(record.entry) === "draft"
              ) {
                return undefined;
              }
              return prepareRecordRead(projection, record);
            },
          );
        });
      const createRead = (
        client: GatewayClient,
        query: { sessionKey: string; agentId?: string; allowOwnImportedPullRequest?: boolean },
        isCurrentClient: () => boolean,
        signal = lifetime,
      ) =>
        createRepositoryViewerRead({
          client,
          ...query,
          ...deps,
          isCurrentClient,
          lifetime: signal,
          runSource: (run) => run(),
          readTaskReceipts,
        });
      const createRequestRead = (
        options: RequestAdmission,
        query: { sessionKey: string; agentId?: string; allowOwnImportedPullRequest?: boolean },
      ) => {
        assertCurrent();
        const client = options.client;
        return client
          ? createRead(
              client,
              query,
              () =>
                options.hasCurrentClientAuthority
                  ? options.hasCurrentClientAuthority()
                  : Boolean(client.connId && deps.getClient(client.connId) === client),
              options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime,
            )
          : undefined;
      };
      const bound = {
        assertCurrent,
        /** Background review work retains the service process owner, never request context. */
        runDetached<T>(run: () => T): T {
          assertCurrent();
          return runInDetachedAsyncContext(() => runWithSpawnBroker(spawnBroker, run));
        },
        isViewerConnected(connId: string) {
          assertCurrent();
          return Boolean(deps.getClient(connId));
        },
        publishReviewUpdates(
          connIds: ReadonlySet<string>,
          payload: ControlUiSessionPullRequestsChanged,
          session: Query,
        ) {
          assertCurrent();
          deps.broadcastToConnIds(
            CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
            payload,
            connIds,
            { sessionKeys: [session.sessionKey], agentId: session.agentId },
          );
        },
        prepareServiceRead,
        invalidateViewer(connId: string) {
          assertCurrent();
          invalidatePrReader(connId, deps.broadcastToConnIds);
        },
        createViewerRead(
          connId: string,
          query: { sessionKey: string; agentId?: string; allowOwnImportedPullRequest?: boolean },
        ) {
          assertCurrent();
          const client = deps.getClient(connId);
          return client
            ? createRead(client, query, () => deps.getClient(connId) === client)
            : undefined;
        },
        async withRequestRead<T>(
          this: void,
          options: RequestAdmission,
          query: { sessionKey: string; agentId?: string; allowOwnImportedPullRequest?: boolean },
          operation: (read: PreparedRepositorySessionRead | undefined) => Promise<T>,
        ): Promise<T> {
          assertCurrent();
          const assertRequest = () => {
            assertCurrent();
            options.signal?.throwIfAborted();
          };
          if (options.client) {
            const read = createRequestRead(options, query);
            const selected = await read?.();
            assertRequest();
            return await operation(selected);
          }
          return await withRepositoryInternalSessionRead(
            { getConfig: deps.getRuntimeConfig, query, assertCurrent: assertRequest },
            operation,
          );
        },
        async withSource<T>(
          observation: RepositorySessionObservation,
          operation: (scope: RepositorySessionSourceScope) => Promise<T>,
        ) {
          assertCurrent();
          // Watchers already prepared this projection. Reuse its exact row owner;
          // source acquisition must not reopen/re-read the session for every cache load.
          const projection = deps.getSessionRowProjection();
          const query = {
            key: observation.session.sessionKey,
            agentId: observation.session.agentId,
          };
          const record = projection?.capture(query);
          const current =
            projection &&
            ready(record) &&
            projection.isCurrent(record) &&
            !record.entry.incognito &&
            !isIncognitoSessionKey(record.key) &&
            resolveSessionVisibility(record.entry) !== "draft"
              ? prepareRecordRead(projection, record)
              : undefined;
          if (!current || current.branchIdentity !== observation.branchIdentity) {
            throw new Error("Repository source changed; retry the read");
          }
          return await current.withSource(operation);
        },
        invalidate(query: Query) {
          assertCurrent();
          sessionChanges.emit({ ...query, scope: "runtime" });
        },
        subscribeChanges(listener: (change: RepositorySessionReadChange) => void) {
          assertCurrent();
          const stopRows = sessionChanges.subscribeFacts((change) => {
            if (
              lifetime.aborted ||
              ("sessionKey" in change &&
                ((change.facts?.kind === "unchanged" && !change.factsInvalidated) ||
                  (change.scope === "runtime" && !change.facts && !change.factsInvalidated)))
            ) {
              return;
            }
            listener(
              "sessionKey" in change
                ? {
                    kind: "session",
                    sessionKey: change.sessionKey,
                    agentId: change.agentId,
                    removed: change.facts?.kind === "removed",
                    lineageChanged:
                      sessionChangeScopeAffectsStoredRows(change) &&
                      change.factsInvalidated !== "category" &&
                      (Boolean(change.factsInvalidated) ||
                        (change.facts?.kind !== "unchanged" &&
                          change.facts?.kind !== "participants" &&
                          change.facts?.kind !== "category")),
                  }
                : { kind: "config" },
            );
          });
          const stopReceipts = githubPublicationReceipts.subscribeFacts((change) => {
            if (!lifetime.aborted && (change.kind === "committed" || change.kind === "unknown")) {
              listener({ kind: "publications" });
            }
          });
          const stopDatabase = registerOpenClawStateDatabaseLifecycleListener((event) => {
            if (!lifetime.aborted && event.kind !== "opened") {
              listener({ kind: "reset" });
            }
          });
          const stop = () => {
            stopRows();
            stopReceipts();
            stopDatabase();
            lifetime.removeEventListener("abort", stop);
          };
          lifetime.addEventListener("abort", stop, { once: true });
          return stop;
        },
        installPresentation(provider: RepositorySessionPresentation) {
          assertCurrent();
          if (presentation) {
            throw new Error("A repository session presentation owner is already installed");
          }
          presentation = provider;
          requestRead = bound.withRequestRead;
          const remove = () => {
            if (presentation === provider) {
              presentation = undefined;
              requestRead = undefined;
            }
            lifetime.removeEventListener("abort", remove);
          };
          lifetime.addEventListener("abort", remove, { once: true });
          return remove;
        },
      };
      return bound;
    },
  };
}
export type RepositorySessionReadHost = ReturnType<typeof createRepositorySessionReadHost>;
export type RepositorySessionReads = Omit<
  ReturnType<RepositorySessionReadHost["bindService"]>,
  "withRequestRead"
>;

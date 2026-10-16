import { performance } from "node:perf_hooks";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { captureResidentUserProfileDisplaySnapshot } from "../state/user-profile-list.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import type { SessionListDiagnostics } from "./session-list-diagnostics.types.js";
import { resolveSessionListSearchModelIdentity } from "./session-list-filters.js";
import type {
  SessionListWorkerChange,
  SessionListWorkerRequest,
  SessionListWorkerResult,
  SessionListWorkerRow,
  SessionListWorkerUpdate,
} from "./session-list-worker.types.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import { identity, selectionRow, type SelectionRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { PreparedSessionRowRender } from "./session-row-render.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { prepareProjectedSessionList } from "./session-utils-list.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export type SessionListWorkerCommand =
  | { kind: "select"; update: SessionListWorkerUpdate; request: SessionListWorkerRequest }
  | {
      kind: "render";
      rows: PreparedSessionRowRender[];
      now: number;
      context: {
        subagentRuns: ReturnType<SessionListRowContext["subagentRuns"]["snapshot"]>;
        projectedAgentRuns: SessionListRowContext["projectedAgentRuns"];
        projectedSubagentActivity: SessionListRowContext["projectedSubagentActivity"];
      };
    };
export type SessionListWorkerReply =
  | { kind: "reset" }
  | { kind: "page"; page: SessionListWorkerResult }
  | { kind: "rows"; rows: { row: GatewaySessionRow; encoded: string }[] };

const owners = new WeakMap<SessionRowProjection, ReturnType<typeof createListWorker>>();
const transferableRow = ({ generation: _generation, ...row }: SelectionRow): SessionListWorkerRow =>
  row;

/** The projection's reset/disposal publication ends this derived worker's lifetime. */
function createListWorker(projection: SessionRowProjection) {
  let reset = true;
  let disposed = false;
  const changes = new Map<string, SessionListWorkerChange>();
  let previous: ReturnType<typeof projectionState> | undefined;
  const projectionState = () => ({
    ...projection.state,
    profilesRevision: readUserProfileVersion(),
    subagentRevision: projection.state.rowContext.subagentRuns.revision,
  });
  const pool = new WorkerTaskPool<SessionListWorkerCommand, SessionListWorkerReply>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("sessionList"),
    maxWorkers: 1,
    sharedCompute: true,
    idleTimeoutMs: 60_000,
  });
  const unsubscribe = projection.onSelectionChange((change) => {
    if (change.kind === "reset") {
      disposed = true;
      owners.delete(projection);
      unsubscribe();
      void pool.close().catch(() => {});
      return;
    }
    changes.set(change.id, {
      id: change.id,
      key: change.key,
      agentId: change.agentId,
      row: change.row && transferableRow(change.row),
    });
  });

  return {
    async render(
      rows: PreparedSessionRowRender[],
      rowContext: SessionListRowContext,
      now: number,
    ): Promise<{ row: GatewaySessionRow; encoded: string }[] | undefined> {
      if (rows.length === 0) {
        return [];
      }
      let reply: SessionListWorkerReply;
      try {
        reply = await pool.run(
          {
            kind: "render",
            rows,
            now,
            context: {
              subagentRuns: rowContext.subagentRuns.snapshot(),
              projectedAgentRuns: rowContext.projectedAgentRuns,
              projectedSubagentActivity: rowContext.projectedSubagentActivity,
            },
          },
          { signal: getAsyncWorkSignal(), timeoutMs: 30_000 },
        );
      } catch (error) {
        if (disposed) {
          return undefined;
        }
        throw error;
      }
      if (reply.kind !== "rows") {
        throw new Error("Unexpected session row worker reply");
      }
      return reply.rows;
    },
    async select(params: {
      opts: SessionsListParams;
      key?: string;
      context?: GatewayRequestContext;
      client?: GatewayClient | null;
      searchIdentities?: { names: ReadonlyMap<string, string> };
      diagnostics?: SessionListDiagnostics;
    }) {
      const { opts, key, context, client } = params;
      let captured: ReturnType<typeof capture>;
      function capture() {
        if (disposed) {
          throw new Error("Session list worker owner changed; retry the request");
        }
        const state = projectionState();
        const now = Date.now();
        const projectRun = context
          ? createVisibleActiveSessionRunProjector(context, state.rowContext.projectedAgentRuns)
          : undefined;
        const presentation = prepareSessionRowPublication(projection, now)(client, projectRun);
        const update: SessionListWorkerUpdate = {};
        if (reset) {
          update.reset = projection.selectEntries({ sortBy: null }, true).flatMap((row) => {
            const selected = selectionRow(row);
            return selected ? [transferableRow(selected)] : [];
          });
        } else {
          update.changes = [...changes.values()];
        }
        if (reset || previous?.cfg !== state.cfg) {
          update.cfg = state.cfg;
        }
        if (reset || previous?.profilesRevision !== state.profilesRevision) {
          update.profiles = captureResidentUserProfileDisplaySnapshot().displays;
        }
        if (
          reset ||
          previous?.subagentRevision !== state.subagentRevision ||
          previous?.rowContext.projectedAgentRuns !== state.rowContext.projectedAgentRuns
        ) {
          update.subagentRuns = state.rowContext.subagentRuns.snapshot();
        }
        if (
          reset ||
          previous?.rowContext.projectedAgentRuns !== state.rowContext.projectedAgentRuns
        ) {
          update.projectedAgentRuns = state.rowContext.projectedAgentRuns;
        }
        if (
          reset ||
          previous?.rowContext.projectedSubagentActivity !==
            state.rowContext.projectedSubagentActivity
        ) {
          update.projectedSubagentActivity = state.rowContext.projectedSubagentActivity;
        }
        const scope = state.scope(opts);
        const activeRuns: SessionListWorkerRequest["activeRuns"] = new Map(
          [...(projectRun?.candidateSessionIdsOrKeys() ?? [])].flatMap((sessionIdOrKey) =>
            projection
              .selectEntries({ agentId: scope.agentId, sessionIdOrKey, sortBy: null }, true)
              .map(
                (row) =>
                  [
                    identity(row),
                    presentation.active(row.key, row.entry, row.agentId) ?? { active: false },
                  ] as const,
              ),
          ),
        );
        let searchRows: SessionListWorkerRequest["searchRows"];
        if (opts.search?.trim()) {
          // Plugin-owned model policy is not transferable; prepare its display facts here.
          const { prepared, filters } = prepareProjectedSessionList({
            projection,
            opts,
            key,
            context,
            client,
            now,
            metadataPrepared: true,
          });
          searchRows = new Map(
            [...prepared.entries("all")].map(([rowKey]) => {
              const target = prepared.getTarget(rowKey)!;
              const { selectedModel, rowModelIdentity, thinkingProjection } =
                prepared.getModelFacts(rowKey);
              return [
                identity(target),
                {
                  modelFacts: { selectedModel, rowModelIdentity, thinkingProjection },
                  modelIdentity: resolveSessionListSearchModelIdentity(filters, rowKey),
                },
              ];
            }),
          );
        }
        const request: SessionListWorkerRequest = {
          opts,
          now,
          scopeId: JSON.stringify([scope.agentId, opts.configuredAgentsOnly === true]),
          scope,
          key,
          visibility: client === undefined ? { kind: "all" } : presentation.sharing.listVisibility,
          restrictProfileReferences: client !== undefined,
          actorId: gatewayClientSessionCreator(client ?? null)?.id,
          activeRuns,
          projectActiveRun: projectRun !== undefined,
          identityNames: params.searchIdentities?.names,
          searchRows,
          candidateRowIds:
            key === undefined && !opts.involvingProfileId && opts.spawnedBy
              ? new Set(
                  projection
                    .selectEntries(
                      {
                        agentId: scope.agentId,
                        parentSessionKey: opts.spawnedBy,
                        sortBy: null,
                      },
                      true,
                    )
                    .map(identity),
                )
              : undefined,
        };
        previous = state;
        reset = false;
        changes.clear();
        return {
          command: { kind: "select" as const, update, request },
          state,
          audience: presentation.sharing.cacheKey,
        };
      }
      for (;;) {
        let reply: SessionListWorkerReply;
        try {
          reply = await pool.run(
            () => {
              const started = performance.now();
              const cpu = params.diagnostics?.startSyncCpu();
              try {
                captured = capture();
                return captured.command;
              } finally {
                if (params.diagnostics) {
                  params.diagnostics.projection.prepareSyncMs += performance.now() - started;
                  params.diagnostics.finishSyncCpu("prepareThreadCpuMs", cpu);
                }
              }
            },
            { signal: getAsyncWorkSignal(), timeoutMs: 30_000 },
          );
        } catch (error) {
          reset = true;
          if (disposed) {
            return undefined;
          }
          throw error;
        }
        if (reply.kind === "reset") {
          // Idle retirement or a failed task discards worker-local derived state.
          reset = true;
          continue;
        }
        if (reply.kind !== "page") {
          throw new Error("Unexpected session list worker reply");
        }
        const { state, audience, command } = captured!;
        return {
          ...reply.page,
          render: (rows: PreparedSessionRowRender[], rowContext: SessionListRowContext) =>
            this.render(rows, rowContext, command.request.now),
          now: command.request.now,
          cfg: state.cfg,
          modelCatalog: state.modelCatalog,
          isCurrent(currentAudience: string) {
            if (disposed) {
              return false;
            }
            const current = projection.state;
            return (
              current.revision === state.revision &&
              current.cfg === state.cfg &&
              current.policyConfig === state.policyConfig &&
              current.rowContext.projectedAgentRuns === state.rowContext.projectedAgentRuns &&
              current.rowContext.projectedSubagentActivity ===
                state.rowContext.projectedSubagentActivity &&
              current.rowContext.subagentRuns.revision === state.subagentRevision &&
              readUserProfileVersion() === state.profilesRevision &&
              currentAudience === audience
            );
          },
        };
      }
    },
  };
}

export function selectSessionListPageInWorker(
  projection: SessionRowProjection,
  params: Parameters<ReturnType<typeof createListWorker>["select"]>[0],
) {
  let owner = owners.get(projection);
  if (!owner) {
    owner = createListWorker(projection);
    owners.set(projection, owner);
  }
  return owner.select(params);
}

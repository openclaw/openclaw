import type {
  ControlUiSessionOperation,
  ControlUiSessionOperationFactory,
  ControlUiSessionOperationBinding,
} from "../../../../src/plugin-sdk/control-ui-session-operation.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { isGatewayMethodAdvertised } from "../gateway-methods.ts";
import { listen } from "../reactive/listener.ts";
import {
  readSessionChangedEvent,
  reconcileSessionChanged,
  reconcileSessionHistory,
} from "./reconcile.ts";
import type { createSessionDeletions } from "./session-deletions.ts";
import { isUiGlobalSessionKey, resolveUiConversationIdentity } from "./session-key.ts";
import type { SessionConnectionOwner, SessionGateway } from "./session-types.ts";

const MAX_RETAINED_OPERATIONS = 32;

type Host = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  deletionState: (
    row: GatewaySessionRow,
  ) => ReturnType<ReturnType<typeof createSessionDeletions>["deletionState"]>;
};

function invocationRow(row: GatewaySessionRow): GatewaySessionRow {
  return {
    key: row.key,
    agentId: row.agentId,
    kind: row.kind,
    updatedAt: row.updatedAt,
    sessionId: row.sessionId,
    sharingRole: row.sharingRole,
    visibility: row.visibility,
    archived: row.archived,
    worktree: row.worktree,
    repositoryWorkspaceId: row.repositoryWorkspaceId,
    repository: row.repository,
  };
}

function authority(row: GatewaySessionRow): string {
  const workspace = row.repositoryWorkspaceId
    ? ["repository", row.repositoryWorkspaceId, row.repository?.branch]
    : ["worktree", row.worktree?.id, row.worktree?.branch, row.worktree?.repoRoot];
  return JSON.stringify([
    row.sessionId,
    row.sharingRole,
    row.visibility,
    row.archived === true,
    ...workspace,
  ]);
}
function identity(snapshot: SessionGateway["snapshot"], methods: readonly string[]): string {
  return JSON.stringify([
    snapshot.selfUser?.identity ?? null,
    snapshot.hello?.auth?.role,
    snapshot.hello?.auth?.scopes,
    methods.map((method) => isGatewayMethodAdvertised(snapshot, method)),
  ]);
}

/** Admitted operations outlive panes; acknowledgement, rejection or authority retirement releases them. */
export function createSessionRetainedOperations(host: Host) {
  const entries = new Map<string, Entry>();
  type Entry = {
    row: GatewaySessionRow;
    retained: boolean;
    operation: ControlUiSessionOperation<object>;
    routeKey: string;
    current: () => boolean;
    stop: () => void;
    onError: (error: unknown) => void;
  };
  const keyFor = (row: Pick<GatewaySessionRow, "key" | "agentId">, agentId?: string | null) => {
    const owner = resolveUiConversationIdentity(host.snapshot(), row.key, row.agentId ?? agentId);
    return `${owner.agentId ?? ""}\0${owner.sessionKey}`;
  };
  const retire = (key: string, entry: Entry) => {
    entries.delete(key);
    entry.stop();
    try {
      entry.operation.reset();
    } catch (error) {
      entry.onError(error);
    }
  };
  const releaseIdle = (key: string, entry: Entry) => {
    if (!entry.retained && !entry.operation.hasBindings && entries.get(key) === entry) {
      entries.delete(key);
      entry.stop();
    }
  };
  const reconcile = (
    apply: (row: GatewaySessionRow, key: string) => GatewaySessionRow | undefined,
  ) => {
    for (const [key, entry] of entries) {
      const next = apply(entry.row, entry.routeKey);
      if (!entry.current() || !next || authority(next) !== authority(entry.row)) {
        retire(key, entry);
      } else {
        entry.row = invocationRow(next);
      }
    }
  };
  const observePayload = (event: string, payload: unknown, routeKey?: string) => {
    for (const [key, entry] of entries) {
      if (entry.current() && (routeKey === undefined || entry.routeKey === routeKey)) {
        try {
          entry.operation.observeEvent?.(event, payload, entry.row);
        } catch (error) {
          retire(key, entry);
          entry.onError(error);
        }
      }
    }
  };
  const snapshotFor = (row: GatewaySessionRow): SessionsListResult => ({
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [row],
  });
  return {
    attach<TBinding extends object>(
      row: GatewaySessionRow,
      factory: ControlUiSessionOperationFactory<TBinding>,
      pluginId: string,
      lifecycle?: { signal: AbortSignal; onError: (error: unknown) => void },
    ): ControlUiSessionOperationBinding<TBinding> | null {
      const connection = host.connection.capture();
      if (
        !connection ||
        lifecycle?.signal.aborted ||
        factory.requiredMethods.some(
          (method) => isGatewayMethodAdvertised(host.snapshot(), method) === false,
        )
      ) {
        return null;
      }
      const route = resolveUiConversationIdentity(host.snapshot(), row.key, row.agentId);
      const routeKey = `${route.agentId ?? ""}\0${route.sessionKey}`;
      const key = `${pluginId}\0${factory.id}\0${routeKey}`;
      const owner = identity(host.snapshot(), factory.requiredMethods);
      let entry = entries.get(key);
      if (
        entry &&
        (!entry.current() ||
          authority(entry.row) !== authority(row) ||
          !factory.isOperation(entry.operation))
      ) {
        retire(key, entry);
        entry = undefined;
      }
      if (!entry) {
        const requestLifetime = new AbortController();
        let stopLifetime: (() => void) | undefined;
        // Pending deletion can roll back; only confirmed retirement discards custody.
        const current = () =>
          entry !== undefined &&
          entries.get(key) === entry &&
          !lifecycle?.signal.aborted &&
          host.connection.isCurrent(connection) &&
          identity(host.snapshot(), factory.requiredMethods) === owner &&
          host.deletionState(entry.row) !== "confirmed";
        const operation = factory.create({
          client: {
            request: async <T>(method: string, params?: Record<string, unknown>) => {
              if (!current()) {
                throw new Error("This session operation has ended.");
              }
              const result = await connection.client.request<T>(method, params, {
                signal: requestLifetime.signal,
                retainSentResultOnAbort: true,
              });
              if (!current()) {
                throw new Error("This session operation has ended.");
              }
              return result;
            },
          },
          target: route,
          isCurrent: current,
          reserve: () => {
            if (!entry || !current()) {
              throw new Error("This session operation has ended.");
            }
            if (entry.retained) {
              return;
            }
            if (
              [...entries.values()].filter((retainedEntry) => retainedEntry.retained).length >=
              MAX_RETAINED_OPERATIONS
            ) {
              throw factory.capacityError();
            }
            entry.retained = true;
          },
          release: () => {
            if (entry) {
              entry.retained = false;
              releaseIdle(key, entry);
            }
          },
          unbound: () => {
            if (entry) {
              releaseIdle(key, entry);
            }
          },
        });
        entry = {
          // Keep only invocation/authority facts, never a transcript or pane state.
          row: invocationRow({ ...row, key: route.sessionKey, agentId: route.agentId }),
          retained: false,
          routeKey,
          operation,
          stop: () => {
            stopLifetime?.();
            requestLifetime.abort();
          },
          onError:
            lifecycle?.onError ??
            ((error) => {
              throw error;
            }),
          current,
        };
        // Split panes share idle state too; only admitted operations survive the last detach.
        if (lifecycle?.signal.aborted || !host.connection.isCurrent(connection)) {
          operation.reset();
          return null;
        }
        entries.set(key, entry);
        if (lifecycle) {
          const created = entry;
          stopLifetime = listen(lifecycle.signal, "abort", () => retire(key, created), {
            once: true,
          });
        }
      }
      const operation = entry;
      if (!factory.isOperation(operation.operation)) {
        return null;
      }
      return Object.assign(operation.operation.bind(), {
        matches: (next: GatewaySessionRow) =>
          operation.current() &&
          !host.deletionState(next) &&
          keyFor(next) === operation.routeKey &&
          authority(next) === authority(operation.row),
      });
    },
    observeRows(rows: readonly GatewaySessionRow[], agentId?: string | null) {
      if (entries.size === 0) {
        return;
      }
      const incoming = new Map(rows.map((row) => [keyFor(row, agentId), row]));
      reconcile((row, key) => {
        const next = incoming.get(key);
        return next
          ? reconcileSessionHistory(
              snapshotFor(row),
              { ...next, key: row.key, agentId: row.agentId },
              undefined,
              { archivedFilter: "all", selectedGlobalAgentId: row.agentId },
            )?.sessions[0]
          : row;
      });
    },
    observeEvent(payload: unknown) {
      if (entries.size === 0) {
        return;
      }
      const event = readSessionChangedEvent(payload);
      // Global events without an agent cannot identify which admitted operation they affect.
      if (!event || (isUiGlobalSessionKey(event.key) && !event.agentId)) {
        return;
      }
      const key = keyFor({ key: event.key }, event.agentId);
      reconcile((row, retainedKey) =>
        retainedKey === key
          ? reconcileSessionChanged(snapshotFor(row), payload, {
              archivedFilter: "all",
              selectedGlobalAgentId: row.agentId,
            }).result?.sessions[0]
          : row,
      );
      observePayload("sessions.changed", payload, key);
    },
    observePayload,
    invalidate() {
      for (const entry of entries.values()) {
        if (entry.current()) {
          entry.operation.invalidate();
        }
      }
    },
    clear() {
      for (const [key, entry] of entries) {
        retire(key, entry);
      }
    },
  };
}

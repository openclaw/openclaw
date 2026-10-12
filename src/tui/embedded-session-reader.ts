import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { readSessionRuntimeOwnershipAsync } from "../agents/harness/session-runtime-ownership.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withReadySessionRows } from "../gateway/session-row-prepared-read.js";
import type * as records from "../gateway/session-row-projection-record.js";
import type { SessionRowProjection } from "../gateway/session-row-projection.js";
import { listProjectedSessions } from "../gateway/session-utils-list.js";
import { buildGatewaySessionRow } from "../gateway/session-utils-row.js";
import { createGatewaySessionEntryReader } from "../gateway/session-utils-store-lineage.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "../gateway/session-utils-store-worker.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TuiBackend } from "./tui-backend.js";

export function readEmbeddedHistorySessionInfo(
  projection: SessionRowProjection,
  target: records.Lookup,
  identity: Pick<Partial<SessionEntry>, "sessionId" | "lifecycleRevision">,
) {
  return withReadySessionRows(
    projection,
    () => [target],
    (read) => {
      const current = read.describe(target);
      return current &&
        current.entry.sessionId === identity.sessionId &&
        current.entry.lifecycleRevision === identity.lifecycleRevision
        ? read.present(current)
        : undefined;
    },
  );
}

export async function readEmbeddedPrivateHistorySessionInfo(
  selected: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
  entry: SessionEntry,
) {
  const { cfg, agentId, canonicalKey, storePath, store, readSource } = selected;
  const [acpMeta] = await readAcpSessionMetaForEntries({
    cfg,
    entries: [{ agentId, sessionKey: canonicalKey, entry }],
  });
  const runtimeOwnership = await readSessionRuntimeOwnershipAsync({
    config: cfg,
    agentId,
    sessionKey: canonicalKey,
    storePath: readSource?.path ?? storePath,
    sessionEntry: entry,
    readPreparedPreviousSessionId: () => entry.previousSessionId,
  });
  return buildGatewaySessionRow({
    cfg,
    storePath,
    store,
    key: canonicalKey,
    entry,
    preparedAcpMeta: acpMeta ?? null,
    preparedRuntimeOwnership: runtimeOwnership ?? null,
    agentId,
    modelSource: { entry, readSourceEntry: createGatewaySessionEntryReader(selected) },
    lightweightListRow: true,
  });
}

export function createEmbeddedSessionReader(lifecycle: {
  ready: () => Promise<void>;
  projection: () => Promise<SessionRowProjection> | undefined;
}): Pick<TuiBackend, "listSessions" | "describeSession"> {
  const read = async (opts: Parameters<TuiBackend["listSessions"]>[0], key?: string) => {
    await lifecycle.ready();
    const publication = lifecycle.projection();
    const projection = await publication;
    if (!projection || publication !== lifecycle.projection()) {
      throw new Error("Embedded session projection is unavailable");
    }
    const result = await listProjectedSessions({
      projection,
      opts: opts ?? {},
      ...(key !== undefined ? { key } : {}),
    });
    if (publication !== lifecycle.projection()) {
      throw new Error("Embedded session projection is unavailable");
    }
    return result;
  };

  return {
    listSessions: (opts) => read(opts),
    async describeSession(opts) {
      const selected = parseAgentSessionKey(opts.sessionKey);
      const result = await read(
        {
          agentId: opts.agentId ?? selected?.agentId,
          includeGlobal: opts.sessionKey === "global" || selected?.rest === "global",
          includeUnknown: opts.sessionKey === "unknown" || selected?.rest === "unknown",
          limit: 1,
        },
        opts.sessionKey,
      );
      return { session: result.sessions[0] ?? null, defaults: result.defaults };
    },
  };
}

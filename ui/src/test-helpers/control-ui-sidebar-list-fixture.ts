import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";

type TeamScaleSessionMutation = {
  upsert?: GatewaySessionRow[];
  removeKeys?: string[];
};

export type TeamScaleLiveEvent = {
  atMs: number;
  kind: string;
  event: string;
  payload: unknown;
  history?: { text?: string; message?: unknown };
  sessionMutation?: TeamScaleSessionMutation;
};

type TeamScaleSidebarListInventory = {
  rows: GatewaySessionRow[];
  viewerProfileId: string;
  now: number;
  defaults: SessionsListResult["defaults"];
  owners: SessionsListResult["owners"];
};
type TeamScaleSidebarRow = GatewaySessionRow & { updatedAt: number | null };
type TeamScaleSidebarListResult = SessionsListResult & { sessions: TeamScaleSidebarRow[] };

/** Owns the synthetic Gateway's changing membership; production code packs its wire rows. */
export function createTeamScaleSidebarListOwner(input: TeamScaleSidebarListInventory) {
  const admit = (row: GatewaySessionRow): TeamScaleSidebarRow =>
    Object.freeze({ ...row, updatedAt: row.updatedAt ?? null });
  const rows = new Map(input.rows.map((row) => [row.key, admit(row)]));
  const previous = new Map<string, { rows: TeamScaleSidebarRow[]; revision: string }>();
  const reads: Array<{
    params: Record<string, unknown>;
    changedRows: number;
    removed: number;
    rowsSent: number;
    totalRows: number;
    bytes: number;
    revision: string;
  }> = [];
  let revision = 0;
  let ts = input.now;
  const ownedBy = (row: GatewaySessionRow, profileId: string) =>
    row.owner?.actor.identity?.type === "profile" && row.owner.actor.identity.id === profileId;
  return {
    apply(mutation: TeamScaleSessionMutation | undefined) {
      for (const key of mutation?.removeKeys ?? []) {
        rows.delete(key);
      }
      for (const row of mutation?.upsert ?? []) {
        rows.set(row.key, admit(row));
        ts = Math.max(ts, row.snapshotAt ?? row.updatedAt ?? ts);
      }
    },
    list(params: Record<string, unknown>): {
      result: TeamScaleSidebarListResult;
      previousRows?: TeamScaleSidebarRow[];
    } {
      const { source: _source, ifRowsRevision: _ifRowsRevision, ...query } = params;
      const key = JSON.stringify(Object.entries(query).toSorted(([a], [b]) => a.localeCompare(b)));
      const eligible = [...rows.values()]
        .filter((row) => {
          if (query.agentId && row.agentId !== query.agentId) {
            return false;
          }
          if (query.ownerId && row.owner?.actor.id !== query.ownerId) {
            return false;
          }
          if (
            query.involvingMe === true &&
            (row.hiddenFromInvolvingMe === true ||
              (!ownedBy(row, input.viewerProfileId) &&
                !row.participants?.some(({ identity }) => identity.id === input.viewerProfileId)))
          ) {
            return false;
          }
          if (query.archived !== "all" && (row.archived === true) !== (query.archived === true)) {
            return false;
          }
          if (query.pinned !== undefined && (row.pinned === true) !== query.pinned) {
            return false;
          }
          if (query.hasBoard !== undefined && (row.hasBoard === true) !== query.hasBoard) {
            return false;
          }
          if (query.boardFace !== undefined && row.boardFace !== query.boardFace) {
            return false;
          }
          if (query.excludeDock !== false && row.isDock === true) {
            return false;
          }
          if (query.excludeSubagents && row.key.includes(":subagent:")) {
            return false;
          }
          if (query.excludeCron && row.key.includes(":cron:")) {
            return false;
          }
          if (query.includeGlobal === false && row.kind === "global") {
            return false;
          }
          if (query.includeUnknown === false && row.kind === "unknown") {
            return false;
          }
          if (
            typeof query.spawnedBy === "string" &&
            !row.childOwnerSessionKeys?.includes(query.spawnedBy)
          ) {
            return false;
          }
          return (
            typeof query.search !== "string" ||
            `${row.label} ${row.displayName}`.toLowerCase().includes(query.search.toLowerCase())
          );
        })
        .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.key.localeCompare(b.key));
      const offset = typeof query.offset === "number" ? query.offset : 0;
      const limit = typeof query.limit === "number" ? query.limit : 200;
      const shared = eligible.slice(offset, offset + limit);
      const owned =
        query.ownerFirst && offset === 0
          ? eligible
              .filter((row) => ownedBy(row, input.viewerProfileId))
              .slice(0, Math.min(limit, 60))
          : [];
      const ownerKeys = new Set(owned.map((row) => row.key));
      const selected = [...owned, ...shared.filter((row) => !ownerKeys.has(row.key))];
      const prior = previous.get(key);
      const unchanged =
        prior !== undefined &&
        prior.rows.length === selected.length &&
        selected.every((row, index) => row === prior.rows[index]);
      const rowsRevision = unchanged ? prior.revision : `team-scale-sidebar-${++revision}`;
      const priorRows = new Map(prior?.rows.map((row) => [row.key, row]));
      const selectedKeys = new Set(selected.map((row) => row.key));
      const ownerSessionCounts = new Map<
        string,
        { profileId: string; open: number; running: number }
      >();
      if (query.includeOwnerSessionCounts) {
        for (const row of rows.values()) {
          const identity = row.owner?.actor.identity;
          if (
            row.archived ||
            identity?.type !== "profile" ||
            (query.agentId && row.agentId !== query.agentId)
          ) {
            continue;
          }
          const counts = ownerSessionCounts.get(identity.id) ?? {
            profileId: identity.id,
            open: 0,
            running: 0,
          };
          counts.open++;
          counts.running += Number(row.hasActiveRun === true);
          ownerSessionCounts.set(identity.id, counts);
        }
      }
      const result: TeamScaleSidebarListResult = {
        ts,
        path: "",
        defaults: input.defaults,
        sessions: unchanged ? prior.rows : selected,
        count: selected.length,
        totalCount: eligible.length,
        offset,
        limitApplied: limit,
        hasMore: offset + shared.length < eligible.length,
        nextOffset: offset + shared.length < eligible.length ? offset + shared.length : null,
        owners: input.owners,
        ...(query.includeOwnerSessionCounts
          ? { ownerSessionCounts: [...ownerSessionCounts.values()] }
          : {}),
      };
      reads.push({
        params,
        changedRows: selected.filter((row) => priorRows.get(row.key) !== row).length,
        removed: [...priorRows.keys()].filter((rowKey) => !selectedKeys.has(rowKey)).length,
        rowsSent: result.sessions.length,
        totalRows: selected.length,
        bytes: new TextEncoder().encode(JSON.stringify(result)).byteLength,
        revision: rowsRevision,
      });
      previous.set(key, { rows: result.sessions, revision: rowsRevision });
      return { result, previousRows: prior?.rows };
    },
    recordWire(result: SessionsListResult) {
      const read = reads.at(-1);
      if (read) {
        read.rowsSent = result.sessions.length;
        read.bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
        read.revision = result.rowsRevision ?? read.revision;
      }
    },
    stats: () => reads,
  };
}

/** Applies membership churn to the existing 125-frame, 20-second live stream. */
export function prepareTeamScaleSidebarListChurn({
  sessions,
  people,
  liveEvents,
  selectedSessionKey,
  now,
}: {
  sessions: GatewaySessionRow[];
  people: ControlUiMockPresenceUser[];
  liveEvents: TeamScaleLiveEvent[];
  selectedSessionKey: string;
  now: number;
}): void {
  const working = new Map<string, GatewaySessionRow>(sessions.map((row) => [row.key, row]));
  const pendingCreatedKeys: string[] = [];
  const self = people[0]!;
  const other = people[1]!;
  const owner = (person: ControlUiMockPresenceUser) => ({
    actor: {
      type: "human" as const,
      id: person.id,
      identity: { type: "profile" as const, id: person.id },
      label: person.name,
    },
  });
  for (let index = 0; index < liveEvents.length; index++) {
    const ts = now + (index + 1) * 160;
    if (index > 2 && index % 5 !== 0) {
      const item = liveEvents[index]!;
      if (item.event === "sessions.changed") {
        const source = working.get(
          sessions[
            item.kind === "sessions.changed.visible"
              ? 0
              : item.kind === "sessions.changed.hidden-held"
                ? 160
                : 240
          ]!.key,
        )!;
        const row = {
          ...source,
          snapshotAt: ts,
          lastMessagePreview: `Synthetic live activity ${index + 1}`,
          ...(item.kind === "run-state.unrelated" ? { hasActiveRun: index % 2 === 0 } : {}),
        };
        working.set(row.key, row);
        liveEvents[index] = {
          ...item,
          payload: {
            sessionKey: row.key,
            sessionId: row.sessionId,
            agentId: "main",
            reason: "patch",
            ts,
            session: row,
            ancestorSessions: [],
          },
          sessionMutation: { upsert: [row] },
        };
      }
      continue;
    }
    const cycle = Math.floor(index / 5) % 7;
    let kind: string;
    let reason = "patch";
    let row: GatewaySessionRow | undefined;
    let ancestors: GatewaySessionRow[] = [];
    let sessionMutation: TeamScaleSessionMutation;
    if (index < 3) {
      kind = ["create.cron", "create.subagent", "create.other-user"][index]!;
      const source = sessions[241 + index]!;
      const key = `agent:main:${["cron", "subagent", "chat"][index]}:team-scale-created-${index}`;
      row = {
        ...source,
        key,
        sessionId: `team-scale-created-${index}`,
        label: `Synthetic ${kind}`,
        displayName: `Synthetic ${kind}`,
        createdAt: ts,
        updatedAt: ts,
        snapshotAt: ts,
        owner: owner(other),
        participants:
          index === 2 ? [{ identity: { type: "profile", id: self.id }, label: self.name }] : [],
        hiddenFromInvolvingMe: false,
        hasActiveRun: true,
        status: "running",
        activeRunIds: [`team-scale-created-run-${index}`],
        ...(index === 1
          ? { spawnedBy: selectedSessionKey, childOwnerSessionKeys: [selectedSessionKey] }
          : {}),
      };
      pendingCreatedKeys.push(key);
      if (index === 1) {
        const parent = working.get(selectedSessionKey)!;
        ancestors = [{ ...parent, snapshotAt: ts, childSessions: [key] }];
      }
      // A following run-start can supersede creation in the Gateway event coalescer.
      reason = "agent.run.started";
      sessionMutation = { upsert: [row, ...ancestors] };
    } else if (cycle === 0) {
      kind = "window.enter";
      const source = working.get(sessions[240 + Math.floor(index / 35)]!.key)!;
      row = { ...source, updatedAt: ts, snapshotAt: ts };
      sessionMutation = { upsert: [row] };
    } else if (cycle === 1) {
      kind = "owner.change";
      const source = working.get(sessions[5]!.key)!;
      row = {
        ...source,
        owner: owner(source.owner?.actor.id === self.id ? other : self),
        updatedAt: ts,
        snapshotAt: ts,
      };
      reason = "owner";
      sessionMutation = { upsert: [row] };
    } else if (cycle === 2 || cycle === 3) {
      kind = cycle === 2 ? "involving.leave" : "involving.enter";
      const source = working.get(sessions[12]!.key)!;
      row = {
        ...source,
        hiddenFromInvolvingMe: cycle === 2,
        updatedAt: ts,
        snapshotAt: ts,
      };
      reason = "involvement";
      sessionMutation = { upsert: [row] };
    } else if (cycle === 4) {
      kind = "window.exit";
      const source = working.get(sessions[15]!.key)!;
      row = { ...source, archived: source.archived !== true, updatedAt: ts, snapshotAt: ts };
      sessionMutation = { upsert: [row] };
    } else if (cycle === 5 && pendingCreatedKeys.length > 0) {
      kind = "session.delete";
      reason = "delete";
      row = working.get(pendingCreatedKeys.shift()!)!;
      const removedKey = row.key;
      sessionMutation = { removeKeys: [removedKey] };
      if (row.spawnedBy) {
        const parent = working.get(row.spawnedBy)!;
        sessionMutation.upsert = [
          {
            ...parent,
            snapshotAt: ts,
            childSessions: parent.childSessions?.filter((key) => key !== removedKey),
          },
        ];
      }
    } else {
      kind = "sharing.broad";
      reason = "sharing";
      const source = working.get(sessions[18]!.key)!;
      sessionMutation = {
        upsert: [
          {
            ...source,
            visibility: source.visibility === "read-only" ? "shared" : "read-only",
            updatedAt: ts,
            snapshotAt: ts,
          },
        ],
      };
    }
    for (const key of sessionMutation.removeKeys ?? []) {
      working.delete(key);
    }
    for (const updated of sessionMutation.upsert ?? []) {
      working.set(updated.key, updated);
    }
    liveEvents[index] = {
      atMs: (index + 1) * 160,
      kind,
      event: "sessions.changed",
      payload: row
        ? {
            reason,
            sessionKey: row.key,
            sessionId: row.sessionId,
            agentId: "main",
            ts,
            ...(reason === "delete" ? {} : { session: row, ancestorSessions: ancestors }),
          }
        : { reason, ts },
      sessionMutation,
    };
  }
}

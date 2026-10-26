import { sortCronJobs } from "../../../src/cron/service/list-page-sort.ts";
import type {
  CronCompactJob,
  CronJob,
  CronJobsListResult,
  GatewaySessionRow,
} from "../api/types.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import { prepareTeamScaleSessionOwnership } from "./control-ui-sidebar-list-fixture.ts";
import { compactCronJobFixture } from "./cron.ts";

export const TEAM_SCALE_COUNTS = {
  sessions: 300,
  firstPage: 200,
  pinned: 30,
  owners: 34,
  people: 120,
  agents: 6,
  plugins: 7,
  cronJobs: 120,
  childSessions: 54,
  cronSessions: 24,
  systemSessions: 12,
  transcriptMessages: 240,
  inlineWidgets: 12,
  catalogHosts: 6,
  catalogSessionsPerHost: 20,
  presenceEvents: 12,
} as const;

type TeamScaleSession = GatewaySessionRow & { updatedAt: number; sessionId: string };

export function createTeamScaleSessionInventory({
  now,
  people,
  counts,
  offRosterSession = false,
  sidebarPersistentChildren = false,
}: {
  now: number;
  offRosterSession?: boolean;
  sidebarPersistentChildren?: boolean;
  people: ControlUiMockPresenceUser[];
  counts: Record<
    "sessions" | "owners" | "pinned" | "childSessions" | "cronSessions" | "systemSessions",
    number
  >;
}) {
  const sessions: TeamScaleSession[] = Array.from({ length: counts.sessions }, (_, index) => {
    const pinned = index >= counts.sessions - counts.pinned;
    const owner = people[index % counts.owners]!;
    const running = index < 24;
    const uuidPrefix =
      offRosterSession && index === counts.sessions - counts.pinned ? "f00dcafe" : "00000000";
    const row: TeamScaleSession = {
      key:
        index === 0
          ? "agent:main:main"
          : `agent:main:${pinned ? "dashboard" : "chat"}:${uuidPrefix}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ...(index === 0 ? { isMain: true } : {}),
      sessionId: `team-session-${index + 1}`,
      childOwnerSessionKeys: [],
      agentId: "main",
      kind: "direct",
      label: pinned ? `Project dashboard ${index - 269}` : `Project discussion ${index + 1}`,
      displayName: pinned ? `Project dashboard ${index - 269}` : `Project discussion ${index + 1}`,
      updatedAt: now - index * 1_000,
      lastActivityAt: now - index * 1_000,
      derivedTitle: `Synthetic project ${index + 1}: implementation review and verification`,
      unread: index % 7 === 0,
      snoozedUntil: index >= 160 && index < 220 ? now + 3_600_000 + index * 60_000 : undefined,
      createdAt: now - 86_400_000 - index * 1_000,
      snapshotAt: now,
      participants: [{ identity: { type: "profile", id: owner.id }, label: owner.name }],
      hasActiveRun: running,
      status: running ? "running" : "done",
      model: "gpt-5-mini",
      modelProvider: "openai",
      thinkingLevel: "medium",
      thinkingLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      contextTokens: 200_000,
      totalTokens: 4_000 + index * 31,
      pinned,
      lastMessagePreview: `Synthetic project ${index + 1}: reviewed the implementation and recorded the next concrete step.`,
    };
    if (pinned) {
      Object.assign(row, { pinnedAt: now - index, hasBoard: true, boardFace: "dashboard" });
    }
    return row;
  });
  prepareTeamScaleSessionOwnership(sessions, people.slice(0, counts.owners));
  const pinnedRows = sessions.slice(-counts.pinned);
  const selectedSessionKey = pinnedRows[0]!.key;
  if (offRosterSession) {
    pinnedRows[0]!.pinned = false;
    delete pinnedRows[0]!.pinnedAt;
  }
  const pinnedKeys = pinnedRows.filter((row) => row.pinned).map((row) => row.key);
  const persistentParent = sidebarPersistentChildren ? sessions[5]! : undefined;
  if (persistentParent) {
    persistentParent.owner = sessions[0]!.owner;
    persistentParent.participants = [
      { identity: { type: "profile", id: people[0]!.id }, label: people[0]!.name },
    ];
  }
  for (const row of pinnedRows.slice(1, -1)) {
    if (!row.participants?.some((participant) => participant.identity.id === people[0]!.id)) {
      row.participants?.push({
        identity: { type: "profile", id: people[0]!.id },
        label: people[0]!.name,
      });
    }
  }
  for (
    let index = 0;
    index < counts.childSessions + counts.cronSessions + counts.systemSessions;
    index++
  ) {
    const child = index < counts.childSessions;
    const persistent = persistentParent !== undefined && index < 4;
    const cron = !child && index < counts.childSessions + counts.cronSessions;
    const kind = child ? "subagent" : cron ? "cron" : "system";
    const parent = persistent
      ? persistentParent.key
      : index < 18
        ? selectedSessionKey
        : "agent:main:main";
    const source = sessions[index % counts.sessions]!;
    sessions.push({
      ...source,
      key: persistent
        ? `agent:main:chat:00000000-0000-4000-8000-${String(9000 + index).padStart(12, "0")}`
        : `agent:main:${kind}:team-scale-${index + 1}`,
      isMain: false,
      sessionId: `team-${kind}-${index + 1}`,
      label: `Synthetic ${kind} ${index + 1}`,
      displayName: `Synthetic ${kind} ${index + 1}`,
      updatedAt: now - (counts.sessions + index) * 1_000,
      pinned: false,
      pinnedAt: undefined,
      hasBoard: false,
      boardFace: undefined,
      unread: false,
      snoozedUntil: undefined,
      ...(child
        ? { spawnedBy: parent, parentSessionKey: parent, childOwnerSessionKeys: [parent] }
        : {}),
      ...(!child && !cron ? { createdActor: { type: "system", id: "gateway" } } : {}),
      ...(persistent ? { owner: sessions[1]!.owner, participants: [] } : {}),
    });
  }
  for (const parent of [
    selectedSessionKey,
    "agent:main:main",
    ...(persistentParent ? [persistentParent.key] : []),
  ]) {
    const row = sessions.find((session) => session.key === parent);
    if (row) {
      row.childSessions = sessions
        .filter((session) => session.childOwnerSessionKeys?.includes(parent))
        .map((session) => session.key);
    }
  }
  return {
    sessions,
    pinnedRows,
    pinnedKeys,
    selectedSessionKey,
    sidebarPersistentChildren: persistentParent
      ? { parentKey: persistentParent.key, childKeys: persistentParent.childSessions! }
      : undefined,
  };
}

export function createTeamScaleCronInventory(
  count: number,
  now: number,
  selectedSessionKey: string,
) {
  const cronJobs = Array.from({ length: count }, (_, index) => {
    return {
      id: `team-cron-${index + 1}`,
      name: `Synthetic scheduled check ${index + 1}`,
      agentId: "main",
      sessionKey: index % 2 === 0 ? selectedSessionKey : "agent:main:main",
      enabled: index % 5 !== 0,
      createdAtMs: now - 86_400_000,
      updatedAtMs: now - index * 1_000,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: `Run synthetic scheduled verification ${index + 1}.` },
      state: {
        nextRunAtMs: now + (index + 1) * 60_000,
        lastRunAtMs: now - (index + 1) * 60_000,
        lastRunStatus: index % 11 === 0 ? "error" : index % 13 === 0 ? "skipped" : "ok",
        ...(index % 11 === 0 ? { lastError: "Synthetic verification failed." } : {}),
        ...(index % 17 === 0 ? { runningAtMs: now - 1_000 } : {}),
      },
    } as const;
  });
  const listCronJobs = (
    params: Record<string, unknown>,
  ): CronJobsListResult<CronJob | CronCompactJob> => {
    const rows = cronJobs.filter(
      (job) =>
        (!params.agentId || params.agentId === job.agentId) &&
        (!params.sessionKey || params.sessionKey === job.sessionKey) &&
        (params.enabled === "all" ||
          (params.enabled === "disabled"
            ? !job.enabled
            : params.enabled === "enabled"
              ? job.enabled
              : params.includeDisabled === true || job.enabled)),
    );
    sortCronJobs(
      rows,
      params.sortBy === "name" || params.sortBy === "updatedAtMs" ? params.sortBy : "nextRunAtMs",
      params.sortDir === "desc" ? "desc" : "asc",
    );
    const offset = typeof params.offset === "number" ? params.offset : 0;
    const limit = typeof params.limit === "number" ? params.limit : 50;
    const jobs = rows
      .slice(offset, offset + limit)
      .map((job) => (params.compact === true ? compactCronJobFixture(job) : job));
    const hasMore = offset + jobs.length < rows.length;
    return {
      jobs,
      snapshotRevision: "team-scale-cron-v1",
      total: rows.length,
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? offset + jobs.length : null,
    };
  };
  return { cronJobs, listCronJobs };
}

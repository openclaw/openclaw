import type {
  CronCompactJob,
  CronJob,
  CronJobsListResult,
  GatewaySessionRow,
} from "../api/types.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import { prepareTeamScaleSessionOwnership } from "./control-ui-sidebar-list-fixture.ts";

type TeamScaleSession = GatewaySessionRow & { updatedAt: number; sessionId: string };

/** Shared source rows for the browser fixture and its query owner. */
export function createTeamScaleSessionInventory({
  now,
  people,
  counts,
}: {
  now: number;
  people: ControlUiMockPresenceUser[];
  counts: {
    sessions: number;
    owners: number;
    pinned: number;
    childSessions: number;
    cronSessions: number;
    systemSessions: number;
  };
}) {
  // The selected agent owns a full 300-row roster; extra agent identities model
  // the switcher without silently reducing the selected agent's page pressure.
  const sessions: TeamScaleSession[] = Array.from({ length: counts.sessions }, (_, index) => {
    const pinned = index >= counts.sessions - counts.pinned;
    const owner = people[index % counts.owners]!;
    const running = index < 24;
    return {
      key:
        index === 0
          ? "agent:main:main"
          : `agent:main:${pinned ? "dashboard" : "chat"}:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ...(index === 0 ? { isMain: true } : {}),
      sessionId: `team-session-${index + 1}`,
      agentId: "main",
      kind: "direct",
      label: pinned ? `Project dashboard ${index - 269}` : `Project discussion ${index + 1}`,
      displayName: pinned ? `Project dashboard ${index - 269}` : `Project discussion ${index + 1}`,
      updatedAt: now - index * 1_000,
      createdAt: now - 86_400_000 - index * 1_000,
      snapshotAt: now,
      owner: { actor: { type: "human", id: owner.id, label: owner.name } },
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
      ...(pinned
        ? {
            pinnedAt: now - index,
            hasBoard: true,
            boardFace: "dashboard" as const,
          }
        : {}),
      lastMessagePreview: `Synthetic project ${index + 1}: reviewed the implementation and recorded the next concrete step.`,
    };
  });
  prepareTeamScaleSessionOwnership(sessions, people.slice(0, counts.owners));
  const pinnedRows = sessions.slice(-counts.pinned);
  const pinnedKeys = pinnedRows.map((row) => row.key);
  const selectedSessionKey = pinnedKeys[0]!;
  for (const [index, row] of pinnedRows.entries()) {
    if (index === 0 || index === pinnedRows.length - 1) {
      continue;
    }
    row.updatedAt = now - (100 + index) * 1_000;
    if (!row.participants?.some((participant) => participant.identity.id === people[0]!.id)) {
      row.participants?.push({
        identity: { type: "profile", id: people[0]!.id },
        label: people[0]!.name,
      });
    }
  }
  for (const [index, row] of sessions.entries()) {
    row.derivedTitle = `Synthetic project ${index + 1}: implementation review and verification`;
    row.lastActivityAt = row.updatedAt;
    row.unread = index % 7 === 0;
    if (index >= 160 && index < 220) {
      row.snoozedUntil = now + 3_600_000 + index * 60_000;
    }
  }
  for (
    let index = 0;
    index < counts.childSessions + counts.cronSessions + counts.systemSessions;
    index++
  ) {
    const child = index < counts.childSessions;
    const cron = !child && index < counts.childSessions + counts.cronSessions;
    const kind = child ? "subagent" : cron ? "cron" : "system";
    const parent = index < 18 ? selectedSessionKey : "agent:main:main";
    const source = sessions[index % counts.sessions]!;
    sessions.push({
      ...source,
      key: `agent:main:${kind}:team-scale-${index + 1}`,
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
    });
  }
  for (const parent of [selectedSessionKey, "agent:main:main"]) {
    const row = sessions.find((session) => session.key === parent);
    if (row) {
      row.childSessions = sessions
        .filter((session) => session.childOwnerSessionKeys?.includes(parent))
        .map((session) => session.key);
    }
  }
  return { sessions, pinnedRows, pinnedKeys, selectedSessionKey };
}

/** Definition and compact inventory views share the same synthetic scheduler state. */
export function createTeamScaleCronInventory({
  count,
  now,
  selectedSessionKey,
}: {
  count: number;
  now: number;
  selectedSessionKey: string;
}) {
  const cronJobs: CronJob[] = Array.from({ length: count }, (_, index) => ({
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
  }));
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
    const offset = typeof params.offset === "number" ? params.offset : 0;
    const limit = typeof params.limit === "number" ? params.limit : 50;
    const jobs = rows.slice(offset, offset + limit).map((job): CronJob | CronCompactJob => {
      if (params.compact !== true) {
        return job;
      }
      const compact: CronCompactJob = {
        id: job.id,
        name: job.name,
        agentId: job.agentId,
        enabled: job.enabled,
        updatedAtMs: job.updatedAtMs,
        scheduleKind: job.schedule.kind,
        nextRunAt: new Date(job.state.nextRunAtMs!).toISOString(),
        nextRunAtMs: job.state.nextRunAtMs!,
        lastRunAt: new Date(job.state.lastRunAtMs!).toISOString(),
        lastRunAtMs: job.state.lastRunAtMs!,
        lastRunStatus: job.state.lastRunStatus!,
        lastRunError: job.state.lastError ?? null,
      };
      if (job.schedule.kind === "every") {
        compact.schedule = job.schedule;
      }
      if (job.state.runningAtMs !== undefined) {
        compact.runningAtMs = job.state.runningAtMs;
      }
      return compact;
    });
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

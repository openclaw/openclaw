import type { Buffer } from "node:buffer";
import type {
  SessionCatalog,
  SessionsCatalogHostEvent,
} from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type {
  AgentsListResult,
  CronCompactJob,
  CronJob,
  CronJobsListResult,
  GatewaySessionRow,
  PresenceEntry,
} from "../api/types.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import type { BoardSnapshot } from "../lib/board/types.ts";
import { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";
import { defaultControlUiFeatureMethods } from "./control-ui-e2e-defaults.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import {
  createTeamScaleSessionEvents,
  createTeamScaleSidebarListOwner,
  prepareTeamScaleSessionOwnership,
  prepareTeamScaleSidebarListChurn,
  type TeamScaleLiveEvent,
} from "./control-ui-sidebar-list-fixture.ts";
import { createTeamScaleHistoryFixture } from "./control-ui-team-scale-history-fixture.ts";
import {
  createTeamScalePeople,
  TEAM_SCALE_SELF_INSTANCE_ID,
} from "./control-ui-team-scale-people.ts";

export { TEAM_SCALE_SELF_INSTANCE_ID };

const TEAM_SCALE_COUNTS = {
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

const TEAM_SCALE_CATALOG_PROGRESS_ID = "team-scale-progress";
const TEAM_SCALE_LIVE_RUN_ID = "team-scale-live-run";

type TeamScaleCatalogEvent = { event: "sessions.catalog.host"; payload: SessionsCatalogHostEvent };
type TeamScaleEvent = TeamScaleCatalogEvent | { event: "presence"; payload: PresencePayload };

type FixtureAsset = {
  body: string | Buffer;
  contentType: string;
  status?: number;
  delayMs?: number;
};
type TeamScaleSession = GatewaySessionRow & { updatedAt: number; sessionId: string };
type FixtureOptions = {
  baseUrl?: string;
  now?: number;
  /** Supply the real canvas sandbox fixture for browser/widget measurements. */
  sandboxUrl?: string;
  sandboxPort?: number;
  liveRun?: boolean;
  sidebarListChurn?: boolean;
  sidebarLiveChurn?: boolean;
  sessionEventChurn?: boolean;
  duplicateBootReads?: boolean;
  closedMenuMembers?: boolean;
  largeSnapshot?: boolean;
};

function widgetHtml(index: number) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team metric ${index + 1}</title>
<style>:root{color-scheme:dark light;font-family:system-ui}body{margin:0;padding:20px}h2{font-size:18px}progress{width:100%}</style></head>
<body><h2>Team metric ${index + 1}</h2><p>Synthetic completed work: ${60 + index}%</p>
<progress value="${60 + index}" max="100"></progress><p>All fixture systems are available.</p></body></html>`;
}

/** One deterministic inventory shared by browser benchmarks and focused UI proofs. */
export function createControlUiTeamScaleFixture(options: FixtureOptions = {}) {
  const counts = {
    ...TEAM_SCALE_COUNTS,
    transcriptMessages: options.largeSnapshot ? 1_100 : TEAM_SCALE_COUNTS.transcriptMessages,
  };
  const now = options.now ?? Date.now();
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:19626/";
  const agentNames = ["Harbor", "Forge", "Scout", "Atlas", "Cedar", "Beacon"];
  const agents: AgentsListResult = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: agentNames.map((name, index) => ({
      id: index === 0 ? "main" : name.toLowerCase(),
      name,
      identity: { name, emoji: ["⚓", "🔧", "🔭", "🗺️", "🌲", "💡"][index] },
    })),
  };
  const { people, profiles, avatarAssets, sharingMembers } = createTeamScalePeople(
    counts.people,
    now,
    {
      avatars: options.sidebarLiveChurn,
      sharing: options.closedMenuMembers,
    },
  );
  const assets = new Map<string, FixtureAsset>(avatarAssets);
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
  const duplicateReads = options.duplicateBootReads
    ? createTeamScaleDuplicateReadFixture(selectedSessionKey, now)
    : undefined;
  if (duplicateReads) {
    assets.set(duplicateReads.mediaPath, duplicateReads.asset);
  }
  pinnedRows[0]!.sharingRole = "admin";
  pinnedRows[0]!.visibility = "shared";
  if (duplicateReads) {
    pinnedRows[0]!.worktree = duplicateReads.worktree;
  }
  if (options.liveRun) {
    Object.assign(pinnedRows[0]!, {
      hasActiveRun: true,
      status: "running",
      activeRunIds: [TEAM_SCALE_LIVE_RUN_ID],
    });
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
  for (const [index, person] of people.entries()) {
    person.watchedSessions = [
      index < 8 ? selectedSessionKey : sessions[index === 119 ? 240 : index]!.key,
    ];
    if (options.sidebarLiveChurn && index >= 8 && index < 80) {
      person.watchedSessions = [
        sessions[Math.floor((index - 8) / 2)]!.key,
        pinnedRows[(index - 8) % pinnedRows.length]!.key,
      ];
    }
    if (options.sidebarLiveChurn) {
      assets.set(`/api/users/${person.id}/avatar`, {
        contentType: "image/svg+xml",
        body:
          index % 6 === 2
            ? "synthetic invalid image"
            : `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${(index * 37) % 360} 55% 45%)"/><text x="20" y="26" fill="white" text-anchor="middle" font-size="17">${index + 1}</text></svg>`,
        ...(index % 6 === 1 ? { status: 404 } : {}),
        ...(index % 6 === 3 ? { delayMs: 600 } : {}),
      });
    }
  }
  const sidebarListInput = {
    rows: sessions,
    viewerProfileId: people[0]!.id,
    now,
    defaults: { model: "gpt-5-mini", modelProvider: "openai", contextTokens: 200_000 },
    owners: people.slice(0, counts.owners).map((person) => ({
      type: "human" as const,
      id: person.id,
      identity: person.identity,
      label: person.name,
    })),
  };
  const sidebarLists = createTeamScaleSidebarListOwner(sidebarListInput);
  const list = (params: Record<string, unknown>) => sidebarLists.list(params).result;
  const cronJobs: CronJob[] = Array.from({ length: counts.cronJobs }, (_, index) => ({
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
    const jobs = rows.slice(offset, offset + limit).map((job): CronJob | CronCompactJob =>
      params.compact === true
        ? {
            id: job.id,
            name: job.name,
            agentId: job.agentId,
            enabled: job.enabled,
            updatedAtMs: job.updatedAtMs,
            scheduleKind: job.schedule.kind,
            ...(job.schedule.kind === "every" ? { schedule: job.schedule } : {}),
            nextRunAt: new Date(job.state.nextRunAtMs!).toISOString(),
            nextRunAtMs: job.state.nextRunAtMs!,
            lastRunAt: new Date(job.state.lastRunAtMs!).toISOString(),
            lastRunAtMs: job.state.lastRunAtMs!,
            lastRunStatus: job.state.lastRunStatus!,
            lastRunError: job.state.lastError ?? null,
            ...(job.state.runningAtMs !== undefined ? { runningAtMs: job.state.runningAtMs } : {}),
          }
        : job,
    );
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
  const { messageIds, historyMessages } = createTeamScaleHistoryFixture({
    messageCount: counts.transcriptMessages,
    inlineWidgets: counts.inlineWidgets,
    now,
    largeSnapshot: options.largeSnapshot,
    attachments: duplicateReads?.attachments,
  });
  const largeHistory = options.largeSnapshot
    ? {
        messages: historyMessages,
        sessionId: pinnedRows[0]!.sessionId,
        sessionInfo: pinnedRows[0]!,
        hasMore: false,
        totalMessages: counts.transcriptMessages,
        metadata: { models: [] },
      }
    : undefined;
  const catalogs: SessionCatalog[] = ["codex", "claude"].map((id, catalogIndex) => ({
    id,
    label: id === "codex" ? "Codex" : "Claude Code",
    capabilities: { continueSession: true, archive: true },
    hosts: Array.from({ length: 3 }, (_host, hostIndex) => ({
      hostId: `node:fixture-${catalogIndex * 3 + hostIndex + 1}`,
      label: `Fixture workstation ${catalogIndex * 3 + hostIndex + 1}`,
      kind: "node",
      connected: true,
      sessions: Array.from({ length: counts.catalogSessionsPerHost }, (_session, index) => ({
        threadId: `fixture-thread-${catalogIndex}-${hostIndex}-${index}`,
        name: `Synthetic code review ${hostIndex + 1}.${index + 1}`,
        cwd: `/workspace/project-${(index % 5) + 1}`,
        updatedAt: now - index * 1_000,
        status: "stored",
        archived: false,
        canContinue: true,
        canArchive: true,
      })),
    })),
  }));
  const presenceEntries: PresenceEntry[] = people.map((person) => ({
    instanceId: person.instanceId,
    mode: person.mode,
    platform: person.platform,
    deviceFamily: person.deviceFamily,
    ts: now,
    reason: "connect",
    onlineSince: person.onlineSince,
    lastActivityAt: person.lastActivityAt,
    lastInputSeconds: person.lastInputSeconds,
    user: {
      id: person.id,
      identity: person.identity,
      name: person.name,
      email: person.email,
      ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
    },
    watchedSessions: person.watchedSessions,
  }));
  const catalogEvents: TeamScaleCatalogEvent[] = catalogs.flatMap((catalog) =>
    catalog.hosts.map((host) => ({
      event: "sessions.catalog.host",
      payload: {
        progressId: TEAM_SCALE_CATALOG_PROGRESS_ID,
        agentId: "main",
        catalog: { ...catalog, hosts: [host] },
      },
    })),
  );
  const events: TeamScaleEvent[] = [];
  for (let index = 0; index < counts.presenceEvents; index++) {
    if (catalogEvents[index]) {
      events.push(catalogEvents[index]!);
    }
    events.push({
      event: "presence",
      payload: {
        presence: presenceEntries.map((entry, personIndex) =>
          Object.assign({}, entry, {
            ts: now + index + 1,
            lastInputSeconds: personIndex === index + 1 ? 0 : entry.lastInputSeconds,
          }),
        ),
      },
    });
  }
  const plugins = Array.from({ length: counts.plugins }, (_, index) => {
    const pluginId = `team-scale-${index + 1}`;
    const root = `/__openclaw__/plugins/control-ui/${pluginId}/fixture-v1/`;
    assets.set(`${root}index.js`, {
      contentType: "text/javascript",
      body: `export default {id:${JSON.stringify(pluginId)},activate(host){host.ui.registerPage({id:"overview",label:"Fixture plugin ${index + 1}",mount(container){container.textContent="Synthetic plugin ${index + 1}"}});host.ui.registerNavigation({id:"overview",label:"Fixture plugin ${index + 1}",page:{id:"overview"},icon:"chart"});}};`,
    });
    assets.set(`${root}index.css`, {
      contentType: "text/css",
      body: `.team-scale-plugin-${index + 1}{contain:content}`,
    });
    return {
      pluginId,
      name: `Fixture plugin ${index + 1}`,
      revision: "fixture-v1",
      entryUrl: `${root}index.js`,
      styles: [`${root}index.css`],
      uiCapabilities: ["page", "navigation"],
    };
  });
  const boardPath = `/__openclaw__/board/${encodeURIComponent(selectedSessionKey)}/team-overview/index.html`;
  assets.set(boardPath, { contentType: "text/html", body: widgetHtml(0) });
  const sandbox = { sandboxUrl: options.sandboxUrl, sandboxPort: options.sandboxPort };
  const board: BoardSnapshot = {
    sessionKey: selectedSessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Overview", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "team-overview",
        tabId: "main",
        title: "Team overview",
        contentKind: "html",
        sizeW: 12,
        sizeH: 8,
        position: 0,
        grantState: "none",
        revision: 1,
        frameUrl: new URL(`${boardPath}?bt=fixture-ticket`, baseUrl).href,
        viewTicket: "fixture-ticket",
        viewTicketTtlMs: 1_200_000,
        viewGeneration: "0123456789abcdef0123456789abcdef",
        ...sandbox,
      },
    ],
  };
  const sidebarEntries = [
    "route:agents-home",
    ...pinnedKeys.map((key) => `session:${key}`),
    ...plugins.map((plugin) => `plugin:${plugin.pluginId}/overview`),
  ];
  const scenario: ControlUiMockGatewayScenario = {
    awaitInitialRoster: false,
    authMethod: "trusted-proxy",
    authMode: "trusted-proxy",
    assistantAgentId: "main",
    assistantName: "Harbor",
    agentModel: "gpt-5-mini",
    sessionKey: selectedSessionKey,
    sessions,
    presenceUsers: people,
    historyMessages,
    sessionReactions: {
      [selectedSessionKey]: Object.fromEntries(
        messageIds.map((id) => [
          id,
          [{ emoji: "👍", count: 1, identities: [{ id: people[1]!.id, label: people[1]!.name! }] }],
        ]),
      ),
    },
    ...(options.liveRun
      ? {
          inFlightRun: {
            runId: TEAM_SCALE_LIVE_RUN_ID,
            text: "Synthetic streaming progress 0",
            startedAt: now,
            events: [],
          },
        }
      : {}),
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "sessions.list",
      "sessions.describe",
      "sessions.catalog.list",
      "agents.list",
      "agent.identity.get",
      "users.list",
      "users.prefs.get",
      "users.prefs.set",
      "plugins.controlUi.list",
      "plugins.controlUi.report",
      "board.get",
      "canvas.document.view",
      "progressCard.get",
      "cron.list",
      "cron.status",
      ...(duplicateReads?.featureMethods ?? []),
    ],
    methodResponses: {
      ...(sharingMembers
        ? { "session.members.listEvidence": { sessionKey: selectedSessionKey, ...sharingMembers } }
        : {}),
      "question.list": { questions: [] },
      ...(largeHistory ? { "chat.startup": largeHistory, "chat.history": largeHistory } : {}),
      ...duplicateReads?.methodResponses,
      "agents.list": agents,
      "agent.identity.get": {
        cases: agents.agents.map((agent) => ({
          match: { agentId: agent.id },
          response: {
            agentId: agent.id,
            name: agent.name,
            emoji: agent.identity?.emoji,
            avatar: "",
          },
        })),
      },
      "users.list": { profiles },
      "users.prefs.get": {
        status: "ok",
        entries: {
          "ui.railShortcuts": sidebarEntries,
        },
      },
      "users.prefs.set": { status: "ok" },
      "sessions.list": {
        cases: [
          ...["pinned", "hasBoard", "involvingMe"].map((flag) => ({
            match: { [flag]: true },
            response: list({
              [flag]: true,
              limit: counts.firstPage,
              includeDerivedTitles: true,
              includeLastMessage: true,
            }),
          })),
          ...[selectedSessionKey, "agent:main:main"].map((spawnedBy) => ({
            match: { spawnedBy },
            response: list({ spawnedBy, rowMode: "compact", limit: 10_000 }),
          })),
          {
            match: { includeOwnerSessionCounts: true },
            response: list({
              rowMode: "compact",
              limit: 1,
              excludeSubagents: true,
              excludeCron: true,
              excludeSystem: true,
              includeOwnerSessionCounts: true,
            }),
          },
          {
            match: { offset: counts.firstPage },
            response: list({
              offset: counts.firstPage,
              limit: counts.firstPage,
              includeDerivedTitles: true,
              includeLastMessage: true,
            }),
          },
          {
            match: {},
            response: list({
              limit: counts.firstPage,
              ownerFirst: true,
              includeDerivedTitles: true,
              includeLastMessage: true,
            }),
          },
        ],
      },
      "cron.status": {
        enabled: true,
        triggersEnabled: true,
        jobs: cronJobs.length,
        nextWakeAtMs: now + 60_000,
      },
      "cron.list": {
        cases: [0, 50, 100].map((offset) => ({
          match: { offset },
          response: listCronJobs({ offset, limit: 50, includeDisabled: true, compact: true }),
        })),
      },
      "sessions.catalog.list": {
        catalogs: catalogs.map((catalog) =>
          Object.assign({}, catalog, {
            hosts: catalog.hosts.map((host) =>
              Object.assign({}, host, { sessions: [], pending: true }),
            ),
          }),
        ),
      },
      "plugins.controlUi.list": { revision: "team-scale-v1", diagnostics: [], plugins },
      "plugins.controlUi.report": { ok: true },
      "board.get": board,
      "canvas.document.view": {
        cases: Array.from({ length: counts.inlineWidgets }, (_, index) => ({
          match: { docId: `team-scale-chart-${index + 1}` },
          response: { html: widgetHtml(index), ...sandbox },
        })),
      },
      "progressCard.get": {
        card: {
          sessionKey: selectedSessionKey,
          revision: 1,
          updatedAt: now,
          markdown: "Synthetic project verification is in progress.",
          steps: [
            { step: "Review fixture inventory", status: "completed" },
            { step: "Validate cold-load rendering", status: "in_progress" },
            { step: "Record performance evidence", status: "pending" },
          ],
        },
      },
    },
  };
  // 125 frames over 20 seconds: streaming is mixed with unrelated Team activity.
  const liveKinds = [
    ...Array<string>(5).fill("presence.offscreen"),
    ...Array<string>(2).fill("presence.visible"),
    ...Array<string>(2).fill("sessions.changed.visible"),
    ...Array<string>(2).fill("sessions.changed.hidden-held"),
    ...Array<string>(2).fill("sessions.changed.outside-window"),
    ...Array<string>(2).fill("session.message.open"),
    ...Array<string>(5).fill("chat.delta.open"),
    ...Array<string>(2).fill("catalog.host"),
    "cron.unrelated",
    ...Array<string>(2).fill("run-state.unrelated"),
  ];
  const livePresence = presenceEntries.map((entry) => Object.assign({}, entry));
  const liveEvents: TeamScaleLiveEvent[] = Array.from({ length: 125 }, (_, index) => {
    const kind = liveKinds[index % liveKinds.length]!;
    const ts = now + (index + 1) * 160;
    const runId = TEAM_SCALE_LIVE_RUN_ID;
    let event: string;
    let payload: unknown;
    let history: TeamScaleLiveEvent["history"];
    if (kind.startsWith("presence.")) {
      event = "presence";
      const target = kind === "presence.visible" ? 1 : 119;
      livePresence[target] = {
        ...livePresence[target]!,
        ts,
        lastActivityAt: ts,
        lastInputSeconds: index % 2,
        watchedSessions:
          kind === "presence.visible" && index % 2
            ? []
            : [kind === "presence.visible" ? selectedSessionKey : sessions[240]!.key],
      };
      payload = { presence: livePresence.map((entry) => Object.assign({}, entry)) };
    } else if (kind.startsWith("sessions.changed.") || kind === "run-state.unrelated") {
      event = "sessions.changed";
      const row =
        sessions[
          kind === "sessions.changed.visible"
            ? 0
            : kind === "sessions.changed.hidden-held"
              ? 160
              : 240
        ]!;
      payload = {
        sessionKey: row.key,
        agentId: "main",
        reason: kind === "run-state.unrelated" ? "agent.run.started" : "patch",
        ts,
        updatedAt: row.updatedAt,
        sessionId: row.sessionId,
        lastMessagePreview: `Synthetic live activity ${index + 1}`,
        session: {
          ...row,
          snapshotAt: ts,
          ...(kind === "run-state.unrelated" ? { hasActiveRun: index % 2 === 0 } : {}),
          lastMessagePreview: `Synthetic live activity ${index + 1}`,
        },
        ancestorSessions: [],
      };
    } else if (kind === "session.message.open") {
      event = "session.message";
      const message = {
        role: "user",
        content: [{ type: "text", text: `Synthetic live checkpoint ${index + 1}` }],
        timestamp: ts,
        __openclaw: { id: `team-scale-live-message-${index}` },
      };
      history = { message };
      payload = {
        sessionKey: selectedSessionKey,
        clientRunId: runId,
        messageId: `team-scale-live-message-${index}`,
        messageSeq: counts.transcriptMessages + index + 1,
        activeRunIds: [runId],
        hasActiveRun: true,
        message,
      };
    } else if (kind === "chat.delta.open") {
      event = "chat";
      history = { text: `Synthetic streaming progress ${index + 1}` };
      payload = {
        sessionKey: selectedSessionKey,
        runId,
        seq: index + 1,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: history.text }],
        },
      };
    } else if (kind === "catalog.host") {
      event = "sessions.catalog.host";
      const source = catalogEvents[index % catalogEvents.length]!;
      payload = {
        ...source.payload,
        catalog: {
          ...source.payload.catalog,
          hosts: source.payload.catalog.hosts.map((host) =>
            Object.assign({}, host, {
              sessions: host.sessions.map((row, rowIndex) =>
                rowIndex === 0
                  ? Object.assign({}, row, {
                      updatedAt: ts,
                      name: `Synthetic live catalog ${index + 1}`,
                    })
                  : row,
              ),
            }),
          ),
        },
      };
    } else {
      event = "cron";
      payload = { jobId: "team-scale-unrelated-job", action: "started", runAtMs: ts };
    }
    return { atMs: (index + 1) * 160, kind, event, payload, history };
  });
  if (options.sidebarListChurn) {
    prepareTeamScaleSidebarListChurn({ sessions, people, liveEvents, selectedSessionKey, now });
  }
  if (options.sidebarLiveChurn) {
    // Changes stop at 14 seconds; allow a second to settle before the quiet window.
    liveEvents.splice(0);
    for (let index = 0; index < 125; index++) {
      const atMs = (index + 1) * 160;
      const genuineChange = atMs < 14_000;
      const ts = now + atMs;
      if (index % 3 !== 2) {
        liveEvents.push({
          atMs,
          kind: genuineChange ? "presence.visible-change" : "presence.equivalent",
          event: "presence",
          payload: {
            presence: presenceEntries.map((entry, personIndex) =>
              Object.assign({}, entry, {
                ts,
                user: { ...entry.user },
                watchedSessions:
                  genuineChange && personIndex === 1 && index % 2 === 0
                    ? []
                    : [...(entry.watchedSessions ?? [])],
              }),
            ),
          },
        });
      } else {
        const row = sessions[0]!;
        liveEvents.push({
          atMs,
          kind: genuineChange ? "run-state.visible-change" : "run-state.equivalent",
          event: "sessions.changed",
          payload: {
            sessionKey: row.key,
            agentId: "main",
            reason: "agent.run.started",
            ts,
            updatedAt: row.updatedAt,
            sessionId: row.sessionId,
            session: {
              ...row,
              snapshotAt: ts,
              hasActiveRun: !genuineChange || index % 2 === 0,
              status: genuineChange && index % 2 ? "done" : "running",
            },
            ancestorSessions: [],
          },
        });
      }
    }
  }
  if (options.sessionEventChurn) {
    liveEvents.splice(0, liveEvents.length, ...createTeamScaleSessionEvents(sessions, now));
  }
  return {
    scenario,
    selectedSessionKey,
    pinnedKeys,
    sidebarEntries,
    events,
    liveEvents,
    sidebarListInput,
    cronJobs,
    listCronJobs,
    sidebarLiveChurn: options.sidebarLiveChurn
      ? { equivalentAfterMs: 14_000, quietAfterMs: 15_000, durationMs: 20_000 }
      : undefined,
    liveHistory: options.liveRun
      ? {
          sessionId: pinnedRows[0]!.sessionId,
          sessionInfo: pinnedRows[0]!,
          messages: historyMessages,
          inFlightRun: {
            runId: TEAM_SCALE_LIVE_RUN_ID,
            text: "Synthetic streaming progress 0",
            startedAt: now,
            events: [],
          },
        }
      : undefined,
    counts: { ...counts, sessions: sessions.length },
    assets,
  };
}

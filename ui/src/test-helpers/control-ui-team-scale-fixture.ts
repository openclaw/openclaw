import type {
  SessionCatalog,
  SessionsCatalogHostEvent,
} from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { UserProfile } from "../../../packages/gateway-protocol/src/schema/users.js";
import type {
  AgentsListResult,
  GatewaySessionRow,
  PresenceEntry,
  SessionsListResult,
} from "../api/types.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import type { BoardSnapshot } from "../lib/board/types.ts";
import { defaultControlUiFeatureMethods } from "./control-ui-e2e-defaults.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import {
  prepareTeamScaleSidebarListChurn,
  type TeamScaleLiveEvent,
} from "./control-ui-sidebar-list-fixture.ts";

const TEAM_SCALE_COUNTS = {
  sessions: 300,
  firstPage: 200,
  pinned: 30,
  owners: 34,
  people: 120,
  agents: 6,
  plugins: 6,
  transcriptMessages: 240,
  inlineWidgets: 12,
  catalogHosts: 6,
  catalogSessionsPerHost: 20,
  presenceEvents: 12,
} as const;

const TEAM_SCALE_CATALOG_PROGRESS_ID = "team-scale-progress";
const TEAM_SCALE_LIVE_RUN_ID = "team-scale-live-run";
export const TEAM_SCALE_SELF_INSTANCE_ID = "team-scale-self";

type TeamScaleCatalogEvent = { event: "sessions.catalog.host"; payload: SessionsCatalogHostEvent };
type TeamScaleEvent = TeamScaleCatalogEvent | { event: "presence"; payload: PresencePayload };

type FixtureAsset = { body: string; contentType: string; status?: number; delayMs?: number };
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
};

function personId(index: number) {
  return `team-person-${String(index + 1).padStart(3, "0")}`;
}

function widgetHtml(index: number) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team metric ${index + 1}</title>
<style>:root{color-scheme:dark light;font-family:system-ui}body{margin:0;padding:20px}h2{font-size:18px}progress{width:100%}</style></head>
<body><h2>Team metric ${index + 1}</h2><p>Synthetic completed work: ${60 + index}%</p>
<progress value="${60 + index}" max="100"></progress><p>All fixture systems are available.</p></body></html>`;
}

/** One deterministic inventory shared by browser benchmarks and focused UI proofs. */
export function createControlUiTeamScaleFixture(options: FixtureOptions = {}) {
  const counts = TEAM_SCALE_COUNTS;
  const now = options.now ?? Date.now();
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:19626/";
  const assets = new Map<string, FixtureAsset>();
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
  const people: ControlUiMockPresenceUser[] = Array.from({ length: counts.people }, (_, index) => ({
    id: personId(index),
    identity: { type: "profile", id: personId(index) },
    self: index === 0,
    name: `Fixture person ${String(index + 1).padStart(3, "0")}`,
    email: `person-${index + 1}@example.test`,
    ...(options.sidebarLiveChurn
      ? { avatarUrl: `/api/users/${personId(index)}/avatar?v=${now}` }
      : {}),
    instanceId: index === 0 ? TEAM_SCALE_SELF_INSTANCE_ID : `team-client-${index + 1}`,
    mode: "webchat",
    platform: "MacIntel",
    deviceFamily: "Mac",
    timeZone: "America/Los_Angeles",
    ts: now,
    onlineSince: now - 3_600_000 - index * 60_000,
    lastActivityAt: now - index * 1_000,
    lastInputSeconds: index,
  }));
  const profiles: UserProfile[] = people.map((person) => ({
    id: person.id,
    displayName: person.name ?? null,
    emails: person.email ? [person.email] : [],
    avatarMime: options.sidebarLiveChurn ? "image/png" : null,
    hasAvatar: Boolean(options.sidebarLiveChurn),
    githubIdentity: null,
    mergedInto: null,
    createdAt: now - 86_400_000,
    updatedAt: now,
  }));
  // The selected agent owns a full 300-row roster; extra agent identities model
  // the switcher without silently reducing the selected agent's page pressure.
  const sessions: TeamScaleSession[] = Array.from({ length: counts.sessions }, (_, index) => {
    const pinned = index >= counts.sessions - counts.pinned;
    const owner = people[index % counts.owners]!;
    const running = index < 24;
    return {
      key: `agent:main:${pinned ? "dashboard" : "chat"}:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
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
  if (options.sidebarListChurn || options.sidebarLiveChurn) {
    for (const [index, row] of sessions.entries()) {
      const owner = people[index % counts.owners]!;
      row.owner = {
        actor: {
          type: "human",
          id: owner.id,
          identity: { type: "profile", id: owner.id },
          label: owner.name,
        },
      };
      row.hiddenFromInvolvingMe = false;
      if (index < 230 && owner.id !== people[0]!.id) {
        row.participants = [
          ...row.participants!,
          { identity: { type: "profile", id: people[0]!.id }, label: people[0]!.name },
        ];
      }
    }
  }
  const pinnedRows = sessions.slice(-counts.pinned);
  const pinnedKeys = pinnedRows.map((row) => row.key);
  const selectedSessionKey = pinnedKeys[0]!;
  if (options.liveRun) {
    Object.assign(pinnedRows[0]!, {
      hasActiveRun: true,
      status: "running",
      activeRunIds: [TEAM_SCALE_LIVE_RUN_ID],
    });
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
  const ownerSessionCounts = people.slice(0, counts.owners).map((person) => ({
    profileId: person.id,
    open: sessions.filter((row) => row.owner?.actor.id === person.id).length,
    running: sessions.filter((row) => row.owner?.actor.id === person.id && row.hasActiveRun).length,
  }));
  const list = (
    rows: GatewaySessionRow[],
    totalCount = rows.length,
    offset = 0,
  ): SessionsListResult => ({
    ts: now,
    path: "",
    count: rows.length,
    totalCount,
    offset,
    hasMore: offset + rows.length < totalCount,
    nextOffset: offset + rows.length < totalCount ? offset + rows.length : null,
    defaults: { model: "gpt-5-mini", modelProvider: "openai", contextTokens: 200_000 },
    sessions: rows,
    ownerSessionCounts,
    owners: people.slice(0, counts.owners).map((person) => ({
      type: "human",
      id: person.id,
      identity: person.identity,
      label: person.name,
    })),
  });
  const historyMessages = Array.from({ length: counts.transcriptMessages }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    timestamp: now - (counts.transcriptMessages - index) * 60_000,
    content: [
      {
        type: "text",
        text: [
          `### Project checkpoint ${index + 1}`,
          "Review the synthetic work queue, confirm the dependency order, and record the owner of the next action. The fixture contains no real conversations or account data.",
          index % 2
            ? "The current implementation is ready for verification. Coverage includes the normal path, a recoverable failure, and the final user-visible result."
            : "Please check the current progress and keep the existing layout stable while the remaining results arrive.",
          ...(index % 20 === 19
            ? [
                `[embed ref="team-scale-chart-${Math.floor(index / 20) + 1}" title="Team metric ${Math.floor(index / 20) + 1}" height="220" /]`,
              ]
            : []),
        ].join("\n\n"),
      },
    ],
  }));
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
    ],
    methodResponses: {
      "question.list": { questions: [] },
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
          { match: { pinned: true }, response: list(pinnedRows) },
          { match: { hasBoard: true }, response: list(pinnedRows) },
          {
            match: { offset: counts.firstPage },
            response: list(sessions.slice(counts.firstPage), counts.sessions, counts.firstPage),
          },
          { match: {}, response: list(sessions.slice(0, counts.firstPage), counts.sessions) },
        ],
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
  return {
    scenario,
    selectedSessionKey,
    pinnedKeys,
    sidebarEntries,
    events,
    liveEvents,
    sidebarLiveChurn: options.sidebarLiveChurn
      ? { equivalentAfterMs: 14_000, quietAfterMs: 15_000, durationMs: 20_000 }
      : undefined,
    sidebarListChurn: options.sidebarListChurn
      ? {
          rows: sessions,
          viewerProfileId: people[0]!.id,
          now,
          defaults: list([]).defaults,
          owners: list([]).owners,
        }
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
    counts,
    assets,
  };
}

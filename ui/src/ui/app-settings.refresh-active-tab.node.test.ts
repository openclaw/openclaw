// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

type CronRunsLoadStatus = "ok" | "error" | "skipped";

const mocks = vi.hoisted(() => ({
  refreshChatMock: vi.fn(async () => {}),
  scheduleChatScrollMock: vi.fn(),
  scheduleLogsScrollMock: vi.fn(),
  loadAgentFilesMock: vi.fn(async () => {}),
  loadAgentIdentitiesMock: vi.fn(async () => {}),
  loadAgentIdentityMock: vi.fn(async () => {}),
  loadAgentSkillsMock: vi.fn(async () => {}),
  loadAgentsMock: vi.fn(async () => {}),
  loadAgentsRuntimeStatusMock: vi.fn(async () => {}),
  loadOpsSummaryMock: vi.fn(async () => {}),
  loadChannelsMock: vi.fn(async () => {}),
  loadConfigMock: vi.fn(async () => {}),
  loadConfigSchemaMock: vi.fn(async () => {}),
  loadCronStatusMock: vi.fn(async () => {}),
  loadCronJobsPageMock: vi.fn(async () => {}),
  loadCronRunsMock: vi.fn<() => Promise<CronRunsLoadStatus>>(async () => "ok"),
  loadDebugMock: vi.fn(async () => {}),
  loadDevicesMock: vi.fn(async () => {}),
  loadExecApprovalsMock: vi.fn(async () => {}),
  loadLogsMock: vi.fn(async () => {}),
  loadModelAuthStatusStateMock: vi.fn(async () => {}),
  loadNodesMock: vi.fn(async () => {}),
  loadPresenceMock: vi.fn(async () => {}),
  loadSessionsMock: vi.fn(async () => {}),
  loadSelfImprovementRecommendationsMock: vi.fn(async () => {}),
  loadSkillsMock: vi.fn(async () => {}),
  loadUsageMock: vi.fn(async () => {}),
}));

vi.mock("./app-chat.ts", () => ({
  refreshChat: mocks.refreshChatMock,
}));
vi.mock("./app-scroll.ts", () => ({
  scheduleChatScroll: mocks.scheduleChatScrollMock,
  scheduleLogsScroll: mocks.scheduleLogsScrollMock,
}));
vi.mock("./controllers/agent-files.ts", () => ({
  loadAgentFiles: mocks.loadAgentFilesMock,
}));
vi.mock("./controllers/agent-identity.ts", () => ({
  loadAgentIdentities: mocks.loadAgentIdentitiesMock,
  loadAgentIdentity: mocks.loadAgentIdentityMock,
}));
vi.mock("./controllers/agent-skills.ts", () => ({
  loadAgentSkills: mocks.loadAgentSkillsMock,
}));
vi.mock("./controllers/agents.ts", () => ({
  loadAgents: mocks.loadAgentsMock,
  loadAgentsRuntimeStatus: mocks.loadAgentsRuntimeStatusMock,
  loadOpsSummary: mocks.loadOpsSummaryMock,
}));
vi.mock("./controllers/channels.ts", () => ({
  loadChannels: mocks.loadChannelsMock,
}));
vi.mock("./controllers/config.ts", () => ({
  loadConfig: mocks.loadConfigMock,
  loadConfigSchema: mocks.loadConfigSchemaMock,
}));
vi.mock("./controllers/cron.ts", () => ({
  loadCronStatus: mocks.loadCronStatusMock,
  loadCronJobsPage: mocks.loadCronJobsPageMock,
  loadCronRuns: mocks.loadCronRunsMock,
}));
vi.mock("./controllers/debug.ts", () => ({
  loadDebug: mocks.loadDebugMock,
}));
vi.mock("./controllers/devices.ts", () => ({
  loadDevices: mocks.loadDevicesMock,
}));
vi.mock("./controllers/exec-approvals.ts", () => ({
  loadExecApprovals: mocks.loadExecApprovalsMock,
}));
vi.mock("./controllers/logs.ts", () => ({
  loadLogs: mocks.loadLogsMock,
}));
vi.mock("./controllers/model-auth-status.ts", () => ({
  loadModelAuthStatusState: mocks.loadModelAuthStatusStateMock,
}));
vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: mocks.loadNodesMock,
}));
vi.mock("./controllers/presence.ts", () => ({
  loadPresence: mocks.loadPresenceMock,
}));
vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: mocks.loadSessionsMock,
}));
vi.mock("./controllers/self-improvement.ts", () => ({
  loadSelfImprovementRecommendations: mocks.loadSelfImprovementRecommendationsMock,
}));
vi.mock("./controllers/skills.ts", () => ({
  loadSkills: mocks.loadSkillsMock,
}));
vi.mock("./controllers/usage.ts", () => ({
  loadUsage: mocks.loadUsageMock,
}));

import { refreshActiveTab, setTab } from "./app-settings.ts";

function createHost() {
  return {
    tab: "agents",
    connected: true,
    client: {},
    agentsPanel: "overview",
    agentsSelectedId: "agent-b",
    agentsList: {
      defaultId: "agent-a",
      agents: [{ id: "agent-a" }, { id: "agent-b" }],
    },
    chatHasAutoScrolled: false,
    logsAtBottom: false,
    eventLog: [],
    eventLogBuffer: [],
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(),
    cronRunsScope: "all",
    cronRunsJobId: null as string | null,
    sessionKey: "main",
    settings: {},
    basePath: "",
  };
}

describe("refreshActiveTab", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      fn.mockReset();
    }
  });

  const expectCommonAgentsTabRefresh = (
    host: ReturnType<typeof createHost>,
    options: { configLoaded?: boolean; selectedIdentityLoaded?: boolean } = {
      configLoaded: true,
      selectedIdentityLoaded: true,
    },
  ) => {
    expect(mocks.loadAgentsMock).toHaveBeenCalledOnce();
    if (options.configLoaded === false) {
      expect(mocks.loadConfigMock).not.toHaveBeenCalled();
    } else {
      expect(mocks.loadConfigMock).toHaveBeenCalledOnce();
    }
    expect(mocks.loadAgentIdentitiesMock).toHaveBeenCalledWith(host, ["agent-a", "agent-b"]);
    if (options.selectedIdentityLoaded === false) {
      expect(mocks.loadAgentIdentityMock).not.toHaveBeenCalled();
    } else {
      expect(mocks.loadAgentIdentityMock).toHaveBeenCalledWith(host, "agent-b");
    }
  };
  const expectNoCronLoaders = () => {
    expect(mocks.loadCronStatusMock).not.toHaveBeenCalled();
    expect(mocks.loadCronJobsPageMock).not.toHaveBeenCalled();
    expect(mocks.loadCronRunsMock).not.toHaveBeenCalled();
  };
  const panelLoaderArgs = {
    files: [mocks.loadAgentFilesMock, "agent-b"],
    skills: [mocks.loadAgentSkillsMock, "agent-b"],
    channels: [mocks.loadChannelsMock, false],
    tools: null,
  } as const;

  for (const panel of ["files", "skills", "channels", "tools"] as const) {
    it(`routes agents ${panel} panel refresh through the expected loaders`, async () => {
      const host = createHost();
      host.agentsPanel = panel;

      await refreshActiveTab(host as never);

      expectCommonAgentsTabRefresh(host, { configLoaded: panel !== "channels" });
      expect(mocks.loadAgentFilesMock).toHaveBeenCalledTimes(panel === "files" ? 1 : 0);
      expect(mocks.loadAgentSkillsMock).toHaveBeenCalledTimes(panel === "skills" ? 1 : 0);
      expect(mocks.loadChannelsMock).toHaveBeenCalledTimes(panel === "channels" ? 1 : 0);
      const expectedLoader = panelLoaderArgs[panel];
      if (expectedLoader) {
        const [loader, expectedArg] = expectedLoader;
        expect(loader).toHaveBeenCalledWith(host, expectedArg);
      }
      expectNoCronLoaders();
    });
  }

  it("opens workflow maps from the dedicated sidebar tab", async () => {
    const host = createHost();

    setTab(host as never, "agentWorkflows");

    expect(host.tab).toBe("agentWorkflows");
    expect(host.agentsPanel).toBe("workflows");
    await vi.waitFor(() => {
      expect(mocks.loadAgentIdentitiesMock).toHaveBeenCalledWith(host, ["agent-a", "agent-b"]);
    });
    expectCommonAgentsTabRefresh(host, { configLoaded: false });
  });

  it("routes agents cron panel refresh through cron loaders", async () => {
    const host = createHost();
    host.agentsPanel = "cron";
    host.cronRunsScope = "job";
    host.cronRunsJobId = "job-123";

    await refreshActiveTab(host as never);

    expectCommonAgentsTabRefresh(host, { configLoaded: false });
    expect(mocks.loadChannelsMock).toHaveBeenCalledWith(host, false);
    expect(mocks.loadCronStatusMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronJobsPageMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronRunsMock).toHaveBeenCalledWith(host, "job-123");
    expect(mocks.loadAgentFilesMock).not.toHaveBeenCalled();
    expect(mocks.loadAgentSkillsMock).not.toHaveBeenCalled();
  });

  it("routes agents self-improvement panel refresh through recommendation loader", async () => {
    const host = createHost();
    host.agentsPanel = "self-improvement";

    await refreshActiveTab(host as never);

    expectCommonAgentsTabRefresh(host, {
      configLoaded: false,
      selectedIdentityLoaded: false,
    });
    expect(mocks.loadSelfImprovementRecommendationsMock).toHaveBeenCalledWith(host);
    expectNoCronLoaders();
    expect(mocks.loadAgentFilesMock).not.toHaveBeenCalled();
    expect(mocks.loadAgentSkillsMock).not.toHaveBeenCalled();
  });

  it("refreshes the agents room with the compact Kalshi workspace snapshot", async () => {
    const host = {
      ...createHost(),
      agentsPanel: "room",
      loadKalshiDashboard: vi.fn(async () => {}),
    };

    await refreshActiveTab(host as never);

    expectCommonAgentsTabRefresh(host, { configLoaded: false });
    expect(mocks.loadChannelsMock).toHaveBeenCalledWith(host, false);
    await vi.waitFor(() => {
      expect(mocks.loadCronStatusMock).toHaveBeenCalledOnce();
      expect(mocks.loadCronJobsPageMock).toHaveBeenCalledOnce();
    });
    expect(mocks.loadCronRunsMock).not.toHaveBeenCalled();
    expect(host.loadKalshiDashboard).toHaveBeenCalledWith({ view: "workspace" });
  });

  it("refreshes logs tab by resetting bottom-follow and scheduling scroll", async () => {
    const host = createHost();
    host.tab = "logs";

    await refreshActiveTab(host as never);

    expect(host.logsAtBottom).toBe(true);
    expect(mocks.loadLogsMock).toHaveBeenCalledWith(host, { reset: true });
    expect(mocks.scheduleLogsScrollMock).toHaveBeenCalledWith(host, true);
  });

  it("refreshes the Kalshi dashboard tab", async () => {
    const host = {
      ...createHost(),
      tab: "kalshi",
      loadKalshiDashboard: vi.fn(async () => {}),
    };

    await refreshActiveTab(host as never);

    expect(host.loadKalshiDashboard).toHaveBeenCalledWith({ view: "full" });
  });

  it("records tab visible timing without waiting for the tab refresh RPC", async () => {
    const host = createHost();
    host.tab = "chat";
    let resolveSessions!: () => void;
    mocks.loadSessionsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSessions = resolve;
      }),
    );

    setTab(host as never, "sessions");

    expect(host.requestUpdate).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(host.eventLogBuffer).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "control-ui.tab.visible",
            payload: expect.objectContaining({
              previousTab: "chat",
              tab: "sessions",
              durationMs: expect.any(Number),
            }),
          }),
        ]),
      );
    });

    resolveSessions();
  });

  it("does not wait for secondary overview refreshes before resolving", async () => {
    const host = createHost();
    host.tab = "overview";
    mocks.loadUsageMock.mockReturnValueOnce(new Promise<void>(() => undefined));

    const refresh = refreshActiveTab(host as never);
    const outcome = await Promise.race([
      refresh.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(outcome).toBe("resolved");
    expect(mocks.loadChannelsMock).toHaveBeenCalled();
    expect(mocks.loadSessionsMock).toHaveBeenCalled();
    expect(mocks.loadUsageMock).toHaveBeenCalled();
  });

  it("records overview secondary refresh duration and aggregate status", async () => {
    const host = createHost();
    host.tab = "overview";
    let resolveUsage!: () => void;
    mocks.loadUsageMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveUsage = resolve;
      }),
    );
    mocks.loadSkillsMock.mockRejectedValueOnce(new Error("skills failed"));

    await refreshActiveTab(host as never);
    resolveUsage();

    await vi.waitFor(() => {
      expect(host.eventLogBuffer).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "control-ui.overview.secondary",
            payload: expect.objectContaining({
              phase: "end",
              status: "error",
              durationMs: expect.any(Number),
            }),
          }),
        ]),
      );
    });
  });

  it("does not wait for cron runs before resolving the cron tab refresh", async () => {
    const host = createHost();
    host.tab = "cron";
    mocks.loadCronRunsMock.mockReturnValueOnce(new Promise<"ok">(() => undefined));

    const refresh = refreshActiveTab(host as never);
    const outcome = await Promise.race([
      refresh.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(outcome).toBe("resolved");
    expect(mocks.loadChannelsMock).toHaveBeenCalledWith(host, false);
    expect(mocks.loadCronStatusMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronJobsPageMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronRunsMock).toHaveBeenCalledOnce();
  });

  it("records failed cron runs status from the controller outcome", async () => {
    const host = createHost();
    host.tab = "cron";
    mocks.loadCronRunsMock.mockResolvedValueOnce("error" as const);

    await expect(refreshActiveTab(host as never)).resolves.toBeUndefined();
    await Promise.resolve();

    expect(host.eventLogBuffer).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "control-ui.cron.runs",
          payload: expect.objectContaining({
            phase: "end",
            status: "error",
            durationMs: expect.any(Number),
          }),
        }),
      ]),
    );
  });

  it("contains rejected cron runs refreshes without failing the primary cron tab refresh", async () => {
    const host = createHost();
    host.tab = "cron";
    mocks.loadCronRunsMock.mockRejectedValueOnce(new Error("cron runs slow path failed"));

    await expect(refreshActiveTab(host as never)).resolves.toBeUndefined();
    await Promise.resolve();

    expect(host.eventLogBuffer).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "control-ui.cron.runs",
          payload: expect.objectContaining({
            phase: "end",
            status: "error",
            durationMs: expect.any(Number),
          }),
        }),
      ]),
    );
  });

  it("does not record stale cron run timing after leaving the cron tab", async () => {
    const host = createHost();
    host.tab = "cron";
    let resolveRuns!: () => void;
    mocks.loadCronRunsMock.mockReturnValueOnce(
      new Promise<"ok">((resolve) => {
        resolveRuns = () => resolve("ok");
      }),
    );

    await refreshActiveTab(host as never);
    host.tab = "chat";
    resolveRuns();
    await Promise.resolve();

    expect(host.eventLogBuffer).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "control-ui.cron.runs",
        }),
      ]),
    );
  });
});

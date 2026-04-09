import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshChatMock: vi.fn(async () => {}),
  scheduleChatScrollMock: vi.fn(),
  scheduleLogsScrollMock: vi.fn(),
  loadAgentFilesMock: vi.fn(async () => {}),
  loadAgentIdentitiesMock: vi.fn(async () => {}),
  loadAgentIdentityMock: vi.fn(async () => {}),
  loadAgentSkillsMock: vi.fn(async () => {}),
  loadAgentsMock: vi.fn(async () => {}),
  loadChannelsMock: vi.fn(async () => {}),
  loadConfigMock: vi.fn(async () => {}),
  loadConfigSchemaMock: vi.fn(async () => {}),
  loadCronStatusMock: vi.fn(async () => {}),
  loadCronJobsMock: vi.fn(async () => {}),
  loadCronRunsMock: vi.fn(async () => {}),
  loadLogsMock: vi.fn(async () => {}),
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
  loadCronJobs: mocks.loadCronJobsMock,
  loadCronRuns: mocks.loadCronRunsMock,
}));

vi.mock("./controllers/logs.ts", () => ({
  loadLogs: mocks.loadLogsMock,
}));

import { refreshActiveTab } from "./app-settings.ts";

type RefreshHost = {
  tab: string;
  connected: boolean;
  client: object;
  agentsPanel: string;
  agentsSelectedId: string;
  agentsList: { defaultId: string; agents: Array<{ id: string }> };
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  cronRunsScope: string;
  cronRunsJobId: string | null;
  sessionKey: string;
};

function createHost(): RefreshHost {
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
    cronRunsScope: "all",
    cronRunsJobId: null,
    sessionKey: "main",
  };
}

describe("refreshActiveTab", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      fn.mockReset();
    }
  });

  it("loads agents panel files data for the resolved selected agent", async () => {
    const host = createHost();
    host.tab = "agents";
    host.agentsPanel = "files";

    await refreshActiveTab(host as never);

    expect(mocks.loadAgentsMock).toHaveBeenCalledOnce();
    expect(mocks.loadConfigMock).toHaveBeenCalledOnce();
    expect(mocks.loadAgentIdentitiesMock).toHaveBeenCalledWith(host, ["agent-a", "agent-b"]);
    expect(mocks.loadAgentIdentityMock).toHaveBeenCalledWith(host, "agent-b");
    expect(mocks.loadAgentFilesMock).toHaveBeenCalledWith(host, "agent-b");
    expect(mocks.loadAgentSkillsMock).not.toHaveBeenCalled();
    expect(mocks.loadChannelsMock).not.toHaveBeenCalled();
    expect(mocks.loadCronStatusMock).not.toHaveBeenCalled();
  });

  it("routes agents cron panel refresh through cron loaders", async () => {
    const host = createHost();
    host.tab = "agents";
    host.agentsPanel = "cron";
    host.cronRunsScope = "job";
    host.cronRunsJobId = "job-123";

    await refreshActiveTab(host as never);

    expect(mocks.loadAgentsMock).toHaveBeenCalledOnce();
    expect(mocks.loadConfigMock).toHaveBeenCalledOnce();
    expect(mocks.loadAgentIdentityMock).toHaveBeenCalledWith(host, "agent-b");
    expect(mocks.loadChannelsMock).toHaveBeenCalledWith(host, false);
    expect(mocks.loadCronStatusMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronJobsMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronRunsMock).toHaveBeenCalledWith(host, "job-123");
    expect(mocks.loadAgentFilesMock).not.toHaveBeenCalled();
    expect(mocks.loadAgentSkillsMock).not.toHaveBeenCalled();
  });

  it("keeps tools panel refresh narrow and skips files/skills/channels/cron loaders", async () => {
    const host = createHost();
    host.tab = "agents";
    host.agentsPanel = "tools";

    await refreshActiveTab(host as never);

    expect(mocks.loadAgentsMock).toHaveBeenCalledOnce();
    expect(mocks.loadConfigMock).toHaveBeenCalledOnce();
    expect(mocks.loadAgentIdentityMock).toHaveBeenCalledWith(host, "agent-b");
    expect(mocks.loadAgentFilesMock).not.toHaveBeenCalled();
    expect(mocks.loadAgentSkillsMock).not.toHaveBeenCalled();
    expect(mocks.loadChannelsMock).not.toHaveBeenCalled();
    expect(mocks.loadCronStatusMock).not.toHaveBeenCalled();
    expect(mocks.loadCronJobsMock).not.toHaveBeenCalled();
    expect(mocks.loadCronRunsMock).not.toHaveBeenCalled();
  });

  it("refreshes logs tab by resetting bottom-follow and scheduling scroll", async () => {
    const host = createHost();
    host.tab = "logs";
    host.logsAtBottom = false;

    await refreshActiveTab(host as never);

    expect(host.logsAtBottom).toBe(true);
    expect(mocks.loadLogsMock).toHaveBeenCalledWith(host, { reset: true });
    expect(mocks.scheduleLogsScrollMock).toHaveBeenCalledWith(host, true);
  });
});

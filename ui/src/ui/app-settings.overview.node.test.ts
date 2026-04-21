/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const loadChannelsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadPresenceMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadSessionsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadCronStatusMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadCronJobsPageMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadSkillsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadUsageMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadModelAuthStatusStateMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./controllers/channels.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/channels.ts")>();
  return { ...actual, loadChannels: loadChannelsMock };
});

vi.mock("./controllers/presence.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/presence.ts")>();
  return { ...actual, loadPresence: loadPresenceMock };
});

vi.mock("./controllers/sessions.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/sessions.ts")>();
  return { ...actual, loadSessions: loadSessionsMock };
});

vi.mock("./controllers/cron.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/cron.ts")>();
  return {
    ...actual,
    loadCronStatus: loadCronStatusMock,
    loadCronJobsPage: loadCronJobsPageMock,
  };
});

vi.mock("./controllers/skills.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/skills.ts")>();
  return { ...actual, loadSkills: loadSkillsMock };
});

vi.mock("./controllers/usage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/usage.ts")>();
  return { ...actual, loadUsage: loadUsageMock };
});

vi.mock("./controllers/model-auth-status.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/model-auth-status.ts")>();
  return { ...actual, loadModelAuthStatusState: loadModelAuthStatusStateMock };
});

type LoadOverview = typeof import("./app-settings.ts").loadOverview;
let loadOverview: LoadOverview;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHost() {
  return {
    client: {
      request: vi.fn(async () => ({ lines: [], cursor: 1 })),
    },
    connected: true,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    },
    password: "",
    theme: "claw",
    themeMode: "system",
    themeResolved: "dark",
    applySessionKey: "main",
    sessionKey: "main",
    tab: "overview",
    chatHasAutoScrolled: false,
    logsAtBottom: false,
    eventLog: [],
    eventLogBuffer: [],
    basePath: "",
    agentsList: null,
    agentsSelectedId: null,
    agentsPanel: "overview",
    pendingGatewayUrl: null,
    systemThemeCleanup: null,
    pendingGatewayToken: null,
    dreamingStatusLoading: false,
    dreamingStatusError: null,
    dreamingStatus: null,
    dreamingModeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryError: null,
    dreamDiaryPath: null,
    dreamDiaryContent: null,
    overviewLogCursor: null,
    overviewLogLines: [],
    attentionItems: [],
    hello: null,
    lastError: null,
    modelAuthStatusResult: null,
    skillsReport: null,
    usageResult: null,
    cronError: null,
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    sessionsResult: null,
  } as unknown as Parameters<LoadOverview>[0];
}

describe("loadOverview", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ loadOverview } = await import("./app-settings.ts"));
  });

  it("does not wait for secondary overview loaders before resolving", async () => {
    const primaryDeferred = createDeferred<void>();
    const channelsDeferred = createDeferred<void>();
    const cronJobsDeferred = createDeferred<void>();
    const skillsDeferred = createDeferred<void>();
    const usageDeferred = createDeferred<void>();
    const authDeferred = createDeferred<void>();

    loadChannelsMock.mockImplementation(async () => {
      await channelsDeferred.promise;
    });
    loadPresenceMock.mockImplementation(async () => {
      await primaryDeferred.promise;
    });
    loadSessionsMock.mockImplementation(async () => undefined);
    loadCronStatusMock.mockImplementation(async () => undefined);
    loadCronJobsPageMock.mockImplementation(async () => {
      await cronJobsDeferred.promise;
    });
    loadSkillsMock.mockImplementation(async () => {
      await skillsDeferred.promise;
    });
    loadUsageMock.mockImplementation(async () => {
      await usageDeferred.promise;
    });
    loadModelAuthStatusStateMock.mockImplementation(async () => {
      await authDeferred.promise;
    });

    const host = createHost();
    let resolved = false;
    const promise = loadOverview(host).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    primaryDeferred.resolve();
    await promise;
    expect(resolved).toBe(true);

    expect(loadCronJobsPageMock).toHaveBeenCalledOnce();
    expect(loadSkillsMock).toHaveBeenCalledOnce();
    expect(loadUsageMock).toHaveBeenCalledOnce();
    expect(loadModelAuthStatusStateMock).toHaveBeenCalledOnce();
    expect(loadChannelsMock).toHaveBeenCalledWith(host, false, { includeAccounts: false });

    channelsDeferred.resolve();
    cronJobsDeferred.resolve();
    skillsDeferred.resolve();
    usageDeferred.resolve();
    authDeferred.resolve();
  });
});

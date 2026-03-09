import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../ui/src/ui/navigation.ts";

const loadUsageMock = vi.hoisted(() => vi.fn(async () => undefined));
const storageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => store.delete(key)),
    setItem: vi.fn((key: string, value: string) => store.set(key, String(value))),
    get length() {
      return store.size;
    },
  };
});

vi.mock("../../ui/src/ui/controllers/usage.ts", () => ({
  loadUsage: loadUsageMock,
}));

vi.stubGlobal("localStorage", storageMock as unknown as Storage);
vi.stubGlobal("sessionStorage", storageMock as unknown as Storage);

const { setTabFromRoute } = await import("../../ui/src/ui/app-settings.ts");

type SettingsHost = Parameters<typeof setTabFromRoute>[0] & {
  debugPollInterval: number | null;
  logsPollInterval: number | null;
};

const createHost = (tab: Tab, overrides: Partial<SettingsHost> = {}): SettingsHost => ({
  settings: {
    gatewayUrl: "",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
  },
  theme: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  tab,
  connected: true,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  logsPollInterval: null,
  debugPollInterval: null,
  ...overrides,
});

describe("usage tab refresh", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads usage data when the route switches to the usage tab", async () => {
    const host = createHost("chat");

    setTabFromRoute(host, "usage");
    await vi.waitFor(() => expect(loadUsageMock).toHaveBeenCalledTimes(1));
    expect(loadUsageMock).toHaveBeenCalledWith(host);
  });
});

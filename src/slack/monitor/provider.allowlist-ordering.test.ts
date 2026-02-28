import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

/**
 * Track invocation order to verify that allowlist resolution runs
 * concurrently with (not blocking) Socket Mode start.
 */
const callOrder: string[] = [];

/** Deferred helper so tests can control when async resolution settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const {
  appStartMock,
  appStopMock,
  createSlackMonitorContextMock,
  resolveSlackAccountMock,
  resolveSlackChannelAllowlistMock,
  resolveSlackUserAllowlistMock,
} = vi.hoisted(() => {
  return {
    appStartMock: vi.fn(),
    appStopMock: vi.fn(async () => undefined),
    createSlackMonitorContextMock: vi.fn(),
    resolveSlackAccountMock: vi.fn(() => ({
      accountId: "default",
      enabled: true,
      botTokenSource: "config" as const,
      appTokenSource: "config" as const,
      config: {
        channels: { general: {} },
        allowFrom: ["alice"],
      },
    })),
    resolveSlackChannelAllowlistMock: vi.fn(),
    resolveSlackUserAllowlistMock: vi.fn(),
  };
});

vi.mock("@slack/bolt", () => {
  class MockApp {
    client = {
      auth: { test: async () => ({ user_id: "B1", team_id: "T1" }) },
    };
    start = appStartMock;
    stop = appStopMock;
  }
  class MockHTTPReceiver {}
  return { default: { App: MockApp, HTTPReceiver: MockHTTPReceiver } };
});

vi.mock("../../auto-reply/chunk.js", () => ({
  resolveTextChunkLimit: () => 4000,
}));

vi.mock("../../auto-reply/reply/history.js", () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
}));

vi.mock("../../channels/allowlists/resolve-utils.js", () => ({
  addAllowlistUserEntriesFromConfigEntry: vi.fn(),
  buildAllowlistResolutionSummary: vi.fn(() => ({
    mapping: [],
    unresolved: [],
    additions: [],
    resolvedMap: new Map(),
  })),
  mergeAllowlist: vi.fn(({ existing }: { existing: unknown }) => existing),
  patchAllowlistUsersInConfigEntries: vi.fn(({ entries }: { entries: unknown }) => entries),
  summarizeMapping: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../../config/runtime-group-policy.js", () => ({
  resolveOpenProviderRuntimeGroupPolicy: () => ({
    groupPolicy: "open",
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: () => "open",
  warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
  warn: (v: string) => v,
}));

vi.mock("../../infra/http-body.js", () => ({
  installRequestBodyLimitGuard: vi.fn(),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: (v?: string) => v ?? "main",
}));

vi.mock("../../runtime.js", () => ({
  createNonExitingRuntime: () => ({
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  }),
}));

vi.mock("../accounts.js", () => ({
  resolveSlackAccount: resolveSlackAccountMock,
}));

vi.mock("../client.js", () => ({
  resolveSlackWebClientOptions: () => ({}),
}));

vi.mock("../http/index.js", () => ({
  normalizeSlackWebhookPath: (v?: string) => v ?? "/slack/events",
  registerSlackHttpHandler: vi.fn(() => vi.fn()),
}));

vi.mock("../resolve-channels.js", () => ({
  resolveSlackChannelAllowlist: resolveSlackChannelAllowlistMock,
}));

vi.mock("../resolve-users.js", () => ({
  resolveSlackUserAllowlist: resolveSlackUserAllowlistMock,
}));

vi.mock("../token.js", () => ({
  resolveSlackAppToken: (v?: string) => v ?? "xapp-1-A1-test",
  resolveSlackBotToken: (v?: string) => v ?? "xoxb-test",
}));

vi.mock("./allow-list.js", () => ({
  normalizeAllowList: (v: unknown) => v ?? [],
}));

vi.mock("./commands.js", () => ({
  resolveSlackSlashCommandConfig: () => ({
    enabled: false,
    name: "openclaw",
    sessionPrefix: "slack:slash",
    ephemeral: true,
  }),
}));

vi.mock("./context.js", () => ({
  createSlackMonitorContext: createSlackMonitorContextMock,
}));

vi.mock("./events.js", () => ({
  registerSlackMonitorEvents: vi.fn(),
}));

vi.mock("./message-handler.js", () => ({
  createSlackMessageHandler: () => vi.fn(),
}));

vi.mock("./slash.js", () => ({
  registerSlackMonitorSlashCommands: vi.fn(async () => undefined),
}));

describe("monitorSlackProvider allowlist ordering (void pattern)", () => {
  const baseRuntime = (): RuntimeEnv => ({
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as never,
  });

  const slackConfig = {
    channels: {
      slack: {
        accounts: { default: {} },
        channels: { general: {} },
        dm: { allowFrom: ["alice"] },
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    callOrder.length = 0;
    createSlackMonitorContextMock
      .mockClear()
      .mockImplementation((params: Record<string, unknown>) => ({
        ...params,
        channelHistories: new Map(),
        logger: { info: vi.fn(), warn: vi.fn() },
        markMessageSeen: () => false,
        shouldDropMismatchedSlackEvent: () => false,
        resolveSlackSystemEventSessionKey: () => "key",
        isChannelAllowed: () => true,
        resolveChannelName: async () => ({}),
        resolveUserName: async () => ({ name: "User" }),
        setSlackThreadStatus: async () => undefined,
      }));
    appStartMock.mockClear().mockImplementation(async () => {
      callOrder.push("app.start");
    });
    appStopMock.mockClear().mockResolvedValue(undefined);
    resolveSlackAccountMock.mockClear();
    resolveSlackChannelAllowlistMock.mockClear().mockImplementation(async () => {
      callOrder.push("resolveChannels");
      return [{ input: "general", resolved: true, id: "C001", name: "general" }];
    });
    resolveSlackUserAllowlistMock.mockClear().mockImplementation(async () => {
      callOrder.push("resolveUsers");
      return [{ input: "alice", resolved: true, id: "U001", name: "Alice" }];
    });
  });

  it("does not block app.start() on allowlist resolution (void pattern)", async () => {
    const { monitorSlackProvider } = await import("./provider.js");
    const ac = new AbortController();

    // Make channel resolution slow — if it blocked, app.start would come after
    const channelDeferred =
      deferred<
        typeof resolveSlackChannelAllowlistMock extends (...args: never[]) => Promise<infer R>
          ? R
          : never
      >();
    resolveSlackChannelAllowlistMock.mockImplementation(async () => {
      callOrder.push("resolveChannels:start");
      const result = await channelDeferred.promise;
      callOrder.push("resolveChannels:end");
      return result;
    });

    // Abort after app.start so the provider promise settles
    appStartMock.mockImplementation(async () => {
      callOrder.push("app.start");
      // Resolve the deferred so the background resolution can finish
      channelDeferred.resolve([{ input: "general", resolved: true, id: "C001", name: "general" }]);
      ac.abort();
    });

    await monitorSlackProvider({
      config: slackConfig,
      runtime: baseRuntime(),
      abortSignal: ac.signal,
    });

    const startIdx = callOrder.indexOf("app.start");
    const resolveEndIdx = callOrder.indexOf("resolveChannels:end");

    // app.start must have been called
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // Resolution started but app.start didn't wait for it to finish
    expect(callOrder).toContain("resolveChannels:start");
    // app.start came before resolution completed (void pattern)
    expect(startIdx).toBeLessThan(resolveEndIdx);
  });

  it("updates ctx.channelsConfig after async resolution completes", async () => {
    const { monitorSlackProvider } = await import("./provider.js");
    const ac = new AbortController();

    // Capture the ctx object created by the mock
    let capturedCtx: Record<string, unknown> | undefined;
    createSlackMonitorContextMock.mockImplementation((params: Record<string, unknown>) => {
      capturedCtx = {
        ...params,
        channelHistories: new Map(),
        logger: { info: vi.fn(), warn: vi.fn() },
        markMessageSeen: () => false,
        shouldDropMismatchedSlackEvent: () => false,
        resolveSlackSystemEventSessionKey: () => "key",
        isChannelAllowed: () => true,
        resolveChannelName: async () => ({}),
        resolveUserName: async () => ({ name: "User" }),
        setSlackThreadStatus: async () => undefined,
      };
      return capturedCtx;
    });

    resolveSlackChannelAllowlistMock.mockImplementation(async () => {
      return [{ input: "general", resolved: true, id: "C001", name: "general" }];
    });

    // Abort after a microtask so resolution has time to settle
    appStartMock.mockImplementation(async () => {
      // Let the void IIFE microtasks resolve
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
    });

    await monitorSlackProvider({
      config: slackConfig,
      runtime: baseRuntime(),
      abortSignal: ac.signal,
    });

    expect(capturedCtx).toBeDefined();
    // provider.ts sets ctx.channelsConfig = nextChannels after resolution
    const channels = capturedCtx!.channelsConfig as Record<string, unknown>;
    expect(channels).toBeDefined();
    // The resolved channel ID "C001" should be present in the updated config
    expect(channels).toHaveProperty("C001");
  });

  it("returns quickly when abortSignal is already aborted", async () => {
    const { monitorSlackProvider } = await import("./provider.js");
    const ac = new AbortController();
    ac.abort();

    // With void pattern, the provider proceeds to app.start() even when
    // pre-aborted, but the abort listener on app.stop() fires and the
    // provider returns quickly. The key assertion is that it doesn't hang.
    await monitorSlackProvider({
      config: slackConfig,
      runtime: baseRuntime(),
      abortSignal: ac.signal,
    });

    // Provider completed without hanging — the abort signal caused early exit
    expect(appStopMock).toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHomeTabState } from "../../home-tab-state.js";

const getSlackHandlers = () =>
  (
    globalThis as {
      __slackHandlers?: Map<string, (args: unknown) => Promise<void>>;
    }
  ).__slackHandlers;
const getSlackClient = () =>
  (globalThis as { __slackClient?: Record<string, unknown> }).__slackClient;

let config: Record<string, unknown> = {};

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
});

vi.mock("../../../auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn(),
}));

vi.mock("../../resolve-channels.js", () => ({
  resolveSlackChannelAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input: string) => ({ input, resolved: false })),
}));

vi.mock("../../resolve-users.js", () => ({
  resolveSlackUserAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input: string) => ({ input, resolved: false })),
}));

vi.mock("../../send.js", () => ({
  sendMessageSlack: vi.fn(),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true }),
}));

vi.mock("../../../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
  updateLastRoute: vi.fn(),
  resolveSessionKey: vi.fn(),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@slack/bolt", () => {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  (globalThis as { __slackHandlers?: typeof handlers }).__slackHandlers = handlers;
  const client = {
    auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user" }) },
    conversations: {
      info: vi.fn().mockResolvedValue({
        channel: { name: "dm", is_im: true },
      }),
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
    users: {
      info: vi.fn().mockResolvedValue({
        user: { profile: { display_name: "Ada" } },
      }),
    },
    views: {
      publish: vi.fn().mockResolvedValue({ ok: true }),
    },
    assistant: {
      threads: {
        setStatus: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
    reactions: {
      add: vi.fn(),
    },
  };
  (globalThis as { __slackClient?: typeof client }).__slackClient = client;
  class App {
    client = client;
    event(name: string, handler: (args: unknown) => Promise<void>) {
      handlers.set(name, handler);
    }
    command() {
      /* no-op */
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  }
  class HTTPReceiver {
    requestListener = vi.fn();
  }
  return { App, HTTPReceiver, default: { App, HTTPReceiver } };
});

const { monitorSlackProvider } = await import("../provider.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForEvent(name: string) {
  for (let i = 0; i < 10; i++) {
    if (getSlackHandlers()?.has(name)) {
      return;
    }
    await flush();
  }
}

describe("app_home_opened event", () => {
  let controller: AbortController;

  beforeEach(() => {
    getSlackHandlers()?.clear();
    controller = new AbortController();
    config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
        },
      },
    };
    const client = getSlackClient() as Record<string, Record<string, { mockClear?: () => void }>>;
    client?.views?.publish?.mockClear?.();
    resetHomeTabState();
  });

  afterEach(() => {
    controller.abort();
  });

  async function setupProvider(overrideConfig?: Record<string, unknown>) {
    if (overrideConfig) {
      config = overrideConfig;
    }
    // Don't await — it runs forever until aborted
    void monitorSlackProvider({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      abortSignal: controller.signal,
    });
    await waitForEvent("app_home_opened");
  }

  async function fireAppHomeOpened(
    eventOverrides: Record<string, unknown> = {},
    bodyOverrides: Record<string, unknown> = {},
  ) {
    const handler = getSlackHandlers()?.get("app_home_opened");
    if (!handler) {
      throw new Error("app_home_opened handler not registered");
    }
    await handler({
      event: {
        type: "app_home_opened",
        user: "U_TEST_USER",
        tab: "home",
        ...eventOverrides,
      },
      body: {
        type: "event_callback",
        api_app_id: "",
        team_id: "",
        ...bodyOverrides,
      },
    });
  }

  it("registers the app_home_opened handler", async () => {
    await setupProvider();
    expect(getSlackHandlers()?.has("app_home_opened")).toBe(true);
  });

  it("publishes default home view on app_home_opened", async () => {
    await setupProvider();
    await fireAppHomeOpened();

    const client = getSlackClient() as { views: { publish: ReturnType<typeof vi.fn> } };
    expect(client.views.publish).toHaveBeenCalledOnce();

    const call = client.views.publish.mock.calls[0][0] as {
      user_id: string;
      view: { type: string; blocks: unknown[] };
    };
    expect(call.user_id).toBe("U_TEST_USER");
    expect(call.view.type).toBe("home");
    expect(call.view.blocks.length).toBeGreaterThan(0);
  });

  it("skips non-home tabs", async () => {
    await setupProvider();
    await fireAppHomeOpened({ tab: "messages" });

    const client = getSlackClient() as { views: { publish: ReturnType<typeof vi.fn> } };
    expect(client.views.publish).not.toHaveBeenCalled();
  });

  it("skips when homeTab is disabled", async () => {
    await setupProvider({
      messages: { responsePrefix: "PFX", ackReactionScope: "group-mentions" },
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
          homeTab: { enabled: false },
        },
      },
    });

    // When disabled, the event handler is not registered at all
    expect(getSlackHandlers()?.has("app_home_opened")).toBe(false);
  });

  it("handles views.publish errors gracefully without throwing", async () => {
    await setupProvider();

    const client = getSlackClient() as { views: { publish: ReturnType<typeof vi.fn> } };
    client.views.publish.mockRejectedValueOnce(new Error("slack_api_error"));

    await expect(fireAppHomeOpened()).resolves.toBeUndefined();
  });

  it("includes header block in published view", async () => {
    await setupProvider();
    await fireAppHomeOpened();

    const client = getSlackClient() as { views: { publish: ReturnType<typeof vi.fn> } };
    const call = client.views.publish.mock.calls[0][0] as {
      view: { blocks: Array<{ type: string }> };
    };
    expect(call.view.blocks[0]).toHaveProperty("type", "header");
  });

  it("passes bot token to views.publish", async () => {
    await setupProvider();
    await fireAppHomeOpened();

    const client = getSlackClient() as { views: { publish: ReturnType<typeof vi.fn> } };
    const call = client.views.publish.mock.calls[0][0] as { token: string };
    expect(call.token).toBe("xoxb-test");
  });

  it("skips republishing for same user when version unchanged", async () => {
    await setupProvider();
    await fireAppHomeOpened();

    const client = getSlackClient() as { views: { publish: ReturnType<typeof vi.fn> } };
    expect(client.views.publish).toHaveBeenCalledOnce();

    // Second open should skip (version cached)
    await fireAppHomeOpened();
    expect(client.views.publish).toHaveBeenCalledOnce();
  });
});

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "../../../../src/plugin-sdk/control-ui-settings.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type { ControlUiPluginDistribution } from "../../plugins/control-ui-distribution.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ChannelsPage } from "./channels-page.tsx";

const packaged = vi.hoisted(() => [] as ControlUiPluginDistribution[]);
vi.mock("../../plugins/control-ui-distribution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/control-ui-distribution.ts")>()),
  controlUiPluginDistributions: packaged,
}));

const mountedPages = new Map<
  HTMLElement,
  { dispose: () => void; replace: (context: ApplicationContext) => void }
>();

function mountPage(context: ApplicationContext): HTMLElement {
  const page = document.createElement("div");
  document.body.append(page);
  const [current, setCurrent] = createSignal(context);
  const mounted = mountSolid(
    () =>
      createComponent(ChannelsPage, {
        get context() {
          return current();
        },
      }),
    { container: page },
  );
  mountedPages.set(page, { dispose: mounted.unmount, replace: setCurrent });
  flush();
  return page;
}

function disposePage(page: HTMLElement) {
  mountedPages.get(page)?.dispose();
  mountedPages.delete(page);
  page.remove();
}

function replacePageContext(page: HTMLElement, context: ApplicationContext) {
  mountedPages.get(page)!.replace(context);
  flush();
}

async function settle() {
  flush();
  await Promise.resolve();
  flush();
}

type TestGateway = ApplicationContext["gateway"] & {
  emit: (patch: Partial<ApplicationGatewaySnapshot>) => void;
};

function createGateway(): TestGateway {
  const client = {
    request: vi.fn(async (method: string) =>
      method === "channels.pairing.list"
        ? {
            accounts: [],
            requests: [],
            commandOwnerConfigured: true,
            limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
          }
        : method === "channels.status"
          ? {
              ts: 0,
              channelOrder: [],
              channelLabels: {},
              channels: {},
              channelAccounts: {},
              channelDefaultAccountId: {},
            }
          : method === "plugins.list"
            ? { plugins: [], diagnostics: [], mutationAllowed: true }
            : {},
    ),
  } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents: () => () => undefined,
    emit(patch: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, patch);
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  } as unknown as TestGateway;
}

function setGatewayScopes(gateway: TestGateway, scopes: string[]) {
  gateway.emit({
    hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
  });
}

function createContext(gateway: ApplicationContext["gateway"]) {
  const channels = createChannelCapability(gateway);
  channels.state.channelsSnapshot = {
    ts: 0,
    channelOrder: [],
    channelLabels: {},
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  runtimeConfig.state.configSnapshot = { config: {}, hash: "test" };
  const ensureSchemaLoaded = vi.spyOn(runtimeConfig, "ensureSchemaLoaded").mockResolvedValue();
  const context = {
    basePath: "",
    resourceBasePath: "",
    gateway,
    channels,
    runtimeConfig,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
  return { context, ensureSchemaLoaded, runtimeConfig, channels };
}

function profileButton(page: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`Missing action: ${label}`);
  }
  return button;
}

async function choosePairingFilter(page: HTMLElement, index: number, value: string) {
  const picker = page.querySelectorAll<HTMLElement>(
    ".channels-pairing-filters openclaw-select-picker",
  )[index]!;
  picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!.click();
  await settle();
  const option = Array.from(picker.querySelectorAll<HTMLElement>("[role=option]")).find(
    (entry) => entry.dataset.value === value,
  );
  expect(option).toBeDefined();
  option!.click();
  await settle();
}

afterEach(() => {
  packaged.length = 0;
  for (const page of mountedPages.keys()) {
    disposePage(page);
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChannelsPage lifecycle", () => {
  it("keeps channel details available but waits for reconnect before starting setup", async () => {
    const gateway = createGateway();
    setGatewayScopes(gateway, ["operator.admin", "operator.read"]);
    const hello = gateway.snapshot.hello;
    const source = createContext(gateway);
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const baseRequest = request.getMockImplementation();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "wizard.start") {
        return {
          done: false,
          status: "running",
          sessionId: "channel-setup",
          step: { id: "token", type: "text", title: "Channel token" },
        };
      }
      return await baseRequest?.(method, params);
    });
    const page = mountPage(source.context);
    await settle();
    expect(profileButton(page, "Set up").disabled).toBe(false);

    for (const phase of ["reconnecting", "offline"] as const) {
      gateway.emit({ phase });
      await settle();
      expect(gateway.snapshot.hello).toBe(hello);
      const setupButtons = Array.from(page.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Set up",
      );
      expect(setupButtons.length).toBeGreaterThan(0);
      for (const button of setupButtons) {
        expect(button.disabled).toBe(true);
        button.click();
      }
      const browse = page.querySelector<HTMLButtonElement>("button.channels-item")!;
      expect(browse.textContent).toContain("More channels");
      expect(browse.disabled).toBe(true);
      browse.click();

      const details = page.querySelector<HTMLButtonElement>(".channels-item__detail")!;
      expect(details.disabled).toBe(false);
      details.click();
      await settle();
      expect(page.querySelector(".channels-detail")).not.toBeNull();
      const runSetup = profileButton(page, "Run setup");
      expect(runSetup.disabled).toBe(true);
      runSetup.click();
      await settle();
      expect(page.querySelector(".channels-wizard")).toBeNull();
      expect(request.mock.calls.filter(([method]) => method === "wizard.start")).toHaveLength(0);
      page.querySelector<HTMLButtonElement>(".channels-detail__close")!.click();
      await settle();
      expect(page.querySelector(".channels-detail")).toBeNull();
    }

    gateway.emit({ phase: "connected" });
    await settle();
    const setup = profileButton(page, "Set up");
    expect(setup.disabled).toBe(false);
    setup.click();
    await waitForSolid(() => {
      expect(page.querySelector("#channel-wizard-text-input")).not.toBeNull();
    });
    expect(request.mock.calls.filter(([method]) => method === "wizard.start")).toHaveLength(1);
    disposePage(page);
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("prefers the exact plugin icon over an earlier owning plugin", async () => {
    const gateway = createGateway();
    gateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
      } as unknown as ApplicationGatewaySnapshot["hello"],
    });
    const source = createContext(gateway);
    source.channels.state.channelsSnapshot = {
      ts: 0,
      channelOrder: ["slack"],
      channelLabels: { slack: "slack" },
      channelDetailLabels: { slack: "Legacy channel subtitle" },
      channels: { slack: { configured: false } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    };
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const baseRequest = request.getMockImplementation();
    const owner = {
      id: "slack-suite",
      name: "Suite",
      installed: true,
      enabled: true,
      state: "enabled",
      hasIcon: true,
      channelIds: ["slack"],
    };
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "plugins.list") {
        return {
          plugins: [
            owner,
            {
              id: "slack",
              name: "Slack",
              description: "OpenClaw Slack channel plugin.",
              origin: "bundled",
              installed: true,
              enabled: false,
              state: "disabled",
              hasIcon: true,
            },
            {
              id: "firecrawl",
              name: "FireCrawl",
              description: "Crawl websites.",
              origin: "global",
              installed: false,
              enabled: false,
              state: "available",
              hasIcon: true,
            },
          ],
          diagnostics: [],
          mutationAllowed: true,
        };
      }
      return await baseRequest?.(method, params);
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:slack-plugin-icon");
    const page = mountPage(source.context);

    await waitForSolid(() => {
      expect(page.querySelector(".settings-row__title")?.textContent).toBe("Slack");
      expect(page.querySelector(".settings-row__desc")?.textContent).toBe(
        "OpenClaw Slack channel plugin.",
      );
      expect(page.querySelector(".channels-item img")?.getAttribute("src")).toBe(
        "blob:slack-plugin-icon",
      );
    });
    expect(request).toHaveBeenCalledWith("plugins.list", {}, expect.any(Object));
    expect(
      fetchMock.mock.calls
        .map(([input]) =>
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        )
        .filter((url) => url.includes("/__openclaw__/plugin-icon/")),
    ).toEqual(["/__openclaw__/plugin-icon/slack"]);
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("loads an icon when channel status arrives after plugin metadata", async () => {
    const gateway = createGateway();
    gateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
      } as unknown as ApplicationGatewaySnapshot["hello"],
    });
    const source = createContext(gateway);
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const baseRequest = request.getMockImplementation();
    let includeMattermost = false;
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "plugins.list") {
        return {
          plugins: [
            {
              id: "mattermost",
              name: "Mattermost",
              description: "OpenClaw Mattermost channel plugin.",
              origin: "bundled",
              installed: true,
              enabled: true,
              state: "loaded",
              hasIcon: true,
            },
          ],
          diagnostics: [],
          mutationAllowed: true,
        };
      }
      if (method === "channels.status" && includeMattermost) {
        return {
          ts: 1,
          channelOrder: ["mattermost"],
          channelLabels: { mattermost: "Mattermost" },
          channels: { mattermost: { configured: true } },
          channelAccounts: {},
          channelDefaultAccountId: {},
        };
      }
      return await baseRequest?.(method, params);
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mattermost-plugin-icon");
    const page = mountPage(source.context);

    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("plugins.list", {}, expect.any(Object)),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    includeMattermost = true;
    await source.channels.refresh(false);

    await waitForSolid(() => {
      expect(page.querySelector(".settings-row__title")?.textContent).toBe("Mattermost");
      expect(page.querySelector(".channels-item img")?.getAttribute("src")).toBe(
        "blob:mattermost-plugin-icon",
      );
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("loads a channel icon through its distinct owning plugin id", async () => {
    const gateway = createGateway();
    gateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
      } as unknown as ApplicationGatewaySnapshot["hello"],
    });
    const source = createContext(gateway);
    source.channels.state.channelsSnapshot = {
      ts: 0,
      channelOrder: ["agent-system-github"],
      channelLabels: { "agent-system-github": "GitHub Notifications" },
      channelDetailLabels: { "agent-system-github": "GitHub notification channel" },
      channels: { "agent-system-github": { configured: false } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    };
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const baseRequest = request.getMockImplementation();
    let includeSecondChannel = false;
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "plugins.list") {
        return {
          plugins: [
            {
              id: "agent-system",
              name: "Agent System",
              description: "Manage agent workspaces.",
              origin: "global",
              installed: true,
              enabled: true,
              state: "enabled",
              hasIcon: true,
              channelIds: ["agent-system-github", "agent-system-chat"],
            },
          ],
          diagnostics: [],
          mutationAllowed: true,
        };
      }
      if (method === "channels.status" && includeSecondChannel) {
        return {
          ts: 1,
          channelOrder: ["agent-system-github", "agent-system-chat"],
          channelLabels: {
            "agent-system-github": "GitHub Notifications",
            "agent-system-chat": "Project Chat",
          },
          channelDetailLabels: {
            "agent-system-github": "GitHub notification channel",
            "agent-system-chat": "Project conversations",
          },
          channels: {
            "agent-system-github": { configured: false },
            "agent-system-chat": { configured: false },
          },
          channelAccounts: {},
          channelDefaultAccountId: {},
        };
      }
      return await baseRequest?.(method, params);
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:agent-system-plugin-icon")
      .mockReturnValue("blob:duplicate-plugin-icon");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const page = mountPage(source.context);

    await waitForSolid(() => {
      expect(page.querySelector(".settings-row__title")?.textContent).toBe("GitHub Notifications");
      expect(page.querySelector(".settings-row__desc")?.textContent).toBe(
        "GitHub notification channel",
      );
      expect(page.querySelector(".channels-item img")?.getAttribute("src")).toBe(
        "blob:agent-system-plugin-icon",
      );
    });
    expect(
      fetchMock.mock.calls
        .map(([input]) =>
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        )
        .filter((url) => url.includes("/__openclaw__/plugin-icon/")),
    ).toEqual(["/__openclaw__/plugin-icon/agent-system"]);
    includeSecondChannel = true;
    await source.channels.refresh(false);
    await waitForSolid(() => {
      expect(
        ["GitHub Notifications", "Project Chat"].map((label) => {
          const row = Array.from(page.querySelectorAll(".channels-item")).find(
            (item) => item.querySelector(".settings-row__title")?.textContent === label,
          );
          return row?.querySelector("img")?.getAttribute("src");
        }),
      ).toEqual(["blob:agent-system-plugin-icon", "blob:agent-system-plugin-icon"]);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    disposePage(page);
    expect(revoke.mock.calls).toEqual([["blob:agent-system-plugin-icon"]]);
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it.each(["disconnect", "timeout"])(
    "cancels the owning plugin icon request on %s",
    async (cause) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const gateway = createGateway();
      const source = createContext(gateway);
      source.channels.state.channelsSnapshot = {
        ts: 0,
        channelOrder: ["agent-system-github"],
        channelLabels: { "agent-system-github": "GitHub Notifications" },
        channels: { "agent-system-github": { configured: false } },
        channelAccounts: {},
        channelDefaultAccountId: {},
      };
      const request = vi.spyOn(gateway.snapshot.client!, "request");
      const baseRequest = request.getMockImplementation();
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === "plugins.list") {
          return {
            plugins: [
              {
                id: "agent-system",
                name: "Agent System",
                installed: true,
                enabled: true,
                state: "enabled",
                hasIcon: true,
                channelIds: ["agent-system-github"],
              },
            ],
            diagnostics: [],
            mutationAllowed: true,
          };
        }
        return await baseRequest?.(method, params);
      });
      const aborted = createDeferred<unknown>();
      const fetchMock = vi.fn<typeof fetch>(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              throw new Error("Expected icon request AbortSignal");
            }
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve(signal.reason);
                reject(new DOMException("The operation was aborted.", "AbortError"));
              },
              { once: true },
            );
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const createUrl = vi.spyOn(URL, "createObjectURL");
      const page = mountPage(source.context);
      await waitForSolid(() => expect(fetchMock).toHaveBeenCalledOnce());
      if (cause === "disconnect") {
        gateway.emit({ phase: "stopped" });
      } else {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(await aborted.promise).toMatchObject({
        name: cause === "disconnect" ? "AbortError" : "TimeoutError",
      });
      expect(createUrl).not.toHaveBeenCalled();
      disposePage(page);
      source.runtimeConfig.dispose();
      source.channels.dispose();
    },
  );

  it("polls pairing only while visible, authorized, and mounted", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const gateway = createGateway();
    setGatewayScopes(gateway, ["operator.pairing"]);
    const source = createContext(gateway);
    const refreshPairing = vi.spyOn(source.channels, "refreshPairing").mockResolvedValue();
    const page = mountPage(source.context);
    await settle();
    refreshPairing.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshPairing).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshPairing).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refreshPairing).toHaveBeenCalledTimes(2);

    setGatewayScopes(gateway, ["operator.read"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshPairing).toHaveBeenCalledTimes(2);
    setGatewayScopes(gateway, ["operator.pairing"]);
    await settle();
    refreshPairing.mockClear();
    disposePage(page);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshPairing).not.toHaveBeenCalled();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("refreshes pairing data when the authorized scope set changes", async () => {
    const gateway = createGateway();
    setGatewayScopes(gateway, ["operator.pairing"]);
    const source = createContext(gateway);
    source.channels.state.pairingSnapshot = {
      accounts: [
        {
          channel: "whatsapp",
          channelLabel: "WhatsApp",
          accountId: "personal",
          accountLabel: "Personal",
          notifySupported: true,
        },
      ],
      requests: [
        {
          channel: "whatsapp",
          channelLabel: "WhatsApp",
          accountId: "personal",
          accountLabel: "Personal",
          requestId: "pending-1",
          senderId: "sender-1",
          senderLabel: "Sender",
          createdAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-01T00:00:00Z",
          expiresAt: "2026-01-02T00:00:00Z",
          notifySupported: true,
        },
      ],
      commandOwnerConfigured: true,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    };
    const refreshPairing = vi.spyOn(source.channels, "refreshPairing");
    const page = mountPage(source.context);
    await settle();
    refreshPairing.mockClear();
    await choosePairingFilter(page, 0, "whatsapp");
    await choosePairingFilter(page, 1, "personal");
    expect(
      page.querySelectorAll(".channels-pairing-filters .picker-select__trigger")[0]?.textContent,
    ).toContain("WhatsApp");
    expect(
      page.querySelectorAll(".channels-pairing-filters .picker-select__trigger")[1]?.textContent,
    ).toContain("Personal");
    profileButton(page, "Approve").click();
    await settle();
    expect(page.querySelector(".channels-pairing-dialog")).not.toBeNull();

    setGatewayScopes(gateway, ["operator.pairing", "operator.read"]);

    await waitForSolid(() => {
      expect(refreshPairing).toHaveBeenCalled();
      expect(source.channels.state.pairingSnapshot).not.toBeNull();
    });
    await updatePickers(page);
    expect(page.querySelector(".channels-pairing-dialog")).toBeNull();
    const filters = page.querySelectorAll(".channels-pairing-filters .picker-select__trigger");
    expect(filters[0]?.textContent).toContain("All channels");
    expect(filters[1]?.textContent).toContain("All accounts");
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("keeps rejected channel configuration visible in its editor without reloading the draft", async () => {
    const gateway = createGateway();
    gateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
        features: { methods: ["config.set", "config.schema"] },
      } as unknown as ApplicationGatewaySnapshot["hello"],
    });
    const source = createContext(gateway);
    const config = { channels: { whatsapp: { enabled: true } } };
    const channel = {
      configured: true,
      linked: true,
      running: true,
      connected: true,
      reconnectAttempts: 0,
    };
    source.channels.state.channelsSnapshot = {
      ts: 0,
      channelOrder: ["whatsapp"],
      channelLabels: { whatsapp: "WhatsApp" },
      channels: { whatsapp: channel },
      channelAccounts: {},
      channelDefaultAccountId: {},
    };
    source.channels.state.pairingSnapshot = {
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    };
    Object.assign(source.runtimeConfig.state, {
      configSnapshot: { config, hash: "test", raw: JSON.stringify(config) },
      configForm: structuredClone(config),
      configFormOriginal: structuredClone(config),
      configDraftBaseHash: "test",
      configSchema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              whatsapp: {
                type: "object",
                properties: { enabled: { type: "boolean", title: "Enabled" } },
              },
            },
          },
        },
      },
      configUiHints: { "channels.whatsapp.enabled": { advanced: false } },
    });
    const refreshConfig = vi.spyOn(source.runtimeConfig, "refresh");
    const refreshChannels = vi.spyOn(source.channels, "refresh");
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const baseRequest = request.getMockImplementation();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "config.set") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message:
            "channel rejected: OPENAI_API_KEY=sk-1234567890abcdef <img src=x onerror=alert(1)>",
        });
      }
      return await baseRequest?.(method, params);
    });
    const page = mountPage(source.context);
    await settle();

    page.querySelector<HTMLButtonElement>(".channels-item")!.click();
    await settle();
    source.runtimeConfig.patchForm(["channels", "whatsapp", "enabled"], false);
    await settle();
    const save = page.querySelector<HTMLButtonElement>(".channels-detail .btn.primary")!;
    expect(save.disabled).toBe(false);
    save.click();

    await waitForSolid(() => {
      const alert = page.querySelector<HTMLElement>(".channels-detail [role=alert]");
      expect(alert?.textContent).toContain("channel rejected");
      expect(alert?.textContent).toContain("OPENAI_API_KEY=sk-123...cdef");
      expect(alert?.textContent).not.toContain("sk-1234567890abcdef");
      expect(alert?.querySelector("img")).toBeNull();
    });
    expect(source.runtimeConfig.state.configFormDirty).toBe(true);
    expect(source.runtimeConfig.state.configForm).toEqual({
      channels: { whatsapp: { enabled: false } },
    });
    expect(refreshConfig).not.toHaveBeenCalled();
    expect(refreshChannels).not.toHaveBeenCalled();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });
});

async function mountPackagedChannel() {
  const placement = { section: "channels", panel: "detail", channelId: "custom-profile" } as const;
  packaged.push({
    pluginId: "profile-fixture",
    revision: "fixture-revision",
    bundledDistribution: { packageName: "profile-fixture", packageVersion: "1.0.0" },
    entry: "/fixture/index.js",
    styles: [],
    imports: [],
    activation: "settings-only",
    settingsViews: [placement],
  });
  const gateway = createGateway();
  gateway.connection.token = "saved-token";
  gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 3,
    auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "device-token" },
  };
  const source = createContext(gateway);
  const refresh = vi.spyOn(source.channels, "refresh").mockResolvedValue();
  source.channels.state.channelsSnapshot = {
    ts: 0,
    channelOrder: ["custom-profile", "other"],
    channelLabels: { "custom-profile": "Custom profile", other: "Other" },
    channels: { "custom-profile": { configured: true }, other: { configured: true } },
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
  const mounts: Array<{
    context: ControlUiChannelSettingsContext;
    input: HTMLInputElement;
    update: ReturnType<typeof vi.fn<(props: ControlUiChannelSettingsSnapshot) => void>>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  // This synthetic view only records host lifetime/snapshot wiring; real plugin rendering is covered by its own tests and packaged E2E.
  Object.assign(source.context, {
    plugins: {
      loadSettingsView: vi.fn(async (_placement, signal: AbortSignal) => ({
        signal,
        dispose: vi.fn(),
        view: {
          placement,
          mount(container: HTMLElement, context: ControlUiChannelSettingsContext) {
            const input = document.createElement("input");
            input.dataset.pluginDraft = "true";
            container.append(input);
            const mounted = {
              context,
              input,
              update: vi.fn<(props: ControlUiChannelSettingsSnapshot) => void>(),
              dispose: vi.fn(() => input.remove()),
            };
            mounts.push(mounted);
            return mounted;
          },
        },
      })),
    },
  });
  const page = mountPage(source.context);
  async function open(label = "Custom profile") {
    const channel = [
      ...page.querySelectorAll<HTMLButtonElement>(
        "button.channels-item, button.channels-item__detail",
      ),
    ].find((node) => node.textContent?.includes(label));
    expect(channel).toBeDefined();
    channel!.click();
    await settle();
  }
  await open();
  await waitForSolid(() => expect(mounts).toHaveLength(1));
  return { gateway, source, refresh, page, mounts, open, context: mounts[0]!.context };
}
const profileRequest = (signal = new AbortController().signal) => ({
  accountId: "main/account",
  path: ["profile"],
  method: "PUT" as const,
  body: { name: "Example" },
  signal,
});

it("retains a packaged editor and its pending request across detail close, another channel, and reopen", async () => {
  const pending = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
  vi.stubGlobal("fetch", fetchMock);
  const f = await mountPackagedChannel();
  const original = f.mounts[0]!;
  original.input.value = "Retained draft";
  const request = f.context.request(profileRequest());
  f.page.querySelector<HTMLButtonElement>(".channels-detail__close")!.click();
  await settle();
  expect(original.context.signal.aborted).toBe(false);
  expect(original.update).toHaveBeenLastCalledWith(expect.objectContaining({ presented: false }));
  await f.open("Other");
  f.page.querySelector<HTMLButtonElement>(".channels-detail__close")!.click();
  await settle();
  pending.resolve(Response.json({ ok: true }));
  await expect(request).resolves.toMatchObject({ ok: true });
  await f.open();
  expect(f.mounts).toHaveLength(1);
  expect(f.page.querySelector("[data-plugin-draft]")).toBe(original.input);
  expect(original.input.value).toBe("Retained draft");
  expect(original.update).toHaveBeenLastCalledWith(expect.objectContaining({ presented: true }));
  f.source.runtimeConfig.dispose();
  f.source.channels.dispose();
});

it("retires a real host configuration slot and rejects mounting through its old context", async () => {
  const f = await mountPackagedChannel();
  const container = document.createElement("div");
  f.mounts[0]!.input.parentElement!.append(container);
  const dispose = f.context.mountConfig(container);
  await waitForSolid(() => expect(container.textContent).toContain("Reload"));
  f.gateway.emit({ client: createGateway().snapshot.client });
  expect(f.context.signal.aborted).toBe(true);
  expect(container.childNodes).toHaveLength(0);
  expect(() => f.context.mountConfig(container)).toThrow();
  expect(() => {
    dispose();
    dispose();
  }).not.toThrow();
  f.source.runtimeConfig.dispose();
  f.source.channels.dispose();
});

it("retains the editor across same-client reconnects and synchronously publishes the new transport epoch", async () => {
  const f = await mountPackagedChannel();
  const original = f.mounts[0]!;
  original.input.value = "Draft";
  const hello = f.gateway.snapshot.hello;
  f.gateway.emit({ phase: "reconnecting", hello: null });
  expect(original.context.signal.aborted).toBe(false);
  expect(original.update).toHaveBeenLastCalledWith(expect.objectContaining({ connected: false }));
  f.gateway.emit({ phase: "connected", hello });
  await settle();
  expect(f.mounts).toHaveLength(1);
  expect(original.input.value).toBe("Draft");
  expect(original.update).toHaveBeenLastCalledWith(expect.objectContaining({ connected: true }));
  f.source.runtimeConfig.dispose();
  f.source.channels.dispose();
});

it.each(["disconnect", "client", "admin", "source", "unmount", "caller"] as const)(
  "rejects retained HTTP callbacks and pending responses after %s retirement before another credential dispatch",
  async (retirement) => {
    const pending = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const f = await mountPackagedChannel();
    const caller = new AbortController();
    const request = f.context.request(profileRequest(caller.signal));
    const rejection = expect(request).rejects.toThrow();
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    let second: ReturnType<typeof createContext> | undefined;
    if (retirement === "disconnect") {
      f.gateway.emit({ phase: "stopped" });
    } else if (retirement === "client") {
      f.gateway.connection.token = "rotated-token";
      f.gateway.emit({ client: createGateway().snapshot.client });
    } else if (retirement === "admin") {
      setGatewayScopes(f.gateway, ["operator.read"]);
    } else if (retirement === "source") {
      second = createContext(f.gateway);
      Object.assign(second.context, { plugins: f.source.context.plugins });
      replacePageContext(f.page, second.context);
    } else if (retirement === "unmount") {
      disposePage(f.page);
    } else {
      caller.abort();
    }
    expect(signal.aborted).toBe(true);
    await expect(
      f.context.request(profileRequest(retirement === "caller" ? caller.signal : undefined)),
    ).rejects.toThrow();
    pending.resolve(Response.json({ error: "Unauthorized" }, { status: 401 }));
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    if (retirement !== "disconnect" && retirement !== "caller") {
      expect(f.mounts[0]!.dispose).toHaveBeenCalledOnce();
    }
    f.source.runtimeConfig.dispose();
    f.source.channels.dispose();
    second?.runtimeConfig.dispose();
    second?.channels.dispose();
  },
);

it("checks operation authority after consuming a successful response body", async () => {
  const body = createDeferred<unknown>();
  const reading = createDeferred();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json() {
        reading.resolve();
        return body.promise;
      },
    } as Response),
  );
  const f = await mountPackagedChannel();
  const request = f.context.request(profileRequest());
  const rejection = expect(request).rejects.toThrow();
  await reading.promise;
  f.gateway.emit({ phase: "stopped" });
  body.resolve({ ok: true });
  await rejection;
  f.source.runtimeConfig.dispose();
  f.source.channels.dispose();
});

it.each([
  [401, 200],
  [401, 401],
  [403, 200],
  [401, 503],
] as const)(
  "keeps captured credential fallback and sanitized HTTP details for %s then %s",
  async (first, second) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: first === 403 ? "Forbidden" : "Unauthorized" } },
          { status: first },
        ),
      )
      .mockResolvedValueOnce(
        second === 200
          ? Response.json({ ok: true, persisted: true })
          : second === 503
            ? new Response("gateway unavailable", { status: second })
            : Response.json({ error: { message: "Unauthorized" } }, { status: second }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const f = await mountPackagedChannel();
    const result = await f.context.request(profileRequest());
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(
      first === 403 ? ["Bearer device-token"] : ["Bearer device-token", "Bearer saved-token"],
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/channels/custom-profile/main%2Faccount/profile");
    expect(result.status).toBe(first === 403 ? 403 : second);
    if (first === 403 || second !== 200) {
      expect(result.errorMessage).toBe(
        first === 403
          ? "HTTP 403: Forbidden"
          : second === 503
            ? "HTTP 503"
            : "HTTP 401: Unauthorized",
      );
    }
    f.source.runtimeConfig.dispose();
    f.source.channels.dispose();
  },
);

it("keeps a caller deadline across credential retry and response-body consumption", async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      async () =>
        await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(null, { status: 401 })), 15_000);
        }),
    )
    .mockImplementation(
      async (_url, init) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init!.signal!.addEventListener(
                "abort",
                () => {
                  try {
                    init!.signal!.throwIfAborted();
                  } catch (error) {
                    reject(
                      error instanceof Error || error instanceof DOMException
                        ? error
                        : new Error("Unexpected abort reason", { cause: error }),
                    );
                  }
                },
                { once: true },
              );
            }),
        }) as Response,
    );
  vi.stubGlobal("fetch", fetchMock);
  const f = await mountPackagedChannel();
  const caller = new AbortController();
  const timer = setTimeout(
    () => caller.abort(new DOMException("Deadline", "TimeoutError")),
    30_000,
  );
  const request = f.context.request(profileRequest(caller.signal));
  const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(fetchMock).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(fetchMock.mock.calls[1]![1]!.signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  expect(fetchMock.mock.calls[0]![1]!.signal).toBe(fetchMock.mock.calls[1]![1]!.signal);
  clearTimeout(timer);
  f.source.runtimeConfig.dispose();
  f.source.channels.dispose();
});

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ChannelsPage } from "./channels-page.tsx";

const NOSTR_PROFILE_REQUEST_TIMEOUT_MS = 30_000;

type ChannelsPageTestElement = HTMLElement;
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
        host: page,
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

function stubHangingFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("Expected Nostr profile request to carry an AbortSignal");
        }
        signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = signal.reason;
            if (!(reason instanceof DOMException)) {
              throw new Error("Expected profile timeout to abort with a DOMException");
            }
            reject(reason);
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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

async function editProfileName(page: ChannelsPageTestElement, value: string) {
  const name = page.querySelector<HTMLInputElement>("#nostr-profile-name");
  if (!name) {
    throw new Error("Missing profile name");
  }
  name.value = value;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

async function mountNostrProfile() {
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
    channelOrder: ["nostr"],
    channelLabels: { nostr: "Nostr" },
    channels: { nostr: { configured: true, profile: { name: "Alice" } } },
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
  const page = mountPage(source.context);
  await settle();
  const channel = page.querySelector<HTMLButtonElement>(".channels-item");
  if (!channel) {
    throw new Error("Missing Nostr channel");
  }
  channel.click();
  await settle();
  profileButton(page, "Edit Profile").click();
  await settle();
  await editProfileName(page, "Alice Updated");
  return { gateway, source, refresh, page };
}

afterEach(() => {
  for (const page of mountedPages.keys()) {
    disposePage(page);
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChannelsPage lifecycle", () => {
  it.each(["Imported name", null])(
    "openclaw-channels-page Import from Relays preserves profile name %s with extra fields",
    async (name) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            ok: true,
            saved: true,
            merged: { name, displayName: "Imported display", extra: { value: true } },
          }),
        ),
      );
      const { source, page } = await mountNostrProfile();
      profileButton(page, "Import from Relays").click();
      await waitForSolid(() => expect(page.textContent).toContain("Profile imported"));
      expect(page.querySelector<HTMLInputElement>("#nostr-profile-name")?.value).toBe(name ?? "");
      expect(page.querySelector<HTMLInputElement>("#nostr-profile-displayName")?.value).toBe(
        "Imported display",
      );
      source.runtimeConfig.dispose();
      source.channels.dispose();
    },
  );

  it("openclaw-channels-page Save & Publish preserves HTTP validation details", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { ok: false, error: "Validation failed", details: ["name: Name is too long"] },
          { status: 400 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { source, page } = await mountNostrProfile();
    profileButton(page, "Save & Publish").click();
    await waitForSolid(() => expect(page.textContent).toContain("HTTP 400: Validation failed"));
    expect(page.textContent).toContain("Name is too long");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it.each([
    ["Save & Publish", 401, 200],
    ["Import from Relays", 401, 200],
    ["Save & Publish", 401, 401],
    ["Import from Relays", 401, 401],
    ["Save & Publish", 403, 200],
    ["Import from Relays", 403, 200],
    ["Save & Publish", 401, 503],
    ["Import from Relays", 401, 503],
  ] as const)(
    "openclaw-channels-page %s handles credentials and HTTP errors after %s then %s",
    async (action, firstStatus, nextStatus) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { error: { message: firstStatus === 403 ? "Forbidden" : "Unauthorized" } },
            { status: firstStatus },
          ),
        )
        .mockResolvedValueOnce(
          nextStatus === 200
            ? Response.json({ ok: true, persisted: true, saved: true, merged: { name: "Alice" } })
            : nextStatus === 503
              ? new Response("gateway unavailable", { status: 503 })
              : Response.json({ error: { message: "Unauthorized" } }, { status: nextStatus }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const { source, page } = await mountNostrProfile();
      profileButton(page, action).click();
      const recovered = firstStatus === 401 && nextStatus === 200;
      await waitForSolid(() =>
        expect(page.textContent).toContain(
          recovered
            ? action === "Save & Publish"
              ? "Profile published"
              : "Profile imported"
            : "Last error",
        ),
      );
      expect(
        fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
      ).toEqual(
        firstStatus === 403
          ? ["Bearer device-token"]
          : ["Bearer device-token", "Bearer saved-token"],
      );
      if (!recovered) {
        expect(page.textContent).toContain(
          firstStatus === 403
            ? "HTTP 403: Forbidden"
            : nextStatus === 503
              ? "HTTP 503"
              : "HTTP 401: Unauthorized",
        );
      }
      source.runtimeConfig.dispose();
      source.channels.dispose();
    },
  );

  it.each([false, true])(
    "prefers the exact plugin icon with owner first: %s",
    async (ownerFirst) => {
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
              ...(ownerFirst ? [owner] : []),
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
              ...(ownerFirst ? [] : [owner]),
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
    },
  );

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

  it("loads schema again when the runtime-config source changes", async () => {
    const gateway = createGateway();
    const first = createContext(gateway);
    const second = createContext(gateway);
    const page = mountPage(first.context);

    await waitForSolid(() => expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce());

    replacePageContext(page, second.context);
    await settle();

    await waitForSolid(() => expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce());

    first.runtimeConfig.dispose();
    second.runtimeConfig.dispose();
    first.channels.dispose();
    second.channels.dispose();
  });

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

  it.each([
    ["Save & Publish", "source replacement", 200],
    ["Save & Publish", "source replacement", 401],
    ["Import from Relays", "disconnect", 200],
    ["Import from Relays", "disconnect", 401],
    ["Import from Relays", "cancel", 401],
    ["Import from Relays", "replacement form", 200],
    ["Import from Relays", "replacement form", 401],
    ["Save & Publish", "credential/client replacement", 401],
    ["Import from Relays", "credential/client replacement", 401],
    ["Save & Publish", "unmount", 401],
    ["Import from Relays", "unmount", 401],
  ] as const)(
    "retires rendered %s after %s before pending %s",
    async (action, retirement, status) => {
      vi.useFakeTimers();
      const response = createDeferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      const { gateway, source, refresh, page } = await mountNostrProfile();
      const second = createContext(gateway);
      const secondRefresh = vi.spyOn(second.channels, "refresh").mockResolvedValue();
      profileButton(page, action).click();
      await settle();
      expect(fetchMock).toHaveBeenCalledOnce();

      switch (retirement) {
        case "source replacement":
          replacePageContext(page, second.context);
          break;
        case "disconnect":
          gateway.emit({ phase: "stopped" });
          break;
        case "cancel":
        case "replacement form":
          expect(profileButton(page, "Cancel").disabled).toBe(false);
          profileButton(page, "Cancel").click();
          break;
        case "credential/client replacement":
          gateway.connection.token = "rotated-token";
          gateway.emit({ client: createGateway().snapshot.client });
          break;
        case "unmount":
          disposePage(page);
          break;
      }
      await settle();
      expect(page.querySelector("#nostr-profile-name")).toBeNull();
      if (retirement === "replacement form") {
        profileButton(page, "Edit Profile").click();
        await settle();
        await editProfileName(page, "Fresh draft");
      }
      if (retirement === "credential/client replacement") {
        await vi.advanceTimersByTimeAsync(0);
        // Reconnection refreshes the new client before the retired request settles.
        refresh.mockClear();
        secondRefresh.mockClear();
      }
      response.resolve(
        Response.json(
          { ok: true, persisted: true, saved: true, merged: { name: "Stale import" } },
          { status },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await settle();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();
      expect(secondRefresh).not.toHaveBeenCalled();
      expect(page.textContent).not.toContain("Profile published");
      expect(page.textContent).not.toContain("Profile imported");
      expect(page.textContent).not.toContain("Last error");
      if (retirement === "replacement form") {
        expect(page.querySelector<HTMLInputElement>("#nostr-profile-name")?.value).toBe(
          "Fresh draft",
        );
        expect(profileButton(page, "Import from Relays").disabled).toBe(false);
      } else {
        expect(page.querySelector("#nostr-profile-name")).toBeNull();
      }
      source.runtimeConfig.dispose();
      source.channels.dispose();
      second.runtimeConfig.dispose();
      second.channels.dispose();
    },
  );

  it.each([
    ["Save & Publish", false],
    ["Save & Publish", true],
    ["Import from Relays", false],
    ["Import from Relays", true],
  ] as const)("times out rendered %s at 30 seconds with retry %s", async (action, retry) => {
    vi.useFakeTimers();
    const fetchMock = stubHangingFetch();
    if (retry) {
      fetchMock.mockImplementationOnce(
        async () =>
          await new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response(null, { status: 401 })), 15_000);
          }),
      );
    }
    const { source, refresh, page } = await mountNostrProfile();
    profileButton(page, action).click();
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(retry ? 2 : 1);
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(retry ? ["Bearer device-token", "Bearer saved-token"] : ["Bearer device-token"]);
    await vi.advanceTimersByTimeAsync(NOSTR_PROFILE_REQUEST_TIMEOUT_MS - 15_001);
    expect(page.textContent).not.toContain("Request timed out");
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    expect(profileButton(page, action).disabled).toBe(false);
    expect(page.textContent).toContain(
      "Request timed out after 30 seconds; the server may still have applied the change — check the profile before retrying.",
    );
    expect(refresh).not.toHaveBeenCalled();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });
});

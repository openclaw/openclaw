import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "../../../../src/plugin-sdk/control-ui-settings.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import type { ControlUiPluginDistribution } from "../../plugins/control-ui-distribution.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  catalogFixture,
  channelSnapshot,
  createContext,
  createGateway,
  choosePairingFilter,
  profileButton,
  setGatewayScopes,
  sources,
  channelStatus,
  iconRequests,
  mockIcon,
  plugin,
} from "./channels-page.test-support.ts";
import { ChannelsPage } from "./channels-page.tsx";
import { pairingSnapshot } from "./pairing.test-support.ts";

const packaged = vi.hoisted(() => [] as ControlUiPluginDistribution[]);
vi.mock("../../plugins/control-ui-distribution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/control-ui-distribution.ts")>()),
  controlUiPluginDistributions: packaged,
}));

const mountedPages = new Map<HTMLElement, () => void>();

function mountPage(context: ApplicationContext): HTMLElement {
  const page = document.createElement("div");
  document.body.append(page);
  const mounted = mountSolid(
    () =>
      createComponent(ApplicationProvider, {
        value: context,
        get children() {
          return createComponent(ChannelsPage, {});
        },
      }),
    { container: page },
  );
  mountedPages.set(page, mounted.unmount);
  flush();
  return page;
}

function disposePage(page: HTMLElement) {
  mountedPages.get(page)?.();
  mountedPages.delete(page);
  page.remove();
}

async function settle() {
  flush();
  await Promise.resolve();
  flush();
}

afterEach(() => {
  packaged.length = 0;
  for (const page of mountedPages.keys()) {
    disposePage(page);
  }
  for (const source of sources.splice(0)) {
    source.runtimeConfig.dispose();
    source.channels.dispose();
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChannelsPage lifecycle", () => {
  it.each(["answer", "close"])(
    "keeps a held wizard answer with its %s outcome",
    async (outcome) => {
      const starting = createDeferred<Record<string, unknown>>();
      const pending = createDeferred<Record<string, unknown>>();
      const step = { id: "token", type: "text", title: "Channel token" };
      const gateway = createGateway(["operator.admin", "operator.read"], {
        "wizard.start": () => starting.promise,
        "wizard.next": () => pending.promise,
      });
      const source = createContext(gateway);
      const page = mountPage(source.context);
      await settle();
      profileButton(page, "Set up").click();
      await settle();
      starting.resolve({ done: false, sessionId: "setup", step });
      await waitForSolid(() =>
        expect(page.querySelector("#channel-wizard-text-input")).not.toBeNull(),
      );
      await waitForSolid(() => expect(page.querySelector("dialog")?.open).toBe(true));
      const input = page.querySelector<HTMLInputElement>("#channel-wizard-text-input")!;
      input.value = "Draft token";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      profileButton(page, "Continue").click();
      await waitForSolid(() => expect(input.disabled).toBe(true));
      expect(page.querySelector("#channel-wizard-text-input")).toBe(input);
      if (outcome === "close") {
        page.querySelector("openclaw-modal-dialog")!.dispatchEvent(new Event("modal-cancel"));
        await waitForSolid(() => expect(page.querySelector(".channels-wizard")).toBeNull());
      }
      pending.resolve({ done: false, step: { ...step }, error: "Try another token" });
      if (outcome === "close") {
        await settle();
        expect(page.querySelector(".channels-wizard")).toBeNull();
      } else {
        await waitForSolid(() => expect(input.disabled).toBe(false));
        expect(page.querySelector("#channel-wizard-text-input")).toBe(input);
        expect(input.value).toBe("Draft token");
        expect(page.textContent).toContain("Try another token");
      }
    },
  );

  it("keeps channel details available but waits for reconnect before starting setup", async () => {
    const gateway = createGateway(["operator.admin", "operator.read"], {
      "wizard.start": () => ({
        done: false,
        status: "running",
        sessionId: "channel-setup",
        step: { id: "token", type: "text", title: "Channel token" },
      }),
    });
    const hello = gateway.snapshot.hello;
    const source = createContext(gateway);
    const request = vi.spyOn(gateway.snapshot.client!, "request");
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
    await settle();
    expect(request).toHaveBeenCalledWith("wizard.cancel", {
      sessionId: "channel-setup",
      closeInput: true,
    });
  });

  it.each([
    { name: "exact icon over an earlier owning plugin", late: false },
    { name: "icon after late channel status", late: true },
  ])("loads $name", async ({ late }) => {
    const id = late ? "mattermost" : "slack";
    const label = late ? "Mattermost" : "Slack";
    const plugins: object[] = [
      {
        ...plugin(id, label),
        origin: "bundled",
        enabled: late,
        state: late ? "loaded" : "disabled",
        description: `OpenClaw ${label} channel plugin.`,
      },
    ];
    if (!late) {
      plugins.unshift(plugin("slack-suite", "Suite", { channelIds: ["slack"] }));
      plugins.push({
        id: "firecrawl",
        name: "FireCrawl",
        origin: "global",
        description: "Crawl websites.",
        installed: false,
        enabled: false,
        state: "available",
        hasIcon: true,
      });
    }
    const snapshot = {
      ...channelStatus(
        id,
        late ? label : "slack",
        late,
        late ? undefined : "Legacy channel subtitle",
      ),
      ts: late ? 1 : 0,
    };
    const { source, request, refresh } = catalogFixture(
      plugins,
      late ? channelSnapshot() : snapshot,
      ["operator.admin", "operator.read"],
    );
    const icon = `blob:${id}-plugin-icon`;
    const fetchMock = mockIcon(icon);
    const page = mountPage(source.context);
    if (late) {
      await waitForSolid(() =>
        expect(request).toHaveBeenCalledWith("plugins.list", {}, expect.any(Object)),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      await refresh(snapshot);
    }
    await waitForSolid(() => {
      expect(page.querySelector(".settings-row__title")?.textContent).toBe(label);
      expect(page.querySelector(".channels-item img")?.getAttribute("src")).toBe(icon);
      if (!late) {
        expect(page.querySelector(".settings-row__desc")?.textContent).toBe(
          "OpenClaw Slack channel plugin.",
        );
      }
    });
    expect(request).toHaveBeenCalledWith("plugins.list", {}, expect.any(Object));
    expect(iconRequests(fetchMock)).toEqual([`/__openclaw__/plugin-icon/${id}`]);
    if (late) {
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it("loads a channel icon through its distinct owning plugin id", async () => {
    const { source, refresh } = catalogFixture(
      [
        plugin("agent-system", "Agent System", {
          description: "Manage agent workspaces.",
          origin: "global",
          channelIds: ["agent-system-github", "agent-system-chat"],
        }),
      ],
      channelStatus(
        "agent-system-github",
        "GitHub Notifications",
        false,
        "GitHub notification channel",
      ),
      ["operator.admin", "operator.read"],
    );
    const fetchMock = mockIcon("blob:duplicate-plugin-icon");
    vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:agent-system-plugin-icon");
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
    expect(iconRequests(fetchMock)).toEqual(["/__openclaw__/plugin-icon/agent-system"]);
    await refresh(
      channelSnapshot({
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
      }),
    );
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
  });

  it.each(["disconnect", "timeout"])(
    "cancels the owning plugin icon request on %s",
    async (cause) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { gateway, source } = catalogFixture(
        [plugin("agent-system", "Agent System", { channelIds: ["agent-system-github"] })],
        channelStatus("agent-system-github", "GitHub Notifications"),
      );
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
    },
  );

  it("polls pairing only while visible, authorized, and mounted", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const gateway = createGateway(["operator.pairing"]);
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
  });

  it("refreshes pairing data when the authorized scope set changes", async () => {
    const gateway = createGateway(["operator.pairing"]);
    const source = createContext(gateway);
    source.channels.state.pairingSnapshot = pairingSnapshot({ commandOwnerConfigured: true });
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
  });

  it.each(["cancel", "disconnect"] as const)(
    "releases a held pairing presentation on %s without cancelling its owner",
    async (retirement) => {
      const pending = createDeferred();
      const gateway = createGateway(["operator.pairing"], {
        "channels.pairing.dismiss": () => pending.promise,
        "channels.pairing.list": () => pairingSnapshot({ commandOwnerConfigured: true }),
      });
      const source = createContext(gateway);
      source.channels.state.pairingSnapshot = pairingSnapshot({ commandOwnerConfigured: true });
      const request = vi.spyOn(gateway.snapshot.client!, "request");
      const page = mountPage(source.context);
      await settle();
      profileButton(page, "Dismiss").click();
      await settle();
      const dialog = page.querySelector(".channels-pairing-dialog")!;
      const confirm = dialog.querySelector<HTMLButtonElement>("button.danger")!;
      confirm.click();
      await waitForSolid(() => expect(confirm.disabled).toBe(true));
      expect(page.querySelector(".channels-pairing-dialog")).toBe(dialog);

      if (retirement === "cancel") {
        dialog.closest("openclaw-modal-dialog")!.dispatchEvent(new CustomEvent("modal-cancel"));
      } else {
        gateway.emit({ phase: "connecting", client: null });
      }
      await waitForSolid(() => expect(page.querySelector(".channels-pairing-dialog")).toBeNull());
      pending.resolve();
      await settle();
      expect(page.querySelector(".channels-pairing-dialog")).toBeNull();
      expect(request).toHaveBeenCalledWith(
        "channels.pairing.dismiss",
        expect.objectContaining({ requestId: "opaque-request-id" }),
      );
    },
  );

  it("keeps rejected channel configuration visible in its editor without reloading the draft", async () => {
    const pending = createDeferred<never>();
    const gateway = createGateway(undefined, {
      "config.set": () => pending.promise,
    });
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
    source.channels.state.channelsSnapshot = channelSnapshot({
      channelOrder: ["whatsapp"],
      channelLabels: { whatsapp: "WhatsApp" },
      channels: { whatsapp: channel },
    });
    source.channels.state.pairingSnapshot = pairingSnapshot({
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
    });
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
      expect(save.disabled).toBe(true);
      expect(save.textContent).toContain("Saving");
    });
    expect(page.querySelector(".channels-detail .btn.primary")).toBe(save);
    pending.reject(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message:
          "channel rejected: OPENAI_API_KEY=sk-1234567890abcdef <img src=x onerror=alert(1)>",
      }),
    );

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
    expect(page.querySelector(".channels-detail .btn.primary")).toBe(save);
    expect(save.disabled).toBe(false);
  });
});

async function mountPackagedChannel(channelId = "custom-profile", scopes = ["operator.admin"]) {
  const placement = { section: "channels", panel: "detail", channelId } as const;
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
    auth: { role: "operator", scopes, deviceToken: "device-token" },
  };
  const source = createContext(gateway);
  const refresh = vi.spyOn(source.channels, "refresh").mockResolvedValue();
  source.channels.state.channelsSnapshot = channelSnapshot({
    channelOrder: [channelId, "other"],
    channelLabels: { [channelId]: "Custom profile", other: "Other" },
    channels: { [channelId]: { configured: true, linked: true }, other: { configured: true } },
  });
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
const logoutPrompt = {
  title: "Log out",
  message: "Confirm account logout",
  confirmLabel: "Logout",
};

type PackagedChannel = Awaited<ReturnType<typeof mountPackagedChannel>>;
function retire(f: PackagedChannel, reason: "disconnect" | "client" | "admin" | "unmount") {
  if (reason === "disconnect") {
    f.gateway.emit({ phase: "stopped" });
  } else if (reason === "client") {
    f.gateway.emit({ client: createGateway().snapshot.client });
  } else if (reason === "admin") {
    setGatewayScopes(f.gateway, ["operator.read"]);
  } else {
    disposePage(f.page);
  }
}

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
  dispose();
  dispose();
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
});

it.each(["disconnect", "client", "admin", "unmount", "caller"] as const)(
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
    if (retirement === "caller") {
      caller.abort();
    } else {
      if (retirement === "client") {
        f.gateway.connection.token = "rotated-token";
      }
      retire(f, retirement);
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
                () => reject(new DOMException("Deadline", "TimeoutError")),
                {
                  once: true,
                },
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
});

it("binds plugin login actions to the existing owner and omits the default start/wait account", async () => {
  const f = await mountPackagedChannel("whatsapp");
  const client = f.gateway.snapshot.client!;
  const request = vi.spyOn(client, "request");
  request.mockClear();
  await f.context.login!.start(false);
  await f.context.login!.wait();
  expect(request.mock.calls.filter(([method]) => method.startsWith("web.login."))).toEqual([
    ["web.login.start", { channel: "whatsapp", force: false, timeoutMs: 30000 }],
    ["web.login.wait", { channel: "whatsapp", timeoutMs: 120000, currentQrDataUrl: undefined }],
  ]);
  const account = f.context.login!.captureLogout()!;
  expect(account.accountId).toBe("default");
  await account.logout();
  expect(request).toHaveBeenCalledWith("channels.logout", {
    channel: "whatsapp",
    accountId: "default",
  });
});

it.each([
  ["start", "web.login.start"],
  ["wait", "web.login.wait"],
  ["logout", "channels.logout"],
] as const)(
  "settles the plugin %s saving snapshot after a failed owner request",
  async (operation, method) => {
    const f = await mountPackagedChannel("whatsapp");
    const pending = createDeferred();
    const request = vi.spyOn(f.gateway.snapshot.client!, "request");
    request.mockImplementationOnce(async () => await pending.promise);
    const login = f.context.login!;
    const completion =
      operation === "start"
        ? login.start(false)
        : operation === "wait"
          ? login.wait()
          : login.captureLogout()!.logout();
    await waitForSolid(() =>
      expect(f.mounts[0]!.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ login: expect.objectContaining({ busy: true }) }),
      ),
    );
    expect(request.mock.calls.some(([name]) => name === method)).toBe(true);
    expect(f.page.querySelector("[data-plugin-draft]")).toBe(f.mounts[0]!.input);
    pending.reject(new Error("Login unavailable"));
    await completion;
    await waitForSolid(() =>
      expect(f.mounts[0]!.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          login: expect.objectContaining({ busy: false, message: "Login unavailable" }),
        }),
      ),
    );
    expect(f.page.querySelector("[data-plugin-draft]")).toBe(f.mounts[0]!.input);
  },
);

it("releases a plugin login presentation on disconnect before its admitted request settles", async () => {
  const f = await mountPackagedChannel("whatsapp");
  const pending = createDeferred<Record<string, unknown>>();
  vi.spyOn(f.gateway.snapshot.client!, "request").mockImplementationOnce(
    async () => await pending.promise,
  );
  let completed = false;
  const completion = f.context.login!.start(false).then(() => {
    completed = true;
  });
  await waitForSolid(() => expect(f.source.channels.state.whatsappBusy).toBe(true));
  f.gateway.emit({ phase: "stopped" });
  await waitForSolid(() =>
    expect(f.mounts[0]!.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connected: false,
        login: expect.objectContaining({ busy: false }),
      }),
    ),
  );
  expect(completed).toBe(false);
  pending.resolve({ connected: true });
  await completion;
  expect(f.source.channels.state.whatsappLoginConnected).not.toBe(true);
});

it("denies login and confirmation capabilities to an initially read-only operator", async () => {
  const f = await mountPackagedChannel("whatsapp", ["operator.read"]);
  const request = vi.spyOn(f.gateway.snapshot.client!, "request");
  request.mockClear();
  await expect(f.context.login!.start(false)).rejects.toThrow();
  await expect(f.context.login!.wait()).rejects.toThrow();
  expect(() => f.context.login!.captureLogout()).toThrow();
  await expect(f.context.confirm!(logoutPrompt)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(logoutPrompt.message);
});

it.each(["account", "linked"] as const)(
  "rejects a captured plugin logout after its %s changes",
  async (change) => {
    const f = await mountPackagedChannel("whatsapp");
    const status = f.source.channels.state.channelsSnapshot!;
    status.channelDefaultAccountId.whatsapp = "work/account";
    status.channelAccounts.whatsapp = [{ accountId: "work/account", linked: true }];
    const account = f.context.login!.captureLogout()!;
    expect(account.accountId).toBe("work/account");
    if (change === "account") {
      status.channelDefaultAccountId.whatsapp = "replacement";
    } else {
      status.channelAccounts.whatsapp[0]!.linked = false;
    }
    const request = vi.spyOn(f.gateway.snapshot.client!, "request");
    request.mockClear();
    await account.logout();
    expect(request).not.toHaveBeenCalled();
  },
);

it.each(["disconnect", "client", "admin", "unmount"] as const)(
  "cancels confirmation and denies retained login actions synchronously after %s",
  async (retirement) => {
    const f = await mountPackagedChannel("whatsapp");
    const request = vi.spyOn(f.gateway.snapshot.client!, "request");
    const account = f.context.login!.captureLogout()!;
    const confirmation = f.context.confirm!({ ...logoutPrompt, danger: true });
    const rejection = expect(confirmation).rejects.toThrow();
    await waitForSolid(() => expect(document.body.textContent).toContain(logoutPrompt.message));
    retire(f, retirement);
    request.mockClear();
    await expect(f.context.login!.start(true)).rejects.toThrow();
    await expect(f.context.login!.wait()).rejects.toThrow();
    await expect(account.logout()).rejects.toThrow();
    await rejection;
    expect(request).not.toHaveBeenCalled();
    await waitForSolid(() => expect(document.body.textContent).not.toContain(logoutPrompt.message));
  },
);

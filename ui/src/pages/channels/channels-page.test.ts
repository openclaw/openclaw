import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "../../../../src/plugin-sdk/control-ui-settings.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import type { ControlUiPluginDistribution } from "../../plugins/control-ui-distribution.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
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
  const mounted = mountSolid(() => createComponent(ChannelsPage, {}), {
    wrapper: (props) =>
      createComponent(ApplicationProvider, {
        value: context,
        get children() {
          return props.children;
        },
      }),
  });
  mountedPages.set(mounted.container, mounted.unmount);
  flush();
  return mounted.container;
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

const findButton = (root: ParentNode, selector: string) =>
  root.querySelector<HTMLButtonElement>(selector)!;
async function closeDetail(page: HTMLElement) {
  findButton(page, ".channels-detail__close").click();
  await settle();
}
async function clickAction(page: HTMLElement, label: string) {
  profileButton(page, label).click();
  await settle();
}
async function expectPresence(page: HTMLElement, selector: string, present: boolean) {
  await waitForSolid(() => expect(page.querySelector(selector) !== null).toBe(present));
}
function expectUpdate(mount: PackagedChannel["mounts"][number], expected: object) {
  expect(mount.update).toHaveBeenLastCalledWith(expect.objectContaining(expected));
}
const waitForUpdate = (mount: PackagedChannel["mounts"][number], expected: object) =>
  waitForSolid(() => expectUpdate(mount, expected));
function heldFetch() {
  const pending = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
  vi.stubGlobal("fetch", fetchMock);
  return { pending, fetchMock };
}
const objectSchema = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
});

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
  it("waits for reconnect, retains rejected wizard drafts, and retires closed or unmounted sessions", async () => {
    const answer = createDeferred<Record<string, unknown>>();
    const closing = createDeferred<Record<string, unknown>>();
    const step = { id: "token", type: "text", title: "Channel token" };
    const next = vi.fn().mockReturnValueOnce(answer.promise).mockReturnValueOnce(closing.promise);
    const gateway = createGateway(["operator.admin", "operator.read"], {
      "wizard.start": () => ({ done: false, sessionId: "setup", step }),
      "wizard.next": next,
    });
    const source = createContext(gateway);
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const page = mountPage(source.context);
    await settle();
    expect(profileButton(page, "Set up").disabled).toBe(false);

    gateway.emit({ phase: "reconnecting" });
    await settle();
    for (const button of [
      profileButton(page, "Set up"),
      findButton(page, "button.channels-item"),
    ]) {
      expect(button.disabled).toBe(true);
      button.click();
    }

    const details = findButton(page, ".channels-item__detail");
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
    await closeDetail(page);
    expect(page.querySelector(".channels-detail")).toBeNull();

    gateway.emit({ phase: "connected" });
    await settle();
    const setup = profileButton(page, "Set up");
    expect(setup.disabled).toBe(false);
    setup.click();
    await expectPresence(page, "#channel-wizard-text-input", true);
    const input = page.querySelector<HTMLInputElement>("#channel-wizard-text-input")!;
    input.value = "Draft token";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await clickAction(page, "Continue");
    await waitForSolid(() => expect(input.disabled).toBe(true));
    expect(page.querySelector("#channel-wizard-text-input")).toBe(input);
    answer.resolve({ done: false, step: { ...step }, error: "Try another token" });
    await waitForSolid(() => expect(input.disabled).toBe(false));
    expect(page.querySelector("#channel-wizard-text-input")).toBe(input);
    expect(input.value).toBe("Draft token");
    expect(page.textContent).toContain("Try another token");
    await clickAction(page, "Continue");
    await waitForSolid(() => expect(input.disabled).toBe(true));
    page.querySelector("openclaw-modal-dialog")!.dispatchEvent(new Event("modal-cancel"));
    await expectPresence(page, ".channels-wizard", false);
    closing.resolve({ done: false, step, error: "Retired answer" });
    await settle();
    expect(page.querySelector(".channels-wizard")).toBeNull();
    await clickAction(page, "Set up");
    await expectPresence(page, "#channel-wizard-text-input", true);
    request.mockClear();
    disposePage(page);
    await settle();
    expect(request).toHaveBeenCalledWith("wizard.cancel", {
      sessionId: "setup",
      closeInput: true,
    });
  });

  it("prefers exact icon owners and reuses shared artwork when late channels arrive", async () => {
    const snapshot = (ids: string[]) =>
      channelSnapshot({
        channelOrder: ids,
        channelLabels: Object.fromEntries(ids.map((id) => [id, id])),
        channels: Object.fromEntries(ids.map((id) => [id, { configured: false }])),
      });
    const { source, refresh } = catalogFixture(
      [
        plugin("agent-system", "Agent System", { channelIds: ["slack", "github", "project-chat"] }),
        plugin("slack", "Slack"),
        plugin("mattermost", "Mattermost"),
      ],
      snapshot(["slack", "github"]),
      ["operator.admin", "operator.read"],
    );
    const fetchMock = mockIcon("blob:unexpected");
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:slack")
      .mockReturnValueOnce("blob:shared")
      .mockReturnValueOnce("blob:late");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const page = mountPage(source.context);
    const images = () =>
      [...page.querySelectorAll(".channels-item img")].map((img) => img.getAttribute("src"));
    await waitForSolid(() => expect(images()).toEqual(["blob:slack", "blob:shared"]));
    expect(iconRequests(fetchMock)).toEqual([
      "/__openclaw__/plugin-icon/slack",
      "/__openclaw__/plugin-icon/agent-system",
    ]);
    await refresh(snapshot(["slack", "github", "project-chat", "mattermost"]));
    await waitForSolid(() =>
      expect(images()).toEqual(["blob:slack", "blob:shared", "blob:shared", "blob:late"]),
    );
    expect(iconRequests(fetchMock)).toEqual([
      "/__openclaw__/plugin-icon/slack",
      "/__openclaw__/plugin-icon/agent-system",
      "/__openclaw__/plugin-icon/mattermost",
    ]);
    disposePage(page);
    expect(revoke.mock.calls).toEqual([["blob:slack"], ["blob:shared"], ["blob:late"]]);
  });

  it("cancels the owning plugin icon request on disconnect", async () => {
    const { gateway, source } = catalogFixture(
      [plugin("agent-system", "Agent System", { channelIds: ["agent-system-github"] })],
      channelStatus("agent-system-github", "GitHub Notifications"),
    );
    const { pending, fetchMock } = heldFetch();
    const page = mountPage(source.context);
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    gateway.emit({ phase: "stopped" });
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: "AbortError" });
    pending.reject(signal.reason);
    await settle();
    disposePage(page);
  });

  it("scopes pairing polling, filters, and dialogs to current authority and page lifetime", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const snapshot = pairingSnapshot({ commandOwnerConfigured: true });
    const gateway = createGateway(["operator.pairing"], {
      "channels.pairing.list": () => snapshot,
    });
    const source = createContext(gateway);
    source.channels.state.pairingSnapshot = snapshot;
    const refreshPairing = vi.spyOn(source.channels, "refreshPairing");
    const page = mountPage(source.context);
    await settle();
    refreshPairing.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshPairing).toHaveBeenCalledTimes(1);
    setGatewayScopes(gateway, ["operator.read"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshPairing).toHaveBeenCalledTimes(1);
    setGatewayScopes(gateway, ["operator.pairing"]);
    await settle();
    refreshPairing.mockClear();
    await choosePairingFilter(page, 0, "whatsapp");
    await choosePairingFilter(page, 1, "personal");
    const filters = () =>
      [...page.querySelectorAll(".channels-pairing-filters .picker-select__trigger")].map(
        (node) => node.textContent,
      );
    expect(filters()).toEqual([
      expect.stringContaining("WhatsApp"),
      expect.stringContaining("Personal"),
    ]);
    await clickAction(page, "Approve");
    expect(page.querySelector(".channels-pairing-dialog")).not.toBeNull();

    setGatewayScopes(gateway, ["operator.pairing", "operator.read"]);

    await waitForSolid(() => {
      expect(refreshPairing).toHaveBeenCalled();
      expect(source.channels.state.pairingSnapshot).not.toBeNull();
    });
    await updatePickers(page);
    expect(page.querySelector(".channels-pairing-dialog")).toBeNull();
    expect(filters()).toEqual([
      expect.stringContaining("All channels"),
      expect.stringContaining("All accounts"),
    ]);
    refreshPairing.mockClear();
    disposePage(page);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshPairing).not.toHaveBeenCalled();
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
      await clickAction(page, "Dismiss");
      const dialog = page.querySelector(".channels-pairing-dialog")!;
      const confirm = findButton(dialog, "button.danger");
      confirm.click();
      await waitForSolid(() => expect(confirm.disabled).toBe(true));
      expect(page.querySelector(".channels-pairing-dialog")).toBe(dialog);

      if (retirement === "cancel") {
        dialog.closest("openclaw-modal-dialog")!.dispatchEvent(new CustomEvent("modal-cancel"));
      } else {
        gateway.emit({ phase: "connecting", client: null });
      }
      await expectPresence(page, ".channels-pairing-dialog", false);
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
      hello: gatewayHelloForMethods(
        ["config.set", "config.schema"],
        ["operator.admin", "operator.read"],
      ),
    });
    const source = createContext(gateway);
    const config = { channels: { whatsapp: { enabled: true } } };
    source.channels.state.channelsSnapshot = channelStatus("whatsapp", "WhatsApp", true);
    source.channels.state.pairingSnapshot = pairingSnapshot({ accounts: [], requests: [] });
    Object.assign(source.runtimeConfig.state, {
      configSnapshot: { config, hash: "test", raw: JSON.stringify(config) },
      configForm: structuredClone(config),
      configFormOriginal: structuredClone(config),
      configDraftBaseHash: "test",
      configSchema: objectSchema({
        channels: objectSchema({
          whatsapp: objectSchema({ enabled: { type: "boolean", title: "Enabled" } }),
        }),
      }),
      configUiHints: { "channels.whatsapp.enabled": { advanced: false } },
    });
    const refreshConfig = vi.spyOn(source.runtimeConfig, "refresh");
    const refreshChannels = vi.spyOn(source.channels, "refresh");
    const page = mountPage(source.context);
    await settle();

    findButton(page, ".channels-item").click();
    await settle();
    source.runtimeConfig.patchForm(["channels", "whatsapp", "enabled"], false);
    await settle();
    const save = findButton(page, ".channels-detail .btn.primary");
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
    entry: "/fixture/index.js",
    styles: [],
    imports: [],
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
  vi.spyOn(source.channels, "refresh").mockResolvedValue();
  source.channels.state.channelsSnapshot = channelSnapshot({
    channelOrder: [channelId, "other"],
    channelLabels: { [channelId]: "Custom profile", other: "Other" },
    channels: { [channelId]: { configured: true, linked: true }, other: { configured: true } },
  });
  function mount(container: HTMLElement, context: ControlUiChannelSettingsContext) {
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
  }
  const mounts: ReturnType<typeof mount>[] = [];
  // Record host lifetime/snapshots without replacing the real presentation owner.
  Object.assign(source.context, {
    plugins: {
      loadSettingsView: vi.fn(async (_placement, signal: AbortSignal) => ({
        signal,
        dispose: vi.fn(),
        view: { placement, mount },
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
  return { gateway, source, page, mounts, open, context: mounts[0]!.context };
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
  const { pending } = heldFetch();
  const f = await mountPackagedChannel();
  const original = f.mounts[0]!;
  original.input.value = "Retained draft";
  const request = f.context.request(profileRequest());
  await closeDetail(f.page);
  expect(original.context.signal.aborted).toBe(false);
  expectUpdate(original, { presented: false });
  await f.open("Other");
  await closeDetail(f.page);
  pending.resolve(Response.json({ ok: true }));
  await expect(request).resolves.toMatchObject({ ok: true });
  await f.open();
  expect(f.mounts).toHaveLength(1);
  expect(f.page.querySelector("[data-plugin-draft]")).toBe(original.input);
  expect(original.input.value).toBe("Retained draft");
  expectUpdate(original, { presented: true });
  const hello = f.gateway.snapshot.hello;
  f.gateway.emit({ phase: "reconnecting", hello: null });
  expect(original.context.signal.aborted).toBe(false);
  expectUpdate(original, { connected: false });
  f.gateway.emit({ phase: "connected", hello });
  await settle();
  expect(f.mounts).toHaveLength(1);
  expect(original.input.value).toBe("Retained draft");
  expectUpdate(original, { connected: true });
});

it.each(["disconnect", "client", "admin", "unmount"] as const)(
  "retires login and confirmation authority synchronously after %s",
  async (retirement) => {
    const f = await mountPackagedChannel("whatsapp");
    const configSlot = document.createElement("div");
    let disposeConfig: (() => void) | undefined;
    if (retirement === "client") {
      f.mounts[0]!.input.parentElement!.append(configSlot);
      disposeConfig = f.context.mountConfig(configSlot);
      await waitForSolid(() => expect(configSlot.textContent).toContain("Reload"));
    }
    const login = f.context.login!;
    const account = login.captureLogout()!;
    const request = vi.spyOn(f.gateway.snapshot.client!, "request");
    const loginPending = createDeferred<Record<string, unknown>>();
    request.mockImplementationOnce(async () => await loginPending.promise);
    let completed = false;
    const completion = login.start(false).then(() => {
      completed = true;
    });
    await waitForSolid(() => expect(f.source.channels.state.whatsappBusy).toBe(true));
    const confirmation = expect(
      f.context.confirm!({ ...logoutPrompt, danger: true }),
    ).rejects.toThrow();
    await waitForSolid(() => expect(document.body.textContent).toContain(logoutPrompt.message));
    retire(f, retirement);
    request.mockClear();
    await expect(login.start(true)).rejects.toThrow();
    await expect(login.wait()).rejects.toThrow();
    await expect(account.logout()).rejects.toThrow();
    await confirmation;
    expect(request).not.toHaveBeenCalled();
    await waitForSolid(() => {
      expect(document.body.textContent).not.toContain(logoutPrompt.message);
      if (retirement === "disconnect") {
        expectUpdate(f.mounts[0]!, {
          connected: false,
          login: expect.objectContaining({ busy: false }),
        });
      }
    });
    expect(completed).toBe(false);
    loginPending.resolve({ connected: true });
    await completion;
    if (retirement === "disconnect") {
      expect(f.source.channels.state.whatsappLoginConnected).not.toBe(true);
    }
    if (retirement !== "disconnect") {
      expect(f.mounts[0]!.dispose).toHaveBeenCalledOnce();
    }
    if (disposeConfig) {
      expect(f.context.signal.aborted).toBe(true);
      expect(configSlot.childNodes).toHaveLength(0);
      expect(() => f.context.mountConfig(configSlot)).toThrow();
      disposeConfig();
      disposeConfig();
    }
  },
);

it.each(["caller", "authority"])(
  "rejects HTTP work when %s retires while reading the response body",
  async (stage) => {
    const reading = createDeferred();
    const body = createDeferred<unknown>();
    const response = Response.json({});
    vi.spyOn(response, "json").mockImplementation(() => {
      reading.resolve();
      return body.promise;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    const f = await mountPackagedChannel();
    const caller = new AbortController();
    const result = f.context.request(profileRequest(caller.signal));
    const rejection =
      stage === "authority"
        ? expect(result).rejects.toThrow()
        : expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await reading.promise;
    expect(fetchMock.mock.calls[0]![1]!.signal).toBe(fetchMock.mock.calls[1]![1]!.signal);
    expect(fetchMock.mock.calls[1]![1]!.signal!.aborted).toBe(false);
    if (stage === "authority") {
      f.gateway.emit({ phase: "stopped" });
      await expect(f.context.request(profileRequest())).rejects.toThrow();
      body.resolve({ ok: true });
    } else {
      caller.abort(new DOMException("Deadline", "TimeoutError"));
      expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      await expect(f.context.request(profileRequest(caller.signal))).rejects.toThrow();
      body.reject(caller.signal.reason);
    }
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

it.each([403, 503])(
  "preserves HTTP %i details without retrying a forbidden mutation",
  async (status) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        status === 403
          ? Response.json({ error: { message: "Forbidden" } }, { status })
          : new Response("gateway unavailable", { status }),
      );
    if (status === 503) {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    }
    vi.stubGlobal("fetch", fetchMock);
    const f = await mountPackagedChannel();
    const result = await f.context.request(profileRequest());
    expect(fetchMock).toHaveBeenCalledTimes(status === 403 ? 1 : 2);
    expect(result).toMatchObject({
      status,
      errorMessage: status === 403 ? "HTTP 403: Forbidden" : "HTTP 503",
    });
  },
);

it.each([
  ["start", "web.login.start", { channel: "whatsapp", force: false, timeoutMs: 30000 }],
  [
    "wait",
    "web.login.wait",
    { channel: "whatsapp", timeoutMs: 120000, currentQrDataUrl: undefined },
  ],
  ["logout", "channels.logout", { channel: "whatsapp", accountId: "default" }],
] as const)(
  "binds plugin %s to its owner and settles its failed saving snapshot",
  async (operation, method, params) => {
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
    await waitForUpdate(f.mounts[0]!, { login: expect.objectContaining({ busy: true }) });
    expect(request).toHaveBeenCalledWith(method, params);
    expect(f.page.querySelector("[data-plugin-draft]")).toBe(f.mounts[0]!.input);
    pending.reject(new Error("Login unavailable"));
    await completion;
    await waitForUpdate(f.mounts[0]!, {
      login: expect.objectContaining({ busy: false, message: "Login unavailable" }),
    });
    expect(f.page.querySelector("[data-plugin-draft]")).toBe(f.mounts[0]!.input);
  },
);

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

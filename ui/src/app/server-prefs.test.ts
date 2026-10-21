import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
/* @vitest-environment jsdom */
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "../lib/config/config-test-harness.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { resetServerUiPref } from "./server-prefs-controls.ts";
import { changedServerUiPrefs, requestServerUiPrefIntent } from "./server-prefs-intent.ts";
import { applyServerUiPrefs, resolveServerUiPrefState } from "./server-prefs-reconcile.ts";
import type { ServerUiPrefsCommit } from "./server-prefs-sync-contract.ts";
import {
  configWithPrefs,
  createServerPrefsWriter as createClient,
  type RequestMock,
} from "./server-prefs.test-support.ts";
import {
  flushServerUiPrefs as flush,
  pushServerUiPrefs as push,
  resetServerUiPrefsSync,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const pendingKey = (scope: string) => `openclaw.control.serverPrefs.pending.v1:${scope}`;
const readPending = (gateway = scope) =>
  JSON.parse(localStorage.getItem(pendingKey(gateway)) ?? "{}") as Record<string, unknown>;

const scope = "ws://gw";
type Request = (method: string, params?: unknown) => Promise<unknown>;
let request: RequestMock;
let client: ReturnType<typeof createClient>;
let onApplied: Mock<ApplyHooks["onApplied"]>;
type ApplyHooks = Parameters<typeof applyServerUiPrefs>[1];
const hooks = (): ApplyHooks => ({ scope, onApplied });
const storePending = (prefs: Record<string, unknown>, gateway = scope) =>
  localStorage.setItem(pendingKey(gateway), JSON.stringify(prefs));
const expectCleared = (gateway = scope) =>
  expect(localStorage.getItem(pendingKey(gateway))).toBeNull();
const waitForRequest = (count = 1) =>
  vi.waitFor(() => expect(request).toHaveBeenCalledTimes(count));
function connect(writer = client, canPatch?: boolean) {
  Object.assign(writer.state, { connected: true });
  if (canPatch !== undefined) {
    Object.assign(writer, { canPatch });
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  request = vi.fn<Request>(async () => ({}));
  client = createClient(request);
  onApplied = vi.fn<ApplyHooks["onApplied"]>();
});

afterEach(() => {
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function applyPrefs(prefs: Record<string, unknown>, options: ApplyHooks = { onApplied }) {
  return applyServerUiPrefs(configWithPrefs(prefs), options);
}

const patchParams = (prefs: Record<string, unknown>) => ({
  raw: JSON.stringify({ ui: { prefs } }),
  note: "control-ui prefs sync",
});
function expectPatch(prefs: Record<string, unknown>) {
  expect(request).toHaveBeenCalledWith("config.patch", patchParams(prefs));
}
function holdRequest(once = false) {
  const gate = createDeferred<unknown>();
  if (once) {
    request.mockReturnValueOnce(gate.promise);
  } else {
    request.mockReturnValue(gate.promise);
  }
  return gate;
}
function expectApplied(config: unknown, changed: boolean, theme: string, options = hooks()) {
  expect(applyServerUiPrefs(config, options)).toBe(changed);
  expect(loadSettings().theme).toBe(theme);
}
function expectThemeState(
  config: unknown,
  provenance: string,
  value: string,
  gateway = scope,
  canSync = false,
) {
  expect(resolveServerUiPrefState(config, "theme", gateway, loadSettings(), { canSync })).toEqual({
    overridden: true,
    provenance,
    resetValue: "claw",
    value,
  });
}

describe("server preferences", () => {
  it("adopts the preference revision before saving an in-flight Settings edit", async () => {
    vi.useFakeTimers();
    const started = createDeferred();
    const release = createDeferred();
    const committed = createDeferred();
    const store = createConfigServerMock();
    request.mockImplementation(async (method, params) => {
      if (method === "config.patch") {
        started.resolve();
        await release.promise;
        return store.request("config.set", {
          raw: JSON.stringify({ count: 1, ui: { prefs: { themeMode: "dark" } } }),
          baseHash: "hash-1",
        });
      }
      return store.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      push(runtimeConfig, { themeMode: "dark" }, { afterCommit: () => committed.resolve() });
      await started.promise;
      runtimeConfig.patchForm(["count"], 2);
      release.resolve();
      await committed.promise;
      expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(store.submissions).toHaveLength(2);
      expect(store.submissions[1]?.baseHash).toBe("hash-2");
      expect(JSON.parse(store.submissions[1]!.raw)).toEqual({
        count: 2,
        ui: { prefs: { themeMode: "dark" } },
      });
      expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
    } finally {
      release.resolve();
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
    }
  });

  it.each([
    { intents: ["write"], expected: { locale: "de" } },
    { intents: ["write", "server"], expected: { locale: null } },
    { intents: ["server", "write"], expected: { locale: null } },
    { intents: ["write", "server", "device-local"], expected: null },
    { intents: ["device-local", "server", "write"], expected: null },
  ] as const)("consumes competing preference requests once: $intents", ({ intents, expected }) => {
    const settings = patchSettings({ locale: "de" });
    for (const intent of intents) {
      requestServerUiPrefIntent("locale", intent);
    }
    expect(changedServerUiPrefs(settings, settings)).toEqual(expected);
    expect(changedServerUiPrefs(settings, settings)).toBeNull();
  });

  it("settles rejected persisted keys even when they are not known preference names", async () => {
    const completed = createDeferred();
    request.mockImplementation(async () => {
      throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Unknown preference" });
    });
    storePending({ unknownPreference: true });
    flush(client, { afterCommit: () => completed.resolve() });
    await completed.promise;
    expectPatch({ unknownPreference: true });
    expectCleared();
  });

  it("rejects malformed accents in a minimal persisted settings record", () => {
    const { gatewayUrl } = loadSettings();
    localStorage.setItem(
      `openclaw.control.settings.v1:${gatewayUrl}`,
      JSON.stringify({ gatewayUrl, accent: "#abc" }),
    );
    expect(loadSettings().accent).toBeUndefined();
  });

  it("applies only valid, known pref values", () => {
    const valid = {
      theme: "knot",
      themeMode: "dark",
      accent: "#abc123",
      locale: "de",
      chatShowThinking: false,
      chatShowToolCalls: false,
      chatPersistCommentary: false,
      chatSendShortcut: "modifier-enter",
    };
    const mixed = {
      ...valid,
      accent: "#AbC123",
      textScale: 125,
      sidebarLiveActivity: false,
      chatMessageMaxWidth: "82%",
      sidebarEntries: ["route:usage", "session:agent:main:test", "route:usage", 7],
      bogus: true,
    };
    expect(applyPrefs(mixed)).toBe(true);
    expect(onApplied).toHaveBeenCalledWith(valid);
  });

  it("preserves a server custom-theme override when this device lacks its palette", () => {
    const config = configWithPrefs({ theme: "custom" });
    const onThemeChanged = vi.fn();
    expect(applyServerUiPrefs(config, { onApplied, onThemeChanged })).toBe(false);
    expect(loadSettings().theme).toBe("claw");
    expect(onApplied).not.toHaveBeenCalled();
    expect(onThemeChanged).toHaveBeenCalledWith("custom");
    const state = resolveServerUiPrefState(config, "theme");

    expectThemeState(config, "synced", "claw", "", true);
    patchSettings({ theme: "knot" });
    expectThemeState(config, "device-local", "knot", "");

    const beforeReset = loadSettings();
    const afterReset = resetServerUiPref("theme", state);
    expect(changedServerUiPrefs(beforeReset, afterReset)).toEqual({
      theme: null,
      accent: "theme",
      fontUi: null,
      fontChat: null,
    });
  });

  it.each([false, true])("reconciles pending snapshots after refresh: %s", async (refreshed) => {
    const snapshot = configWithPrefs({ themeMode: "light" });
    if (!refreshed) {
      applyServerUiPrefs(snapshot, hooks());
    }
    patchSettings({ themeMode: "dark" });
    client = createClient(
      request,
      scope,
      true,
      refreshed ? { ok: true } : { ok: false, error: "config.get failed" },
    );
    request.mockImplementation(async () => {
      if (refreshed) {
        applyServerUiPrefs(snapshot, hooks());
      }
      return {};
    });
    const committed = createDeferred();
    const afterCommit = vi.fn((commit: ServerUiPrefsCommit) => {
      expect(commit).toEqual({ needsRefresh: !refreshed });
      if (refreshed) {
        applyServerUiPrefs(snapshot, hooks());
      }
      committed.resolve();
    });
    push(client, { themeMode: "dark" }, { afterCommit });
    await committed.promise;
    expectCleared();
    if (refreshed) {
      expect(onApplied).toHaveBeenCalledWith({ themeMode: "light" });
    } else {
      expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: true });
      expect(applyServerUiPrefs(snapshot, hooks())).toBe(false);
      expect(loadSettings().themeMode).toBe("dark");
      expect(applyPrefs({ themeMode: "light" }, hooks())).toBe(true);
    }
    expect(loadSettings().themeMode).toBe("light");
  });

  it("restores product defaults when authored synced values are removed", () => {
    applyPrefs({
      theme: "knot",
      themeMode: "dark",
      accent: "#48d6c2",
      chatSendShortcut: "modifier-enter",
      locale: "de",
      chatFollowUpMode: "queue",
    });

    const before = loadSettings();
    expect(applyPrefs({})).toBe(true);
    const reset = loadSettings();
    expect(changedServerUiPrefs(before, reset)).toEqual({
      theme: "claw",
      themeMode: "system",
      accent: null,
      locale: null,
      chatSendShortcut: "enter",
      chatFollowUpMode: null,
    });
    expect(reset).toMatchObject({
      theme: "claw",
      themeMode: "system",
      locale: undefined,
      chatFollowUpMode: undefined,
      accent: undefined,
      chatSendShortcut: "enter",
    });
    const persisted = JSON.parse(
      localStorage.getItem(`openclaw.control.settings.v1:${reset.gatewayUrl}`) ?? "{}",
    ) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "accent")).toBe(false);
    expect(Object.hasOwn(persisted, "chatSendShortcut")).toBe(false);
  });

  it("does not publish a server theme change shadowed by pending local intent", async () => {
    const requestGate = holdRequest();
    const onThemeChanged = vi.fn();
    const themeHooks = { scope, onApplied, onThemeChanged };
    applyPrefs({ theme: "claw" }, themeHooks);
    onThemeChanged.mockClear();

    push(client, { theme: "knot" });
    await waitForRequest();
    expect(applyPrefs({ theme: "knot" }, themeHooks)).toBe(false);
    expect(onThemeChanged).not.toHaveBeenCalled();

    onApplied.mockClear();
    expect(applyPrefs({ theme: "knot", locale: "de" }, themeHooks)).toBe(true);
    expect(onApplied).toHaveBeenCalledExactlyOnceWith({ locale: "de" });
    expect(loadSettings().locale).toBe("de");
    expect(onThemeChanged).not.toHaveBeenCalled();

    requestGate.resolve({});
    await waitForFast(expectCleared);
  });

  it("keeps a synced default reset as a pending offline null intent", () => {
    const previous = loadSettings();
    const next = resetServerUiPref("theme");
    const prefs = changedServerUiPrefs(previous, next);
    expect(prefs).toEqual({ theme: null });

    push(createClient(vi.fn(), scope, false), prefs ?? {});

    expect(readPending()).toEqual({ theme: null });
    expect(resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", scope)).toEqual({
      overridden: false,
      provenance: "pending",
      resetValue: "claw",
      value: "claw",
    });
  });

  it("settles only this tab's acknowledged keys from sibling persisted pending", async () => {
    const flight = holdRequest();
    flush(client);
    storePending({ locale: "fr" });
    push(client, { theme: "knot" });
    await waitForRequest();

    flight.resolve({});

    await waitForFast(() => expect(readPending()).toEqual({ locale: "fr" }));
  });

  it("preserves a newer same-key edit across the older batch ack", async () => {
    const first = holdRequest(true);

    push(client, { themeMode: "dark" });
    await waitForRequest();
    push(client, { themeMode: "light" });
    first.resolve({});

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual(patchParams({ themeMode: "light" }));
  });

  it("retains in-memory pending intent when localStorage is unavailable", async () => {
    const storageError = new Error("storage unavailable");
    const unavailable = () => {
      throw storageError;
    };
    vi.stubGlobal("localStorage", {
      getItem: unavailable,
      removeItem: unavailable,
      setItem: unavailable,
    });
    client = createClient(request, scope, false);

    push(client, { locale: "de" });
    connect();
    flush(client);

    await waitForRequest();
    expectPatch({ locale: "de" });
  });

  it("ignores a superseded request rejection while its replacement is pending", async () => {
    const first = holdRequest(true);
    const second = holdRequest();

    push(client, { locale: "de" });
    await waitForRequest();
    flush(client);
    await waitForRequest(2);
    first.reject(new Error("socket closed"));
    await Promise.resolve();

    expect(localStorage.getItem(pendingKey(scope))).not.toBeNull();
    second.resolve({});
    await waitForFast(expectCleared);
  });

  it("does not let another scope's reconcile replace an active drain's pending state", async () => {
    const flight = holdRequest();
    client = createClient(request, "ws://a");
    storePending({ locale: "de" }, "ws://b");

    push(client, { themeMode: "dark" });
    await waitForRequest();
    applyPrefs({ themeMode: "light", locale: "fr" }, { scope: "ws://b", onApplied: vi.fn() });
    flight.resolve({});

    await waitForFast(() => expectCleared("ws://a"));
    expect(readPending("ws://b")).toEqual({ locale: "de" });
  });

  it("keeps personal sidebar arrays out of global config writes", () => {
    push(client, { sidebarEntries: ["route:usage"] });
    expect(request).not.toHaveBeenCalled();
  });

  it("re-adopts scope when a stable writer gains or changes its gateway client", async () => {
    const writer = createClient(request, "", false);
    Object.assign(writer.state, { client: null });

    push(writer, { locale: "de" });
    expect(readPending("")).toEqual({ locale: "de" });

    Object.assign(writer.state, { client: createClient(request, "ws://first").state.client });
    connect(writer);
    flush(writer);
    await waitForFast(() => expectCleared("ws://first"));
    expectCleared("");

    storePending({ themeMode: "dark" }, "ws://second");
    Object.assign(writer.state, { client: createClient(request, "ws://second").state.client });
    flush(writer);

    await waitForRequest(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
    });
  });
});

describe("read-only server preference lifecycle", () => {
  const retainedKey = `openclaw.control.serverPrefs.retained-local.v1:${scope}`;
  it.each(["before", "after"])("retains an edit made %s the first snapshot", (timing) => {
    const initial = configWithPrefs({ theme: "claw" });
    if (timing === "after") {
      applyServerUiPrefs(initial, hooks());
    }
    patchSettings({ theme: "knot" });
    push(
      createClient(request, scope, true, { ok: true }, false),
      { theme: "knot" },
      {
        afterCommit: ({ retainedLocal }) => {
          if (timing === "after") {
            expect(retainedLocal).toBe(true);
            expectApplied(initial, false, "knot");
          }
        },
      },
    );
    if (timing === "before") {
      expectApplied(initial, false, "knot");
      expect(localStorage.getItem(retainedKey)).toBeNull();
      resetServerUiPrefsSync();
      expectApplied(configWithPrefs({ theme: "claw" }), false, "knot");
      const previous = loadSettings();
      const state = resolveServerUiPrefState(initial, "theme", scope, previous, { canSync: false });
      const reset = resetServerUiPref("theme", state, scope);
      expect(reset.theme).toBe("claw");
      expect(changedServerUiPrefs(previous, reset)).toBeNull();
    }
    expect(localStorage.getItem(retainedKey)).toBeNull();
    expectApplied(configWithPrefs({ theme: "dash" }), true, "dash");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps offline intent through read-only reconnect and replays it after authorization", async () => {
    const writer = createClient(request, scope, false, { ok: true }, false);
    patchSettings({ theme: "knot" });

    push(writer, { theme: "knot" });
    expect(readPending()).toEqual({ theme: "knot" });
    expectThemeState(configWithPrefs({ theme: "claw" }), "device-local", "knot");

    connect(writer);
    flush(writer);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(readPending()).toEqual({ theme: "knot" });

    Object.assign(writer, { canPatch: true });
    flush(writer);
    await waitForRequest();
    await vi.waitFor(expectCleared);
  });

  it.each([
    [
      "scope replacement",
      "ws://new",
      () => push(createClient(request, "ws://new", false), { locale: "de" }),
    ],
    ["lost write capability", "ws://old", () => Object.assign(client, { canPatch: false })],
  ] as const)("refuses queued dispatch after %s", async (_change, pendingScope, change) => {
    const gate = createDeferred();
    const queued = createDeferred();
    const resumed = createDeferred();
    client = createClient(request, "ws://old");
    const dispatch = client.runExternalMutation;
    client.runExternalMutation = async (task, options) => {
      queued.resolve();
      await gate.promise;
      const result = await dispatch(task, options);
      resumed.resolve();
      return result;
    };
    push(client, { locale: "de" });
    await queued.promise;
    change();
    gate.resolve();
    await resumed.promise;
    expect(request).not.toHaveBeenCalled();
    expect(readPending(pendingScope)).toEqual({ locale: "de" });
  });

  it.each(["cancelled sibling", "same-key replacement"])("adopts a tab's %s", async (change) => {
    client = createClient(request, scope, false);
    const cancelled = change === "cancelled sibling";
    const persisted = { theme: cancelled ? "knot" : "dash" };
    push(client, cancelled ? { locale: "de", theme: "knot" } : { theme: "knot" });
    storePending(persisted);
    connect(client, !cancelled);
    if (cancelled) {
      push(client, { themeMode: "dark" });
      expect(readPending()).toEqual(persisted);
      expect(request).not.toHaveBeenCalled();
      Object.assign(client, { canPatch: true });
    }
    flush(client);
    await waitForRequest();
    expectPatch(persisted);
  });

  it("does not migrate cancelled pre-connection intent into an adopted gateway scope", async () => {
    const writer = createClient(request, "", false);
    Object.assign(writer.state, { client: null });

    push(writer, { theme: "knot" });
    localStorage.removeItem(pendingKey(""));

    Object.assign(writer.state, createClient(request, "ws://first").state);
    flush(writer);
    push(writer, { themeMode: "dark" });

    await waitForRequest();
    expectPatch({ themeMode: "dark" });
  });
});

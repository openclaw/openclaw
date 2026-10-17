import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  configWithPrefs,
  createServerPrefsWriter as createClient,
  type RequestMock,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const pendingKey = (scope: string) => `openclaw.control.serverPrefs.pending.v1:${scope}`;
const readPending = (scope: string) =>
  JSON.parse(localStorage.getItem(pendingKey(scope)) ?? "{}") as Record<string, unknown>;

const scope = "ws://gw";
type Request = (method: string, params?: unknown) => Promise<unknown>;
let request: RequestMock;
let client: ReturnType<typeof createClient>;
let onApplied: ReturnType<typeof vi.fn>;
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
  onApplied = vi.fn();
});

afterEach(() => {
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function applyPrefs(
  prefs: Record<string, unknown>,
  hooks: Parameters<typeof applyServerUiPrefs>[1] = { onApplied },
) {
  return applyServerUiPrefs(configWithPrefs(prefs), hooks);
}

function expectPatch(prefs: Record<string, unknown>) {
  expect(request).toHaveBeenCalledWith("config.patch", {
    raw: JSON.stringify({ ui: { prefs } }),
    note: "control-ui prefs sync",
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
      pushServerUiPrefs(
        runtimeConfig,
        { themeMode: "dark" },
        { afterCommit: () => committed.resolve() },
      );
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
    flushServerUiPrefs(client, { afterCommit: () => completed.resolve() });
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
    expect(
      applyPrefs(
        {
          ...valid,
          accent: "#AbC123",
          textScale: 125,
          sidebarLiveActivity: false,
          chatMessageMaxWidth: "82%",
          sidebarEntries: ["route:usage", "session:agent:main:test", "route:usage", 7],
          bogus: true,
        },
        { onApplied },
      ),
    ).toBe(true);
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

    expect(state).toEqual({
      overridden: true,
      provenance: "synced",
      resetValue: "claw",
      value: "claw",
    });
    patchSettings({ theme: "knot" });
    expect(
      resolveServerUiPrefState(config, "theme", "", loadSettings(), { canSync: false }),
    ).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "claw",
      value: "knot",
    });

    const beforeReset = loadSettings();
    const afterReset = resetServerUiPref("theme", state);
    expect(changedServerUiPrefs(beforeReset, afterReset)).toEqual({
      theme: null,
      accent: "theme",
      fontUi: null,
      fontChat: null,
    });
  });

  it("does not reapply a retained pre-commit snapshot after an ack moves lastSeen", async () => {
    const oldSnapshot = configWithPrefs({ themeMode: "light" });
    applyServerUiPrefs(oldSnapshot, { scope, onApplied });
    patchSettings({ themeMode: "dark" });
    client = createClient(request, scope, true, {
      ok: false,
      error: "config.get failed",
    });
    const committed = createDeferred();
    const afterCommit = vi.fn(() => committed.resolve());
    pushServerUiPrefs(client, { themeMode: "dark" }, { afterCommit });
    await committed.promise;
    expectCleared();

    expect(applyServerUiPrefs(oldSnapshot, { scope, onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: true });
    expect(applyPrefs({ themeMode: "light" }, { scope, onApplied })).toBe(true);
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
    const requestGate = createDeferred<unknown>();
    request.mockReturnValue(requestGate.promise);
    const onThemeChanged = vi.fn();
    const hooks = { scope, onApplied, onThemeChanged };
    applyPrefs({ theme: "claw" }, hooks);
    onThemeChanged.mockClear();

    pushServerUiPrefs(client, { theme: "knot" });
    await waitForRequest();
    expect(applyPrefs({ theme: "knot" }, hooks)).toBe(false);
    expect(onThemeChanged).not.toHaveBeenCalled();

    onApplied.mockClear();
    expect(applyPrefs({ theme: "knot", locale: "de" }, hooks)).toBe(true);
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

    pushServerUiPrefs(createClient(vi.fn(), scope, false), prefs ?? {});

    expect(readPending(scope)).toEqual({ theme: null });
    expect(resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", scope)).toEqual({
      overridden: false,
      provenance: "pending",
      resetValue: "claw",
      value: "claw",
    });
  });

  it("settles only this tab's acknowledged keys from sibling persisted pending", async () => {
    const flight = createDeferred<unknown>();
    request.mockReturnValue(flight.promise);
    flushServerUiPrefs(client);
    storePending({ locale: "fr" });
    pushServerUiPrefs(client, { theme: "knot" });
    await waitForRequest();

    flight.resolve({});

    await waitForFast(() => expect(readPending(scope)).toEqual({ locale: "fr" }));
  });

  it("preserves a newer same-key edit across the older batch ack", async () => {
    const first = createDeferred<unknown>();
    request.mockReturnValueOnce(first.promise);

    pushServerUiPrefs(client, { themeMode: "dark" });
    await waitForRequest();
    pushServerUiPrefs(client, { themeMode: "light" });
    first.resolve({});

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "light" } } }),
      note: "control-ui prefs sync",
    });
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

    pushServerUiPrefs(client, { locale: "de" });
    connect();
    flushServerUiPrefs(client);

    await waitForRequest();
    expectPatch({ locale: "de" });
  });

  it("ignores a superseded request rejection while its replacement is pending", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    request.mockReturnValueOnce(first.promise).mockReturnValue(second.promise);

    pushServerUiPrefs(client, { locale: "de" });
    await waitForRequest();
    flushServerUiPrefs(client);
    await waitForRequest(2);
    first.reject(new Error("socket closed"));
    await Promise.resolve();

    expect(localStorage.getItem(pendingKey(scope))).not.toBeNull();
    second.resolve({});
    await waitForFast(expectCleared);
  });

  it("reconciles the refreshed snapshot again after clearing its pending shadow", async () => {
    const refreshedSnapshot = configWithPrefs({ themeMode: "light" });
    patchSettings({ themeMode: "dark" });
    request.mockImplementation(async () => {
      applyServerUiPrefs(refreshedSnapshot, { scope, onApplied });
      return {};
    });

    pushServerUiPrefs(
      client,
      { themeMode: "dark" },
      {
        afterCommit: ({ needsRefresh }) => {
          expect(needsRefresh).toBe(false);
          applyServerUiPrefs(refreshedSnapshot, { scope, onApplied });
        },
      },
    );
    await waitForRequest();
    await waitForFast(expectCleared);

    expect(onApplied).toHaveBeenCalledWith({ themeMode: "light" });
    expect(loadSettings().themeMode).toBe("light");
  });

  it("does not let another scope's reconcile replace an active drain's pending state", async () => {
    const flight = createDeferred<unknown>();
    request.mockReturnValue(flight.promise);
    client = createClient(request, "ws://a");
    storePending({ locale: "de" }, "ws://b");

    pushServerUiPrefs(client, { themeMode: "dark" });
    await waitForRequest();
    applyPrefs({ themeMode: "light", locale: "fr" }, { scope: "ws://b", onApplied: vi.fn() });
    flight.resolve({});

    await waitForFast(() => expectCleared("ws://a"));
    expect(readPending("ws://b")).toEqual({ locale: "de" });
  });

  it("keeps personal sidebar arrays out of global config writes", () => {
    pushServerUiPrefs(client, { sidebarEntries: ["route:usage"] });
    expect(request).not.toHaveBeenCalled();
  });

  it("re-adopts scope when a stable writer gains or changes its gateway client", async () => {
    const writer = createClient(request, "", false);
    Object.assign(writer.state, { client: null });

    pushServerUiPrefs(writer, { locale: "de" });
    expect(readPending("")).toEqual({ locale: "de" });

    const firstClient = createClient(request, "ws://first").state.client;
    Object.assign(writer.state, { client: firstClient });
    connect(writer);
    flushServerUiPrefs(writer);
    await waitForFast(() => expectCleared("ws://first"));
    expectCleared("");

    storePending({ themeMode: "dark" }, "ws://second");
    const secondClient = createClient(request, "ws://second").state.client;
    Object.assign(writer.state, { client: secondClient });
    flushServerUiPrefs(writer);

    await waitForRequest(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
    });
  });
});

describe("read-only server preference lifecycle", () => {
  const applied = { scope, onApplied: vi.fn() };
  const retainedKey = `openclaw.control.serverPrefs.retained-local.v1:${scope}`;
  it("retains a pre-snapshot read-only edit until the first server baseline is recorded", () => {
    patchSettings({ theme: "knot" });
    pushServerUiPrefs(createClient(request, scope, true, { ok: true }, false), { theme: "knot" });

    const initial = configWithPrefs({ theme: "claw" });
    expect(applyServerUiPrefs(initial, applied)).toBe(false);
    expect(loadSettings().theme).toBe("knot");
    expect(localStorage.getItem(retainedKey)).toBeNull();

    resetServerUiPrefsSync();
    expect(applyPrefs({ theme: "claw" }, applied)).toBe(false);
    expect(loadSettings().theme).toBe("knot");
    const previous = loadSettings();
    const state = resolveServerUiPrefState(initial, "theme", scope, previous, { canSync: false });
    const reset = resetServerUiPref("theme", state, scope);
    expect(reset.theme).toBe("claw");
    expect(changedServerUiPrefs(previous, reset)).toBeNull();

    expect(applyPrefs({ theme: "dash" }, applied)).toBe(true);
    expect(loadSettings().theme).toBe("dash");
    expect(request).not.toHaveBeenCalled();
  });

  it("applies the first server delta after a post-snapshot read-only edit", () => {
    const initial = configWithPrefs({ theme: "claw" });
    applyServerUiPrefs(initial, applied);
    patchSettings({ theme: "knot" });

    pushServerUiPrefs(
      createClient(vi.fn(), scope, true, { ok: true }, false),
      { theme: "knot" },
      {
        afterCommit: ({ retainedLocal }) => {
          expect(retainedLocal).toBe(true);
          expect(applyServerUiPrefs(initial, applied)).toBe(false);
        },
      },
    );

    expect(localStorage.getItem(retainedKey)).toBeNull();
    expect(applyPrefs({ theme: "dash" }, applied)).toBe(true);
    expect(loadSettings().theme).toBe("dash");
  });

  it("keeps offline intent through read-only reconnect and replays it after authorization", async () => {
    const writer = createClient(request, scope, false, { ok: true }, false);
    patchSettings({ theme: "knot" });

    pushServerUiPrefs(writer, { theme: "knot" });
    expect(readPending(scope)).toEqual({ theme: "knot" });
    expect(
      resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", scope, loadSettings(), {
        canSync: false,
      }),
    ).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "claw",
      value: "knot",
    });

    connect(writer);
    flushServerUiPrefs(writer);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(readPending(scope)).toEqual({ theme: "knot" });

    Object.assign(writer, { canPatch: true });
    flushServerUiPrefs(writer);
    await waitForRequest();
    await vi.waitFor(expectCleared);
  });

  it.each([
    [
      "scope replacement",
      "ws://new",
      () => pushServerUiPrefs(createClient(request, "ws://new", false), { locale: "de" }),
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
    pushServerUiPrefs(client, { locale: "de" });
    await queued.promise;
    change();
    gate.resolve();
    await resumed.promise;
    expect(request).not.toHaveBeenCalled();
    expect(readPending(pendingScope)).toEqual({ locale: "de" });
  });

  it("does not resurrect a sibling key another tab cancelled during a read-only edit", async () => {
    client = createClient(request, scope, false);

    pushServerUiPrefs(client, { locale: "de", theme: "knot" });
    storePending({ theme: "knot" });
    connect(client, false);
    pushServerUiPrefs(client, { themeMode: "dark" });

    expect(readPending(scope)).toEqual({ theme: "knot" });
    expect(request).not.toHaveBeenCalled();

    Object.assign(client, { canPatch: true });
    flushServerUiPrefs(client);
    await waitForRequest();
    expectPatch({ theme: "knot" });
  });

  it("dispatches a same-key replacement persisted by another tab", async () => {
    client = createClient(request, scope, false);

    pushServerUiPrefs(client, { theme: "knot" });
    storePending({ theme: "dash" });
    connect();
    flushServerUiPrefs(client);

    await waitForRequest();
    expectPatch({ theme: "dash" });
  });

  it("does not migrate cancelled pre-connection intent into an adopted gateway scope", async () => {
    const writer = createClient(request, "", false);
    Object.assign(writer.state, { client: null });

    pushServerUiPrefs(writer, { theme: "knot" });
    localStorage.removeItem(pendingKey(""));

    Object.assign(writer.state, createClient(request, "ws://first").state);
    flushServerUiPrefs(writer);
    pushServerUiPrefs(writer, { themeMode: "dark" });

    await waitForRequest();
    expectPatch({ themeMode: "dark" });
  });
});

/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { createProfilePrefsServer } from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";
const scope = "ws://navigation";
const pinsKey = "ui.railShortcuts";
const usage = "route:usage",
  cron = "route:cron",
  plugins = "route:plugins",
  systems = "route:systems";
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope;
const hooks = { profileId: "a", canWrite: true };
function holdFirstReply(
  a: ReturnType<ReturnType<typeof createProfilePrefsServer>["connect"]>,
  heldMethod = "users.prefs.set",
  firstOnly = true,
) {
  const original = a.request.getMockImplementation()!;
  const reply = createDeferred<unknown>();
  const reached = createDeferred();
  let held = false;
  let result: unknown;
  a.request.mockImplementation(async (method, params) => {
    const value = await original(method, params);
    if (method === heldMethod && (!firstOnly || !held)) {
      held = true;
      result = value;
      reached.resolve();
      return reply.promise;
    }
    return value;
  });
  return { reached: reached.promise, release: () => reply.resolve(result) };
}
const pushPins = (
  a: ReturnType<ReturnType<typeof createProfilePrefsServer>["connect"]>,
  sidebarEntries: string[],
  sidebarEntriesBase: string[],
) => pushServerUiPrefs(a.writer, { sidebarEntries, sidebarEntriesBase }, hooks);
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.unstubAllGlobals();
});

it.each(["a", "b"])(
  "retains the authenticated offline outbox when selfUser clears and reconnects as %s",
  async (reconnectedId) => {
    const backend = createProfilePrefsServer({
      a: { [pinsKey]: [usage] },
      b: { [pinsKey]: [cron] },
    });
    const a = backend.connect("a");
    await a.refresh();
    Object.assign(a.writer.state, { connected: false });
    const before = loadSettings();
    const next = patchSettings({ sidebarEntries: [plugins] });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(before, next)!, {
      profile: { selfUser: null, hello: null },
    });
    await vi.dynamicImportSettled();
    expect(JSON.parse(localStorage.getItem(pendingKey + ":profile:a") ?? "null")).toMatchObject({
      railShortcuts: [plugins],
    });
    expect(localStorage.getItem(pendingKey)).toBeNull();
    const reconnected = backend.connect(reconnectedId);
    flushServerUiPrefs(reconnected.writer, { profileId: reconnectedId, canWrite: true });
    await vi.dynamicImportSettled();
    expect(backend.profiles[reconnectedId]?.[pinsKey]).toEqual(
      reconnectedId === "a" ? [plugins] : [cron],
    );
    if (reconnectedId === "b") {
      expect(backend.profiles.a?.[pinsKey]).toEqual([usage]);
      flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
      Object.assign(a.writer.state, { connected: true });
      flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
      await vi.dynamicImportSettled();
    }
    expect(backend.profiles.a).toEqual({ [pinsKey]: [plugins] });
  },
);

it.each(["inverse", "inverse-with-remote", "new-pin"])(
  "replays authored order after an unknown acknowledgment reload (%s)",
  async (mode) => {
    const remoteSlot = mode === "inverse-with-remote";
    const initial = [usage, cron];
    const backend = createProfilePrefsServer({ a: { [pinsKey]: initial } });
    const a = backend.connect("a");
    await a.refresh();
    const held = holdFirstReply(a, "users.prefs.set", false);
    const desired = mode === "new-pin" ? [systems, ...initial] : initial;
    const first = patchSettings({
      sidebarEntries: mode === "new-pin" ? [...initial, systems] : initial.toReversed(),
    });
    pushPins(a, first.sidebarEntries, initial);
    await held.reached;
    const second = patchSettings({ sidebarEntries: desired });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(first, second)!, hooks);
    resetServerUiPrefsSync();
    held.release();
    if (remoteSlot) {
      backend.profiles.a![pinsKey] = [cron, plugins, usage];
    }
    const reloaded = backend.connect("a");
    flushServerUiPrefs(reloaded.writer, hooks);
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pinsKey]).toEqual(remoteSlot ? [usage, plugins, cron] : desired);
  },
);

it.each([false, true])(
  "does not borrow identity for an unauthenticated offline gateway (other=%s)",
  async (other) => {
    const backend = createProfilePrefsServer({ a: { [pinsKey]: [usage] } });
    if (other) {
      await backend.connect("a").refresh();
    }
    const destination = other ? "ws://other-gateway" : scope;
    const offline = createProfilePrefsServer({ b: { [pinsKey]: [cron] } }, destination).connect(
      "b",
    );
    Object.assign(offline.writer.state, { connected: false });
    pushServerUiPrefs(
      offline.writer,
      { sidebarEntries: [], sidebarEntriesBase: [] },
      { profile: { selfUser: null, hello: null } },
    );
    await vi.dynamicImportSettled();
    expect(
      localStorage.getItem("openclaw.control.serverPrefs.pending.v1:" + destination + ":profile:a"),
    ).toBeNull();
    Object.assign(offline.writer.state, { connected: true });
    flushServerUiPrefs(offline.writer, { profileId: "b", canWrite: true });
    await vi.dynamicImportSettled();
    expect(offline.request).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "settles only newer authored ordering after a successful prior reorder (reverse=%s)",
  async (reverse) => {
    const initial = [usage, cron, systems];
    const backend = createProfilePrefsServer({ a: { [pinsKey]: initial } });
    const a = backend.connect("a");
    const held = holdFirstReply(a);
    const first = [cron, usage, systems];
    pushPins(a, first, initial);
    await held.reached;
    pushPins(a, reverse ? initial : [...first, plugins], first);
    if (!reverse) {
      backend.profiles.a![pinsKey] = initial;
    }
    held.release();
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pinsKey]).toEqual(reverse ? initial : [...initial, plugins]);
    expect(localStorage.getItem(pendingKey + ":profile:a")).toBeNull();
    for (const [method, params] of a.request.mock.calls) {
      if (method === "users.prefs.set") {
        expect(Object.keys((params as { entries: object }).entries)).toEqual([pinsKey]);
      }
    }
  },
);

it.each(["users.prefs.get", "users.prefs.set"])(
  "preserves foreign order-only intent with the same desired/base pair during %s",
  async (heldMethod) => {
    const initial = [usage, cron];
    const backend = createProfilePrefsServer({ a: { [pinsKey]: initial.toReversed() } });
    const a = backend.connect("a");
    const held = holdFirstReply(a, heldMethod);
    pushPins(a, initial, initial);
    await held.reached;
    localStorage.setItem(
      pendingKey + ":profile:a",
      JSON.stringify({
        railShortcuts: initial,
        railShortcutsBase: initial,
        railShortcutsOrder: true,
      }),
    );
    held.release();
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pinsKey]).toEqual(initial);
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
      heldMethod === "users.prefs.set" ? 2 : 1,
    );
    expect(localStorage.getItem(pendingKey + ":profile:a")).toBeNull();
  },
);

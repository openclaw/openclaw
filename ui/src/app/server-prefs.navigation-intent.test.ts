/* @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import {
  createProfilePrefsServer,
  installServerPrefsStorage,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";
const scope = "ws://navigation";
const pinsKey = "ui.railShortcuts";
const usage = "route:usage",
  cron = "route:cron",
  plugins = "route:plugins",
  systems = "route:systems";
const pair = [usage, cron];
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope;
const hooks = { profileId: "a", canWrite: true };
const anonymous = { profile: { selfUser: null, hello: null } };
const pending = () => localStorage.getItem(pendingKey + ":profile:a");
let backend: ReturnType<typeof createProfilePrefsServer>;
let a: ReturnType<typeof backend.connect>;
function holdFirstReply(heldMethod = "users.prefs.set", firstOnly = true) {
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
const pushPins = (sidebarEntries: string[], sidebarEntriesBase: string[]) =>
  pushServerUiPrefs(a.writer, { sidebarEntries, sidebarEntriesBase }, hooks);
installServerPrefsStorage(scope);
beforeEach(() => {
  backend = createProfilePrefsServer({ a: { [pinsKey]: [usage] }, b: { [pinsKey]: [cron] } });
  a = backend.connect("a");
});

it.each(["a", "b"])("reconnect %s keeps the authenticated outbox", async (reconnectedId) => {
  await a.refresh();
  Object.assign(a.writer.state, { connected: false });
  const before = loadSettings();
  const next = patchSettings({ sidebarEntries: [plugins] });
  pushServerUiPrefs(a.writer, changedServerUiPrefs(before, next)!, anonymous);
  await vi.dynamicImportSettled();
  expect(JSON.parse(pending() ?? "null")).toMatchObject({ railShortcuts: [plugins] });
  expect(localStorage.getItem(pendingKey)).toBeNull();
  const reconnected = backend.connect(reconnectedId);
  flushServerUiPrefs(reconnected.writer, { profileId: reconnectedId, canWrite: true });
  await vi.dynamicImportSettled();
  expect(backend.profiles[reconnectedId]?.[pinsKey]).toEqual(
    reconnectedId === "a" ? [plugins] : [cron],
  );
  if (reconnectedId === "b") {
    expect(backend.profiles.a?.[pinsKey]).toEqual([usage]);
    flushServerUiPrefs(a.writer, hooks);
    Object.assign(a.writer.state, { connected: true });
    flushServerUiPrefs(a.writer, hooks);
    await vi.dynamicImportSettled();
  }
  expect(backend.profiles.a).toEqual({ [pinsKey]: [plugins] });
});

it.each(["inverse", "inverse-with-remote", "new-pin"])(
  "replays authored order after unknown acknowledgment: %s",
  async (mode) => {
    const remoteSlot = mode === "inverse-with-remote";
    backend.profiles.a = { [pinsKey]: pair };
    await a.refresh();
    const held = holdFirstReply("users.prefs.set", false);
    const desired = mode === "new-pin" ? [systems, ...pair] : pair;
    const first = patchSettings({
      sidebarEntries: mode === "new-pin" ? [...pair, systems] : pair.toReversed(),
    });
    pushPins(first.sidebarEntries, pair);
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

it.each([false, true])("never borrows an offline gateway identity (other=%s)", async (other) => {
  if (other) {
    await backend.connect("a").refresh();
  }
  const destination = other ? "ws://other-gateway" : scope;
  const offline = createProfilePrefsServer({ b: { [pinsKey]: [cron] } }, destination).connect("b");
  Object.assign(offline.writer.state, { connected: false });
  pushServerUiPrefs(offline.writer, { sidebarEntries: [], sidebarEntriesBase: [] }, anonymous);
  await vi.dynamicImportSettled();
  expect(
    localStorage.getItem("openclaw.control.serverPrefs.pending.v1:" + destination + ":profile:a"),
  ).toBeNull();
  Object.assign(offline.writer.state, { connected: true });
  flushServerUiPrefs(offline.writer, { profileId: "b", canWrite: true });
  await vi.dynamicImportSettled();
  expect(offline.request).not.toHaveBeenCalled();
});

it.each([false, true])("settles newer authored order (reverse=%s)", async (reverse) => {
  const initial = [usage, cron, systems];
  backend.profiles.a = { [pinsKey]: initial };
  const held = holdFirstReply();
  const first = [cron, usage, systems];
  pushPins(first, initial);
  await held.reached;
  pushPins(reverse ? initial : [...first, plugins], first);
  if (!reverse) {
    backend.profiles.a![pinsKey] = initial;
  }
  held.release();
  await vi.dynamicImportSettled();
  expect(backend.profiles.a?.[pinsKey]).toEqual(reverse ? initial : [...initial, plugins]);
  expect(pending()).toBeNull();
  for (const [method, params] of a.request.mock.calls) {
    if (method === "users.prefs.set") {
      expect(Object.keys((params as { entries: object }).entries)).toEqual([pinsKey]);
    }
  }
});

it.each(["users.prefs.get", "users.prefs.set"])(
  "preserves foreign order-only intent during %s",
  async (heldMethod) => {
    backend.profiles.a = { [pinsKey]: pair.toReversed() };
    const held = holdFirstReply(heldMethod);
    pushPins(pair, pair);
    await held.reached;
    localStorage.setItem(
      pendingKey + ":profile:a",
      JSON.stringify({
        railShortcuts: pair,
        railShortcutsBase: pair,
        railShortcutsOrder: true,
      }),
    );
    held.release();
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pinsKey]).toEqual(pair);
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
      heldMethod === "users.prefs.set" ? 2 : 1,
    );
    expect(pending()).toBeNull();
  },
);

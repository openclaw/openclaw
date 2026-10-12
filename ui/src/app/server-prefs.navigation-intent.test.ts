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
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope;
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
      a: { [pinsKey]: ["route:usage"] },
      b: { [pinsKey]: ["route:cron"] },
    });
    const a = backend.connect("a");
    await a.refresh();
    Object.assign(a.writer.state, { connected: false });
    const before = loadSettings();
    const next = patchSettings({ sidebarEntries: ["route:plugins"] });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(before, next)!, {
      profile: { selfUser: null, hello: null },
    });
    await vi.dynamicImportSettled();
    expect(JSON.parse(localStorage.getItem(pendingKey + ":profile:a") ?? "null")).toMatchObject({
      railShortcuts: ["route:plugins"],
    });
    expect(localStorage.getItem(pendingKey)).toBeNull();
    const reconnected = backend.connect(reconnectedId);
    flushServerUiPrefs(reconnected.writer, { profileId: reconnectedId, canWrite: true });
    await vi.dynamicImportSettled();
    expect(backend.profiles[reconnectedId]?.[pinsKey]).toEqual(
      reconnectedId === "a" ? ["route:plugins"] : ["route:cron"],
    );
    if (reconnectedId === "b") {
      expect(backend.profiles.a?.[pinsKey]).toEqual(["route:usage"]);
      flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
      Object.assign(a.writer.state, { connected: true });
      flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
      await vi.dynamicImportSettled();
    }
    expect(backend.profiles.a).toEqual({
      [pinsKey]: ["route:plugins"],
    });
  },
);

it.each(["inverse", "inverse-with-remote", "new-pin"])(
  "replays authored order after an unknown acknowledgment reload (%s)",
  async (mode) => {
    const remoteSlot = mode === "inverse-with-remote";
    const initial = ["route:usage", "route:cron"];
    const backend = createProfilePrefsServer({ a: { [pinsKey]: initial } });
    const a = backend.connect("a");
    await a.refresh();
    const original = a.request.getMockImplementation()!;
    const firstAck = createDeferred<unknown>();
    const committed = createDeferred();
    a.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === "users.prefs.set") {
        committed.resolve();
        return firstAck.promise;
      }
      return result;
    });
    const hooks = { profileId: "a", canWrite: true };
    const desired = mode === "new-pin" ? ["route:systems", ...initial] : initial;
    const first = patchSettings({
      sidebarEntries: mode === "new-pin" ? [...initial, "route:systems"] : initial.toReversed(),
    });
    pushServerUiPrefs(
      a.writer,
      { sidebarEntries: first.sidebarEntries, sidebarEntriesBase: initial },
      hooks,
    );
    await committed.promise;
    const second = patchSettings({ sidebarEntries: desired });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(first, second)!, hooks);
    resetServerUiPrefsSync();
    firstAck.resolve({ status: "ok" });
    if (remoteSlot) {
      backend.profiles.a![pinsKey] = ["route:cron", "route:plugins", "route:usage"];
    }
    const reloaded = backend.connect("a");
    flushServerUiPrefs(reloaded.writer, hooks);
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pinsKey]).toEqual(
      remoteSlot ? ["route:usage", "route:plugins", "route:cron"] : desired,
    );
  },
);

it.each([false, true])(
  "does not borrow identity for an unauthenticated offline gateway (other=%s)",
  async (other) => {
    const backend = createProfilePrefsServer({ a: { [pinsKey]: ["route:usage"] } });
    if (other) {
      await backend.connect("a").refresh();
    }
    const destination = other ? "ws://other-gateway" : scope;
    const offline = createProfilePrefsServer(
      { b: { [pinsKey]: ["route:cron"] } },
      destination,
    ).connect("b");
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
    const initial = ["route:usage", "route:cron", "route:systems"];
    const backend = createProfilePrefsServer({ a: { [pinsKey]: initial } });
    const a = backend.connect("a");
    const original = a.request.getMockImplementation()!;
    const firstAck = createDeferred<unknown>();
    const committed = createDeferred();
    let writes = 0;
    a.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === "users.prefs.set" && ++writes === 1) {
        committed.resolve();
        return firstAck.promise;
      }
      return result;
    });
    const first = ["route:cron", "route:usage", "route:systems"];
    const hooks = { profileId: "a", canWrite: true };
    pushServerUiPrefs(a.writer, { sidebarEntries: first, sidebarEntriesBase: initial }, hooks);
    await committed.promise;
    pushServerUiPrefs(
      a.writer,
      {
        sidebarEntries: reverse ? initial : [...first, "route:plugins"],
        sidebarEntriesBase: first,
      },
      hooks,
    );
    if (!reverse) {
      backend.profiles.a![pinsKey] = initial;
    }
    firstAck.resolve({ status: "ok" });
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pinsKey]).toEqual(
      reverse ? initial : [...initial, "route:plugins"],
    );
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
    const initial = ["route:usage", "route:cron"];
    const backend = createProfilePrefsServer({ a: { [pinsKey]: initial.toReversed() } });
    const a = backend.connect("a");
    const original = a.request.getMockImplementation()!;
    const reply = createDeferred<unknown>();
    const reached = createDeferred();
    let held = false;
    let heldResult: unknown;
    a.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === heldMethod && !held) {
        held = true;
        heldResult = result;
        reached.resolve();
        return reply.promise;
      }
      return result;
    });
    pushServerUiPrefs(
      a.writer,
      { sidebarEntries: initial, sidebarEntriesBase: initial },
      { profileId: "a", canWrite: true },
    );
    await reached.promise;
    localStorage.setItem(
      pendingKey + ":profile:a",
      JSON.stringify({
        railShortcuts: initial,
        railShortcutsBase: initial,
        railShortcutsOrder: true,
      }),
    );
    reply.resolve(heldResult);
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pinsKey]).toEqual(initial);
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
      heldMethod === "users.prefs.set" ? 2 : 1,
    );
    expect(localStorage.getItem(pendingKey + ":profile:a")).toBeNull();
  },
);

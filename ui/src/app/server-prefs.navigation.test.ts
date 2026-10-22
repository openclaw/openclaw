/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveServerUiPrefWriteStatus } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import {
  readProfileAppearancePrefs,
  writeProfileAppearancePrefs,
} from "./server-prefs-profile-runtime.ts";
import { applyServerUiPrefs, refreshProfileAppearancePrefs } from "./server-prefs-reconcile.ts";
import {
  createServerPrefsWriter,
  createProfilePrefsServer as server,
  installServerPrefsStorage,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs } from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";

const scope = "ws://navigation";
const pinsKey = "ui.railShortcuts";
const usage = "route:usage",
  cron = "route:cron",
  plugins = "route:plugins",
  systems = "route:systems";
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a";
const authority = { profileId: "a", canWrite: true };
const config = { ui: { prefs: { sidebarEntries: [usage, "plugin:workboard/workboard"] } } };
const pins = (sidebarEntries: string[], sidebarEntriesBase: string[]) => ({
  sidebarEntries,
  sidebarEntriesBase,
});
function holdFirstWrite(a: ReturnType<ReturnType<typeof server>["connect"]>, commit = true) {
  const original = a.request.getMockImplementation()!;
  const ack = createDeferred<unknown>();
  const started = createDeferred();
  let writes = 0;
  a.request.mockImplementation(async (method, params) => {
    if (method === "users.prefs.set" && ++writes === 1) {
      if (commit) {
        expect(await original(method, params)).toEqual({ status: "ok" });
      }
      started.resolve();
      return ack.promise;
    }
    return original(method, params);
  });
  return { ack, started };
}
function storedPins(value: ReturnType<typeof pins>) {
  return { railShortcuts: value.sidebarEntries, railShortcutsBase: value.sidebarEntriesBase };
}
installServerPrefsStorage(scope);

it.each(
  [
    {
      name: "newer observed base",
      initial: [cron],
      first: pins([], [usage]),
      newer: pins([], [cron]),
      committed: [cron],
      expected: [],
    },
    {
      name: "independent successor",
      initial: [usage],
      first: pins([usage, cron], [usage]),
      newer: pins([usage, plugins], [usage]),
      committed: [usage, cron],
      expected: [usage, plugins, cron],
    },
  ].flatMap((scenario) =>
    ["storage", "same-tab"].map((replacement) => Object.assign({ replacement }, scenario)),
  ),
)(
  "preserves $name across an older ack ($replacement)",
  async ({ initial, first, newer, committed, expected, replacement }) => {
    const backend = server({ a: { [pinsKey]: initial } });
    const a = backend.connect("a");
    const held = holdFirstWrite(a);
    let pendingAtFirstAck: unknown;
    let acknowledgments = 0;
    const hooks = {
      ...authority,
      afterCommit: () => {
        if (++acknowledgments === 1) {
          pendingAtFirstAck = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
        }
      },
    };
    pushServerUiPrefs(a.writer, first, hooks);
    await held.started.promise;
    expect(backend.profiles.a?.[pinsKey]).toEqual(committed);
    if (replacement === "storage") {
      localStorage.setItem(pendingKey, JSON.stringify(storedPins(newer)));
    } else {
      pushServerUiPrefs(a.writer, newer, hooks);
    }
    held.ack.resolve({ status: "ok" });
    await vi.dynamicImportSettled();
    expect(pendingAtFirstAck).toEqual(storedPins(newer));
    expect(backend.profiles.a?.[pinsKey]).toEqual(expected);
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(2);
    expect(localStorage.getItem(pendingKey)).toBeNull();
  },
);

it("honors another tab cancelling a pin edit during its CAS read", async () => {
  const backend = server({ a: { [pinsKey]: [usage] } });
  const a = backend.connect("a");
  const original = a.request.getMockImplementation()!;
  const started = createDeferred();
  const response = createDeferred<unknown>();
  a.request.mockImplementation(async (method, params) => {
    if (method === "users.prefs.get") {
      started.resolve();
      return response.promise;
    }
    return original(method, params);
  });
  const afterCommit = vi.fn();
  pushServerUiPrefs(a.writer, pins([usage, cron], [usage]), { ...authority, afterCommit });
  await started.promise;
  localStorage.removeItem(pendingKey);
  response.resolve({ status: "ok", entries: { [pinsKey]: [usage] } });
  await vi.dynamicImportSettled();
  expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([]);
  expect(backend.profiles.a?.[pinsKey]).toEqual([usage]);
  expect(afterCommit).not.toHaveBeenCalled();
});

it("strips browser-only edit metadata when a profileless mixed change retains only appearance", async () => {
  const request = vi.fn(async () => ({}));
  const writer = createServerPrefsWriter(request, scope);
  const committed = createDeferred();
  pushServerUiPrefs(
    writer,
    { themeMode: "dark", sidebarEntries: [], sidebarEntriesBase: [usage] },
    {
      afterCommit: ({ retainedLocal }) => {
        if (!retainedLocal) {
          committed.resolve();
        }
      },
    },
  );
  await committed.promise;
  expect(request).toHaveBeenCalledExactlyOnceWith("config.patch", {
    raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
    note: "control-ui prefs sync",
  });
});

it("does not infer an unknown edit base from a fresh server read", async () => {
  const a = server({ a: { [pinsKey]: [usage, cron] } }).connect("a");
  const result = await writeProfileAppearancePrefs(
    a.writer.state.client,
    { sidebarEntries: [usage] },
    true,
    "a",
  );
  expect(result).toMatchObject({ ok: false, reason: "rejected" });
  expect(a.request).toHaveBeenCalledExactlyOnceWith("users.prefs.get", expect.anything());
});

it("retains repeated CAS conflicts for reconnect without overwriting remote edits", async () => {
  vi.useFakeTimers();
  const backend = server({ a: { [pinsKey]: [usage] } });
  const a = backend.connect("a");
  await a.refresh();
  const original = a.request.getMockImplementation()!;
  const started = createDeferred();
  const committed = vi.fn();
  let attempts = 0;
  a.request.mockImplementation(async (method, params) => {
    if (method === "users.prefs.set") {
      attempts += 1;
      if (attempts < 3) {
        backend.profiles.a = {
          [pinsKey]: attempts === 1 ? [usage, cron] : [cron, systems],
        };
        started.resolve();
        return { status: "conflict" };
      }
    }
    return original(method, params);
  });
  patchSettings({ sidebarEntries: [usage, plugins] });
  pushServerUiPrefs(a.writer, pins([usage, plugins], [usage]), {
    ...authority,
    afterCommit: committed,
  });
  await started.promise;
  await vi.runAllTimersAsync();
  expect(committed).not.toHaveBeenCalled();
  expect(attempts).toBe(2);
  expect(backend.profiles.a?.[pinsKey]).toEqual([cron, systems]);
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a")).toMatchObject({
    status: "error",
  });
  expect(JSON.parse(localStorage.getItem(pendingKey)!).railShortcuts).toEqual([usage, plugins]);
  flushServerUiPrefs(a.writer, { ...authority, afterCommit: committed });
  await vi.dynamicImportSettled();
  expect(committed).toHaveBeenCalledOnce();
  expect(attempts).toBe(3);
  expect(backend.profiles.a?.[pinsKey]).toEqual([cron, systems, plugins]);
  expect(loadSettings().sidebarEntries).toEqual(backend.profiles.a?.[pinsKey]);
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a").status).toBe("saved");
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

it.each(["readd", "readd-identical"])(
  "settles composed intent without losing remote removals or explicit readds (%s)",
  async (mode) => {
    const backend = server({ a: { [pinsKey]: [usage] } });
    const a = backend.connect("a");
    await a.refresh();
    const held = holdFirstWrite(a);
    const settled = createDeferred();
    let commits = 0;
    const hooks = {
      ...authority,
      afterCommit: () => {
        if (++commits === 2) {
          settled.resolve();
        }
      },
    };
    const before = loadSettings();
    const first = patchSettings({ sidebarEntries: [usage, plugins] });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(before, first)!, hooks);
    await held.started.promise;
    const second = patchSettings({
      sidebarEntries: mode === "readd-identical" ? first.sidebarEntries : [plugins, systems],
    });
    const removed = patchSettings({
      sidebarEntries: second.sidebarEntries.filter((entry) => entry !== plugins),
    });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(first, removed)!, hooks);
    patchSettings({ sidebarEntries: second.sidebarEntries });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(removed, second)!, hooks);
    backend.profiles.a = { [pinsKey]: [cron] };
    held.ack.resolve({ status: "ok" });
    await settled.promise;
    expect(backend.profiles.a?.[pinsKey]).toEqual(
      mode === "readd" ? [cron, plugins, systems] : [cron, plugins],
    );
  },
);

it("ignores another profile's shared browser mirror even before its storage event", async () => {
  const a = server({ a: { [pinsKey]: [usage] } }).connect("a");
  await a.refresh();
  const key = settingsKeyForGateway(scope);
  const stored = JSON.parse(localStorage.getItem(key)!);
  localStorage.setItem(
    key,
    JSON.stringify({
      ...stored,
      sidebarEntries: ["session:private-b"],
      navWidth: 360,
    }),
  );
  expect(loadSettings()).toMatchObject({ sidebarEntries: [usage], navWidth: 360 });
  patchSettings({ sidebarEntries: [cron] });
  expect(loadSettings()).toMatchObject({ sidebarEntries: [cron] });
});

it("restores only the selected profile's pending pins while its read is unavailable", async () => {
  const a = server({ a: { [pinsKey]: [usage] } }).connect("a");
  await a.refresh();
  localStorage.setItem(
    "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:b",
    JSON.stringify({ railShortcuts: [cron] }),
  );
  applyServerUiPrefs(config, { scope, profileId: "b", onApplied: vi.fn() });
  expect(loadSettings()).toMatchObject({ sidebarEntries: [cron] });
  applyServerUiPrefs({ ...config }, { scope, profileId: "b", onApplied: vi.fn() });
  expect(loadSettings().sidebarEntries).toEqual([cron]);
});

it("ignores an old client's read after reconnect and drains through the new client", async () => {
  const oldRead = createDeferred<unknown>();
  const started = createDeferred();
  const oldRequest = vi.fn(() => {
    started.resolve();
    return oldRead.promise;
  });
  const writer = createServerPrefsWriter(oldRequest, scope);
  const next = server().connect("a");
  const committed = createDeferred();
  const hooks = { profileId: "a", canWrite: true, afterCommit: () => committed.resolve() };
  pushServerUiPrefs(writer, { sidebarEntries: [cron], sidebarEntriesBase: [] }, hooks);
  await started.promise;
  Object.assign(writer.state, { client: next.writer.state.client });
  flushServerUiPrefs(writer, hooks);
  oldRead.resolve({ status: "ok", entries: {} });
  await committed.promise;
  expect(oldRequest).toHaveBeenCalledOnce();
  expect(next.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
    1,
  );
});

it("does not write after an incomplete first read", async () => {
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({
    status: "no_durable_identity",
  }));
  const writer = createServerPrefsWriter(request, scope);
  expect(await readProfileAppearancePrefs(writer.state.client!, "a")).toBeNull();
  expect(
    await writeProfileAppearancePrefs(writer.state.client, { sidebarEntries: [] }, true, "a"),
  ).toMatchObject({ ok: false, reason: "unavailable" });
  expect(request.mock.calls.every(([method]) => method === "users.prefs.get")).toBe(true);
});

it("reads saved shortcuts unchanged without importing shared navigation", async () => {
  const saved = [cron, "session:agent:main:saved"];
  patchSettings({ sidebarEntries: ["session:private-other-user"] });
  const backend = server({ a: { [pinsKey]: saved } });
  const connection = backend.connect("a");
  await connection.refresh();
  expect(loadSettings().sidebarEntries).toEqual(saved);
  expect(backend.profiles.a).toEqual({ [pinsKey]: saved });
  expect(connection.request.mock.calls.map(([method]) => method)).toEqual(["users.prefs.get"]);
});

it.each(["read", "write"])(
  "fences a late profile %s after authority changes",
  async (operation) => {
    const deferred = createDeferred<unknown>();
    const request = vi.fn(() => deferred.promise);
    const writer = createServerPrefsWriter(request, scope);
    let current = true;
    const pending =
      operation === "read"
        ? refreshProfileAppearancePrefs({
            client: writer.state.client!,
            profileId: "a",
            configObject: config,
            scope,
            isCurrent: () => current,
            onApplied: vi.fn(),
          })
        : writeProfileAppearancePrefs(
            writer.state.client,
            { sidebarEntries: [] },
            () => current,
            "a",
          );
    current = false;
    deferred.resolve({ status: "ok", entries: {} });
    expect(await pending).toEqual(
      operation === "read" ? false : expect.objectContaining({ ok: false, reason: "unavailable" }),
    );
    expect(request).toHaveBeenCalledOnce();
  },
);

it("never writes offline profileless navigation to global config", async () => {
  const request = vi.fn(async () => ({}));
  const writer = createServerPrefsWriter(request, scope, false);
  pushServerUiPrefs(writer, { sidebarEntries: [] });
  Object.assign(writer.state, { connected: true });
  flushServerUiPrefs(writer);
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
});

it("serializes rapid reorders and retries CAS conflicts without losing newest intent", async () => {
  vi.useFakeTimers();
  const backend = server({ a: { [pinsKey]: [usage, cron] } });
  const a = backend.connect("a");
  await a.refresh();
  const held = holdFirstWrite(a, false);
  const committed = createDeferred();
  const hooks = { profileId: "a", canWrite: true, afterCommit: () => committed.resolve() };
  pushServerUiPrefs(a.writer, pins([cron, usage], [usage, cron]), hooks);
  await held.started.promise;
  pushServerUiPrefs(a.writer, pins([cron], [cron, usage]), hooks);
  held.ack.resolve({ status: "conflict" });
  await vi.advanceTimersByTimeAsync(250);
  await committed.promise;
  expect(backend.profiles.a?.[pinsKey]).toEqual([cron]);
  expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(2);
});

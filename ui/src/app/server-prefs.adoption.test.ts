/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resolveServerUiPrefWriteStatus } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { createProfilePrefsServer } from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://navigation";
const pins = "ui.railShortcuts";
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a";
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["empty", "order"])(
  "folds newly persisted sibling pins into an adopted %s writer",
  async (mode) => {
    const backend = createProfilePrefsServer({
      a: {
        [pins]: mode === "order" ? ["route:cron", "route:usage"] : ["route:usage"],
      },
    });
    const b = backend.connect("a");
    await b.refresh();
    Object.assign(b.writer.state, { connected: false });
    const hooks = { profileId: "a", canWrite: true };
    flushServerUiPrefs(b.writer, hooks);
    // Another realm persists its offline addition after B adopted an empty pin pool.
    localStorage.setItem(
      pendingKey,
      JSON.stringify({
        railShortcuts: ["route:usage", "route:cron"],
        railShortcutsBase: mode === "order" ? ["route:usage", "route:cron"] : ["route:usage"],
        ...(mode === "order" ? { railShortcutsOrder: true } : {}),
      }),
    );
    patchSettings({ sidebarEntries: ["route:usage", "route:cron"] });
    const before = loadSettings();
    const next = patchSettings({ sidebarEntries: [...before.sidebarEntries, "route:plugins"] });
    pushServerUiPrefs(b.writer, changedServerUiPrefs(before, next)!, hooks);
    await vi.dynamicImportSettled();
    const queued = JSON.parse(localStorage.getItem(pendingKey)!);
    Object.assign(b.writer.state, { connected: true });
    flushServerUiPrefs(b.writer, hooks);
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pins]).toEqual(["route:usage", "route:cron", "route:plugins"]);
    expect(queued).toMatchObject({
      railShortcuts: ["route:usage", "route:cron", "route:plugins"],
      railShortcutsBase: mode === "order" ? ["route:usage", "route:cron"] : ["route:usage"],
      ...(mode === "order" ? { railShortcutsOrder: true } : {}),
    });
    expect(localStorage.getItem(pendingKey)).toBeNull();
  },
);

it("flushes a sibling's new pool after the same adopted writer reconnects", async () => {
  const backend = createProfilePrefsServer({ a: { [pins]: ["route:usage"] } });
  const b = backend.connect("a");
  Object.assign(b.writer.state, { connected: false });
  const hooks = { profileId: "a", canWrite: true };
  flushServerUiPrefs(b.writer, hooks);
  localStorage.setItem(
    pendingKey,
    JSON.stringify({
      railShortcuts: ["route:usage", "route:cron"],
      railShortcutsBase: ["route:usage"],
    }),
  );
  Object.assign(b.writer.state, { connected: true });
  flushServerUiPrefs(b.writer, hooks);
  await vi.dynamicImportSettled();
  expect(backend.profiles.a?.[pins]).toEqual(["route:usage", "route:cron"]);
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

const lastSeenKey = "openclaw.control.serverPrefs.v1:" + scope + ":profile:a";

it("ignores legacy pending, last-seen, and retained navigation without replaying it", async () => {
  const legacyEntries = ["route:usage", "plugin:workboard/workboard", "session:agent:main:legacy"];
  const backend = createProfilePrefsServer({ a: {} });
  const a = backend.connect("a");
  const retainedKey = "openclaw.control.serverPrefs.retained-local.v1:" + scope + ":profile:a";
  const legacyPending = {
    sidebarEntries: legacyEntries,
    sidebarEntriesBase: [],
    sidebarEntriesOrder: true,
  };
  localStorage.setItem(pendingKey, JSON.stringify(legacyPending));
  localStorage.setItem(
    lastSeenKey,
    JSON.stringify({
      sidebarEntries: legacyEntries,
      navigationConfirmation: { sidebarEntries: "legacy-read" },
    }),
  );
  localStorage.setItem(retainedKey, JSON.stringify({ sidebarEntries: true }));
  flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
  await a.refresh();
  await vi.dynamicImportSettled();
  expect(loadSettings().sidebarEntries).toEqual([]);
  expect(a.request.mock.calls.map(([method]) => method)).toEqual(["users.prefs.get"]);
  expect(backend.profiles.a).toEqual({});
  expect(JSON.parse(localStorage.getItem(pendingKey)!)).toMatchObject(legacyPending);
  const lastSeen = JSON.parse(localStorage.getItem(lastSeenKey)!);
  expect(lastSeen).not.toHaveProperty("sidebarEntries");
  expect(lastSeen.navigationConfirmation).not.toHaveProperty("sidebarEntries");
  expect(JSON.parse(localStorage.getItem(retainedKey)!)).toMatchObject({ sidebarEntries: true });
});

it("does not admit or re-persist a legacy-only outbox when another preference is queued", () => {
  const backend = createProfilePrefsServer({ a: {} });
  const connection = backend.connect("a");
  Object.assign(connection.writer.state, { connected: false });
  const hooks = { profileId: "a", canWrite: true };
  localStorage.setItem(pendingKey, JSON.stringify({ sidebarEntries: ["route:usage"] }));

  flushServerUiPrefs(connection.writer, hooks);
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a").status).toBe("saved");
  pushServerUiPrefs(connection.writer, { accent: "#ff0000" }, hooks);

  expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ accent: "#ff0000" });
  expect(connection.request).not.toHaveBeenCalled();
});

it("does not retrofit a newly authored baseless write from a legacy mirror", async () => {
  const backend = createProfilePrefsServer({ a: { [pins]: ["route:usage"] } });
  const connection = backend.connect("a");
  localStorage.setItem(lastSeenKey, JSON.stringify({ sidebarEntries: ["route:usage"] }));
  const desired = ["route:plugins"];
  patchSettings({ sidebarEntries: desired });
  pushServerUiPrefs(
    connection.writer,
    { sidebarEntries: desired, accent: "#ff0000" },
    { profileId: "a", canWrite: true },
  );
  await vi.dynamicImportSettled();
  expect(backend.profiles.a?.[pins]).toEqual(["route:usage"]);
  expect(backend.profiles.a?.["ui.accent"]).toBe("#ff0000");
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a").status).toBe("error");
});

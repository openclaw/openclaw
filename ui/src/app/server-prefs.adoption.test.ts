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
const hooks = { profileId: "a", canWrite: true };
const store = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
const stored = (key: string) => JSON.parse(localStorage.getItem(key)!);
function connect(entries: Record<string, unknown> = {}) {
  const server = createProfilePrefsServer({ a: entries });
  return { ...server, ...server.connect("a") };
}
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

it.each(["empty", "order", "reconnect"])("adopts sibling pins across %s writes", async (mode) => {
  const b = connect({
    [pins]: mode === "order" ? ["route:cron", "route:usage"] : ["route:usage"],
  });
  if (mode !== "reconnect") {
    await b.refresh();
  }
  b.writer.state.connected = false;
  flushServerUiPrefs(b.writer, hooks);
  // Another realm persists its offline addition after B adopted an empty pin pool.
  const pending = {
    railShortcuts: ["route:usage", "route:cron"],
    railShortcutsBase: mode === "order" ? ["route:usage", "route:cron"] : ["route:usage"],
    ...(mode === "order" ? { railShortcutsOrder: true } : {}),
  };
  store(pendingKey, pending);
  if (mode !== "reconnect") {
    patchSettings({ sidebarEntries: ["route:usage", "route:cron"] });
    const before = loadSettings();
    const next = patchSettings({ sidebarEntries: [...before.sidebarEntries, "route:plugins"] });
    pushServerUiPrefs(b.writer, changedServerUiPrefs(before, next)!, hooks);
    await vi.dynamicImportSettled();
  }
  const queued = stored(pendingKey);
  b.writer.state.connected = true;
  flushServerUiPrefs(b.writer, hooks);
  await vi.dynamicImportSettled();
  const expected = [
    "route:usage",
    "route:cron",
    ...(mode === "reconnect" ? [] : ["route:plugins"]),
  ];
  expect(b.profiles.a?.[pins]).toEqual(expected);
  expect(queued).toMatchObject({ ...pending, railShortcuts: expected });
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

const lastSeenKey = "openclaw.control.serverPrefs.v1:" + scope + ":profile:a";

it("ignores legacy pending, last-seen, and retained navigation without replaying it", async () => {
  const legacyEntries = ["route:usage", "plugin:workboard/workboard", "session:agent:main:legacy"];
  const a = connect();
  const retainedKey = "openclaw.control.serverPrefs.retained-local.v1:" + scope + ":profile:a";
  const legacyPending = {
    sidebarEntries: legacyEntries,
    sidebarEntriesBase: [],
    sidebarEntriesOrder: true,
  };
  store(pendingKey, legacyPending);
  store(lastSeenKey, {
    sidebarEntries: legacyEntries,
    navigationConfirmation: { sidebarEntries: "legacy-read" },
  });
  store(retainedKey, { sidebarEntries: true });
  flushServerUiPrefs(a.writer, hooks);
  await a.refresh();
  await vi.dynamicImportSettled();
  expect(loadSettings().sidebarEntries).toEqual([]);
  expect(a.request.mock.calls.map(([method]) => method)).toEqual(["users.prefs.get"]);
  expect(a.profiles.a).toEqual({});
  expect(stored(pendingKey)).toMatchObject(legacyPending);
  expect(stored(lastSeenKey)).not.toHaveProperty("sidebarEntries");
  expect(stored(retainedKey)).toMatchObject({ sidebarEntries: true });
});

it("does not admit or re-persist a legacy-only outbox when another preference is queued", () => {
  const connection = connect();
  connection.writer.state.connected = false;
  store(pendingKey, { sidebarEntries: ["route:usage"] });

  flushServerUiPrefs(connection.writer, hooks);
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a").status).toBe("saved");
  pushServerUiPrefs(connection.writer, { accent: "#ff0000" }, hooks);

  expect(stored(pendingKey)).toEqual({ accent: "#ff0000" });
  expect(connection.request).not.toHaveBeenCalled();
});

it("does not retrofit a newly authored baseless write from a legacy mirror", async () => {
  const connection = connect({ [pins]: ["route:usage"] });
  store(lastSeenKey, { sidebarEntries: ["route:usage"] });
  const desired = ["route:plugins"];
  patchSettings({ sidebarEntries: desired });
  pushServerUiPrefs(connection.writer, { sidebarEntries: desired, accent: "#ff0000" }, hooks);
  await vi.dynamicImportSettled();
  expect(connection.profiles.a).toMatchObject({ [pins]: ["route:usage"], "ui.accent": "#ff0000" });
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a").status).toBe("error");
});

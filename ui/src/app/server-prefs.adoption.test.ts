/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsersPrefsSetParams } from "../../../packages/gateway-protocol/src/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resolveServerUiPrefWriteStatus } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { createProfilePrefsServer } from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://navigation";
const pins = "ui.sidebarEntries";
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

it.each(["empty", "scope", "unpersisted-scope", "order"])(
  "folds newly persisted sibling pins into an adopted %s writer",
  async (mode) => {
    const editsScope = mode === "scope" || mode === "unpersisted-scope";
    const backend = createProfilePrefsServer({
      a: {
        [pins]: mode === "order" ? ["route:cron", "route:usage"] : ["route:usage"],
        "ui.navigationScope": "mine",
      },
    });
    const b = backend.connect("a");
    await b.refresh();
    Object.assign(b.writer.state, { connected: false });
    const hooks = { profileId: "a", canWrite: true };
    flushServerUiPrefs(b.writer, hooks);
    if (editsScope) {
      const originalSet = localStorage.setItem.bind(localStorage);
      const quota =
        mode === "unpersisted-scope"
          ? vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
              if (key === pendingKey) {
                throw new Error("quota");
              }
              originalSet(key, value);
            })
          : null;
      const previous = loadSettings();
      const next = patchSettings({ navigationScope: "all" });
      pushServerUiPrefs(b.writer, changedServerUiPrefs(previous, next)!, hooks);
      await vi.dynamicImportSettled();
      quota?.mockRestore();
    }
    // Another realm persists its offline addition after B adopted an empty pin pool.
    localStorage.setItem(
      pendingKey,
      JSON.stringify({
        sidebarEntries: ["route:usage", "route:cron"],
        sidebarEntriesBase: mode === "order" ? ["route:usage", "route:cron"] : ["route:usage"],
        ...(mode === "order" ? { sidebarEntriesOrder: true } : {}),
        ...(mode === "scope"
          ? { navigationScope: "all" }
          : mode === "unpersisted-scope"
            ? { navigationScope: "mine" }
            : {}),
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
      sidebarEntries: ["route:usage", "route:cron", "route:plugins"],
      sidebarEntriesBase: mode === "order" ? ["route:usage", "route:cron"] : ["route:usage"],
      ...(mode === "order" ? { sidebarEntriesOrder: true } : {}),
    });
    if (editsScope) {
      expect(backend.profiles.a?.["ui.navigationScope"]).toBe("all");
    }
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
      sidebarEntries: ["route:usage", "route:cron"],
      sidebarEntriesBase: ["route:usage"],
    }),
  );
  Object.assign(b.writer.state, { connected: true });
  flushServerUiPrefs(b.writer, hooks);
  await vi.dynamicImportSettled();
  expect(backend.profiles.a?.[pins]).toEqual(["route:usage", "route:cron"]);
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

const lastSeenKey = "openclaw.control.serverPrefs.v1:" + scope + ":profile:a";

function stableOutboxServer(remote: string[]) {
  const backend = createProfilePrefsServer({ a: { [pins]: remote } });
  const connection = backend.connect("a");
  const original = connection.request.getMockImplementation()!;
  connection.request.mockImplementation(async (method, raw) => {
    const params = raw as UsersPrefsSetParams | undefined;
    if (method === "users.prefs.set" && params?.entries && !params.expectedEntries) {
      Object.assign(backend.profiles.a!, params.entries);
      return { status: "ok" };
    }
    return original(method, raw);
  });
  return { ...backend, ...connection };
}

it.each([
  {
    base: ["route:usage", "route:cron"],
    desired: ["route:cron", "route:plugins"],
    remote: ["route:usage", "route:cron", "route:systems"],
    expected: ["route:cron", "route:plugins", "route:systems"],
  },
  { base: ["route:usage"], desired: [], remote: ["route:usage"], expected: [] },
  {
    base: [],
    desired: ["route:usage"],
    remote: ["route:cron"],
    expected: ["route:cron", "route:usage"],
  },
])(
  "replays the stable pending outbox from its recorded baseline ($desired)",
  async ({ base, desired, remote, expected }) => {
    const backend = stableOutboxServer(remote);
    // v2026.9.9 changedServerUiPrefs persists this payload without edit metadata.
    localStorage.setItem(lastSeenKey, JSON.stringify({ sidebarEntries: base }));
    localStorage.setItem(
      pendingKey,
      JSON.stringify({ sidebarEntries: desired, accent: "#ff0000" }),
    );
    patchSettings({ sidebarEntries: desired, accent: "#ff0000" });
    Object.assign(backend.writer.state, { connected: false });
    flushServerUiPrefs(backend.writer, { profileId: "a", canWrite: true });
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toMatchObject({
      sidebarEntriesBase: base,
    });
    expect(backend.request).not.toHaveBeenCalled();
    // A later profile confirmation cannot replace the frozen pre-upgrade observation.
    localStorage.setItem(
      lastSeenKey,
      JSON.stringify({
        sidebarEntries: remote,
        navigationConfirmation: { sidebarEntries: "new-read" },
      }),
    );
    Object.assign(backend.writer.state, { connected: true });
    flushServerUiPrefs(backend.writer, { profileId: "a", canWrite: true });
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pins]).toEqual(expected);
    expect(backend.profiles.a?.["ui.accent"]).toBe("#ff0000");
    expect(backend.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([
      ["users.prefs.set", { entries: { [pins]: expected }, expectedEntries: { [pins]: remote } }],
      ["users.prefs.set", { entries: { "ui.accent": "#ff0000" } }],
    ]);
    expect(localStorage.getItem(pendingKey)).toBeNull();
    resetServerUiPrefsSync();
    flushServerUiPrefs(backend.writer, { profileId: "a", canWrite: true });
    await vi.dynamicImportSettled();
    expect(
      backend.request.mock.calls.filter(([method]) => method === "users.prefs.set"),
    ).toHaveLength(2);
  },
);

it.each([
  null,
  "{",
  JSON.stringify({ sidebarEntries: ["invalid-reference"] }),
  JSON.stringify({ sidebarEntries: [], navigationConfirmation: { sidebarEntries: "new-read" } }),
])("retains baseless stable intent locally without blocking appearance (%s)", async (baseline) => {
  const desired = ["route:plugins"];
  const remote = ["route:usage"];
  const backend = stableOutboxServer(remote);
  if (baseline !== null) {
    localStorage.setItem(lastSeenKey, baseline);
  }
  // Neither another profile nor the unscoped mirror can authorize this rebase.
  localStorage.setItem(
    lastSeenKey.replace(":profile:a", ":profile:b"),
    JSON.stringify({ sidebarEntries: [] }),
  );
  localStorage.setItem(
    lastSeenKey.replace(":profile:a", ""),
    JSON.stringify({ sidebarEntries: [] }),
  );
  localStorage.setItem(
    lastSeenKey.replace(scope, "ws://other"),
    JSON.stringify({ sidebarEntries: [] }),
  );
  localStorage.setItem(pendingKey, JSON.stringify({ sidebarEntries: desired, accent: "#ff0000" }));
  patchSettings({ sidebarEntries: desired, accent: "#ff0000" });
  flushServerUiPrefs(backend.writer, { profileId: "a", canWrite: true });
  await vi.dynamicImportSettled();
  expect(backend.profiles.a?.[pins]).toEqual(remote);
  expect(backend.profiles.a?.["ui.accent"]).toBe("#ff0000");
  expect(loadSettings().sidebarEntries).toEqual(desired);
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a")).toMatchObject({
    status: "error",
  });
  expect(backend.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([
    ["users.prefs.set", { entries: { "ui.accent": "#ff0000" } }],
  ]);
});

it("does not retrofit a newly authored baseless write from a legacy mirror", async () => {
  const backend = stableOutboxServer(["route:usage"]);
  localStorage.setItem(lastSeenKey, JSON.stringify({ sidebarEntries: ["route:usage"] }));
  const desired = ["route:plugins"];
  patchSettings({ sidebarEntries: desired });
  pushServerUiPrefs(
    backend.writer,
    { sidebarEntries: desired, accent: "#ff0000" },
    { profileId: "a", canWrite: true },
  );
  await vi.dynamicImportSettled();
  expect(backend.profiles.a?.[pins]).toEqual(["route:usage"]);
  expect(backend.profiles.a?.["ui.accent"]).toBe("#ff0000");
  expect(resolveServerUiPrefWriteStatus("sidebarEntries", scope, "a").status).toBe("error");
});

/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { DEFAULT_SIDEBAR_ENTRIES } from "../app-navigation.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import {
  readProfileAppearancePrefs,
  writeProfileAppearancePrefs,
} from "./server-prefs-profile-runtime.ts";
import { applyServerUiPrefs, refreshProfileAppearancePrefs } from "./server-prefs-reconcile.ts";
import {
  createServerPrefsWriter,
  createProfilePrefsServer as server,
  pinnedPage,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

const scope = "ws://navigation";
const pinsKey = "ui.sidebarEntries";
const scopeKey = "ui.navigationScope";
const config = { ui: { prefs: { sidebarEntries: ["route:usage", "plugin:workboard/workboard"] } } };
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("personal navigation preference boundary", () => {
  it("keeps a composed removal through reload before the older write is acknowledged", async () => {
    const backend = server({ a: { [pinsKey]: ["route:usage"] } });
    const a = backend.connect("a");
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
    const first = {
      sidebarEntries: ["route:usage", "route:cron"],
      sidebarEntriesBase: ["route:usage"],
    };
    pushServerUiPrefs(a.writer, first, { profileId: "a", canWrite: true });
    await committed.promise;
    pushServerUiPrefs(
      a.writer,
      {
        sidebarEntries: ["route:usage", "route:plugins"],
        sidebarEntriesBase: first.sidebarEntries,
      },
      { profileId: "a", canWrite: true },
    );
    resetServerUiPrefsSync();
    firstAck.resolve({ status: "ok" });
    const reloaded = backend.connect("a");
    const completed = createDeferred();
    flushServerUiPrefs(reloaded.writer, {
      profileId: "a",
      canWrite: true,
      afterCommit: () => completed.resolve(),
    });
    await completed.promise;
    expect(backend.profiles.a?.[pinsKey]).toEqual(["route:usage", "route:plugins"]);
  });

  it.each(["storage", "same-tab"])(
    "keeps identical desired pins with a newer observed base across an older ack (%s)",
    async (replacement) => {
      const backend = server({ a: { [pinsKey]: ["route:cron"] } });
      const a = backend.connect("a");
      const original = a.request.getMockImplementation()!;
      const firstAck = createDeferred<unknown>();
      const committed = createDeferred();
      let writes = 0;
      a.request.mockImplementation(async (method, params) => {
        const result = await original(method, params);
        if (method === "users.prefs.set" && ++writes === 1) {
          expect(result).toEqual({ status: "ok" });
          committed.resolve();
          return firstAck.promise;
        }
        return result;
      });
      const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a";
      const newer = { sidebarEntries: [], sidebarEntriesBase: ["route:cron"] };
      let pendingAtFirstAck: unknown;
      let acknowledgments = 0;
      const hooks = {
        profileId: "a",
        canWrite: true,
        afterCommit: () => {
          if (++acknowledgments === 1) {
            pendingAtFirstAck = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
          }
        },
      };
      pushServerUiPrefs(
        a.writer,
        { sidebarEntries: [], sidebarEntriesBase: ["route:usage"] },
        hooks,
      );
      await committed.promise;
      expect(backend.profiles.a?.[pinsKey]).toEqual(["route:cron"]);
      if (replacement === "storage") {
        localStorage.setItem(pendingKey, JSON.stringify(newer));
      } else {
        pushServerUiPrefs(a.writer, newer, hooks);
      }
      firstAck.resolve({ status: "ok" });
      await vi.dynamicImportSettled();
      expect(pendingAtFirstAck).toEqual(newer);
      expect(backend.profiles.a?.[pinsKey]).toEqual([]);
      expect(writes).toBe(2);
      expect(localStorage.getItem(pendingKey)).toBeNull();
    },
  );

  it.each(["storage", "same-tab", "storage-before-scope-edit", "same-tab-independent"])(
    "advances only the locally composed successor base across an older ack (%s)",
    async (replacement) => {
      const backend = server({ a: { [pinsKey]: ["route:usage"] } });
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
      const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a";
      let pendingAtFirstAck: unknown;
      let acknowledgments = 0;
      const hooks = {
        profileId: "a",
        canWrite: true,
        afterCommit: () => {
          if (++acknowledgments === 1) {
            pendingAtFirstAck = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
          }
        },
      };
      const first = {
        sidebarEntries: ["route:usage", "route:cron"],
        sidebarEntriesBase: ["route:usage"],
      };
      pushServerUiPrefs(a.writer, first, hooks);
      await committed.promise;
      const newer = {
        sidebarEntries: ["route:usage", "route:plugins"],
        sidebarEntriesBase:
          replacement !== "same-tab" ? first.sidebarEntriesBase : first.sidebarEntries,
      };
      if (replacement === "storage" || replacement === "storage-before-scope-edit") {
        localStorage.setItem(pendingKey, JSON.stringify(newer));
        if (replacement === "storage-before-scope-edit") {
          pushServerUiPrefs(a.writer, { navigationScope: "all" }, hooks);
        }
      } else {
        pushServerUiPrefs(a.writer, newer, hooks);
      }
      firstAck.resolve({ status: "ok" });
      await vi.dynamicImportSettled();
      expect(pendingAtFirstAck).toEqual(
        replacement === "storage-before-scope-edit" ? { ...newer, navigationScope: "all" } : newer,
      );
      expect(backend.profiles.a?.[pinsKey]).toEqual(
        replacement !== "same-tab"
          ? ["route:usage", "route:plugins", "route:cron"]
          : newer.sidebarEntries,
      );
      expect(writes).toBe(2);
    },
  );

  it("publishes default navigation when replacing a customized profile", async () => {
    const backend = server({
      a: { [pinsKey]: ["route:usage"], [scopeKey]: "all" },
      b: { [pinsKey]: [...DEFAULT_SIDEBAR_ENTRIES], [scopeKey]: "mine" },
    });
    let published = loadSettings();
    const onApplied = vi.fn(() => {
      published = loadSettings();
    });
    for (const profileId of ["a", "b"]) {
      const current = backend.connect(profileId);
      await refreshProfileAppearancePrefs({
        client: current.writer.state.client!,
        profileId,
        configObject: config,
        scope,
        onApplied,
      });
      expect(published).toMatchObject(
        profileId === "a"
          ? { sidebarEntries: ["route:usage"], navigationScope: "all" }
          : { sidebarEntries: [...DEFAULT_SIDEBAR_ENTRIES], navigationScope: "mine" },
      );
    }
    expect(onApplied).toHaveBeenCalledTimes(2);
  });

  it("honors another tab cancelling a pin edit during its CAS read", async () => {
    const backend = server({ a: { [pinsKey]: ["route:usage"] } });
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
    pushServerUiPrefs(
      a.writer,
      {
        sidebarEntries: ["route:usage", "route:cron"],
        sidebarEntriesBase: ["route:usage"],
      },
      { profileId: "a", canWrite: true, afterCommit },
    );
    await started.promise;
    localStorage.removeItem("openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a");
    response.resolve({ status: "ok", entries: { [pinsKey]: ["route:usage"] } });
    await vi.dynamicImportSettled();
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([]);
    expect(backend.profiles.a?.[pinsKey]).toEqual(["route:usage"]);
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "imports every authorized legacy pin page without changing the existing order (standalone=%s)",
    async (standalone) => {
      const backend = server();
      const a = backend.connect("a");
      const original = a.request.getMockImplementation()!;
      a.request.mockImplementation(async (method, params) => {
        if (method === "sessions.list") {
          const { offset } = params as { offset: number };
          return offset === 0
            ? pinnedPage(["agent:main:a", "agent:main:b"], 0, 3)
            : pinnedPage(["agent:other:c"], 2, 3);
        }
        return original(method, params);
      });
      const ordered = ["route:usage", "session:agent:main:b"];
      const options = {
        configObject: standalone ? {} : { ui: { prefs: { sidebarEntries: ordered } } },
        canMigrate: true,
        isCurrent: () => true,
      };
      await readProfileAppearancePrefs(a.writer.state.client!, "a", options);
      const expected = standalone
        ? [
            ...DEFAULT_SIDEBAR_ENTRIES,
            "session:agent:main:a",
            "session:agent:main:b",
            "session:agent:other:c",
          ]
        : [...ordered, "session:agent:main:a", "session:agent:other:c"];
      expect(backend.profiles.a?.[pinsKey]).toEqual(expected);
      const pages = a.request.mock.calls.filter(([method]) => method === "sessions.list");
      expect(pages.map(([, params]) => params)).toEqual(
        [0, 2].map((offset) => ({
          source: "sidebar",
          rowMode: "compact",
          pinned: true,
          archived: "all",
          includeGlobal: true,
          includeUnknown: true,
          limit: 200,
          offset,
        })),
      );
      await writeProfileAppearancePrefs(
        a.writer.state.client,
        { sidebarEntries: [], sidebarEntriesBase: expected },
        true,
        "a",
      );
      await readProfileAppearancePrefs(a.writer.state.client!, "a", options);
      expect(backend.profiles.a?.[pinsKey]).toEqual([]);
      expect(a.request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
    },
  );

  it.each([
    "missing-coverage",
    "page-error",
    "truncated-final",
    "nonadvancing",
    "changed-total",
    "duplicate",
  ])("does not seed navigation from %s legacy inventory", async (failure) => {
    const a = server().connect("a");
    const original = a.request.getMockImplementation()!;
    a.request.mockImplementation(async (method, params) => {
      if (method === "sessions.list") {
        const { offset } = params as { offset: number };
        if (failure === "missing-coverage") {
          return { count: 0, sessions: [] };
        }
        if (offset === 0) {
          return {
            ...pinnedPage(["agent:main:a"], 0, 2),
            ...(failure === "nonadvancing" ? { nextOffset: 0 } : {}),
          };
        }
        if (failure === "page-error") {
          throw new Error("inventory read failed");
        }
        if (failure === "truncated-final") {
          return { ...pinnedPage([], 1, 2), hasMore: false, nextOffset: null };
        }
        return pinnedPage(
          [failure === "duplicate" ? "agent:main:a" : "agent:main:b"],
          1,
          failure === "changed-total" ? 3 : 2,
        );
      }
      return original(method, params);
    });
    const reportError = vi.fn();
    await expect(
      readProfileAppearancePrefs(a.writer.state.client!, "a", {
        configObject: config,
        canMigrate: true,
        isCurrent: () => true,
        onSidebarEntriesUnavailable: reportError,
      }),
    ).resolves.toEqual({});
    expect(reportError).toHaveBeenCalledOnce();
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
  });

  it.each(["identity", "permission"])(
    "rechecks %s after awaited pin inventory before migration save",
    async (revoked) => {
      const a = server().connect("a");
      const original = a.request.getMockImplementation()!;
      const inventory = createDeferred<unknown>();
      const requested = createDeferred();
      a.request.mockImplementation(async (method, params) => {
        if (method === "sessions.list") {
          requested.resolve();
          return inventory.promise;
        }
        return original(method, params);
      });
      let current = true;
      let writable = true;
      const pending = readProfileAppearancePrefs(a.writer.state.client!, "a", {
        configObject: config,
        canMigrate: () => writable,
        isCurrent: () => current,
      });
      await requested.promise;
      if (revoked === "identity") {
        current = false;
      } else {
        writable = false;
      }
      inventory.resolve(pinnedPage(["agent:main:a"]));
      expect(await pending).toEqual(revoked === "identity" ? null : {});
      expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
        0,
      );
    },
  );

  it("does not inventory or migrate for a read-only profile", async () => {
    const a = server().connect("a");
    await readProfileAppearancePrefs(a.writer.state.client!, "a", {
      configObject: config,
      canMigrate: () => false,
      isCurrent: () => true,
    });
    expect(a.request.mock.calls.map(([method]) => method)).toEqual(["users.prefs.get"]);
  });

  it("refuses an oversized complete legacy inventory rather than truncating favorites", async () => {
    const a = server().connect("a");
    const original = a.request.getMockImplementation()!;
    a.request.mockImplementation(async (method, params) =>
      method === "sessions.list"
        ? pinnedPage(
            Array.from({ length: 50 }, (_, index) => "agent:main:" + index + "x".repeat(100)),
          )
        : original(method, params),
    );
    const reportError = vi.fn();
    await expect(
      readProfileAppearancePrefs(a.writer.state.client!, "a", {
        configObject: config,
        canMigrate: true,
        isCurrent: () => true,
        onSidebarEntriesUnavailable: reportError,
      }),
    ).resolves.toEqual({});
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("size limit") }),
    );
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
  });

  it("imports legacy shared pins even when the config has no session reference", async () => {
    let entries: Record<string, unknown> = {};
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries: structuredClone(entries) };
      }
      if (method === "sessions.list") {
        return {
          count: 1,
          totalCount: 1,
          hasMore: false,
          nextOffset: null,
          sessions: [{ key: "agent:main:favorite", pinned: true }],
        };
      }
      const update = params as { entries: Record<string, unknown> };
      entries = update.entries;
      return { status: "ok" };
    });
    const writer = createServerPrefsWriter(request, scope);
    await readProfileAppearancePrefs(writer.state.client!, "a", {
      configObject: config,
      canMigrate: true,
      isCurrent: () => true,
    });
    expect(entries[pinsKey]).toEqual([
      ...config.ui.prefs.sidebarEntries,
      "session:agent:main:favorite",
    ]);
  });

  it.each([
    {
      name: "remote removal",
      base: ["route:usage"],
      desired: ["route:usage", "route:plugins"],
      remote: ["route:cron"],
      expected: ["route:cron", "route:plugins"],
    },
    {
      name: "remote reorder",
      base: ["route:usage", "route:cron"],
      desired: ["route:usage", "route:cron", "route:plugins"],
      remote: ["route:cron", "route:usage"],
      expected: ["route:cron", "route:plugins", "route:usage"],
    },
    {
      name: "local reorder retaining remote-only slots",
      base: ["route:usage", "route:cron"],
      desired: ["route:cron", "route:usage"],
      remote: ["route:usage", "route:plugins", "route:cron"],
      expected: ["route:cron", "route:plugins", "route:usage"],
    },
    {
      name: "clear only observed pins",
      base: ["route:usage"],
      desired: [],
      remote: ["route:usage", "route:cron"],
      expected: ["route:cron"],
    },
  ])(
    "rebases $name without replacing unrelated remote intent",
    async ({ base, desired, remote, expected }) => {
      const backend = server({ a: { [pinsKey]: remote } });
      const a = backend.connect("a");
      expect(
        await writeProfileAppearancePrefs(
          a.writer.state.client,
          { sidebarEntries: desired, sidebarEntriesBase: base },
          true,
          "a",
        ),
      ).toMatchObject({ ok: true });
      expect(backend.profiles.a?.[pinsKey]).toEqual(expected);
    },
  );

  it("rebases a first edit against the displayed defaults when the profile key is absent", async () => {
    const backend = server();
    const a = backend.connect("a");
    const desired = DEFAULT_SIDEBAR_ENTRIES.filter((entry) => entry !== "route:cron");
    expect(
      await writeProfileAppearancePrefs(
        a.writer.state.client,
        { sidebarEntries: desired, sidebarEntriesBase: DEFAULT_SIDEBAR_ENTRIES },
        true,
        "a",
      ),
    ).toMatchObject({ ok: true });
    expect(backend.profiles.a?.[pinsKey]).toEqual(desired);
  });

  it("strips browser-only edit metadata when a profileless mixed change retains only appearance", async () => {
    const request = vi.fn(async () => ({}));
    const writer = createServerPrefsWriter(request, scope);
    const committed = createDeferred();
    pushServerUiPrefs(
      writer,
      { themeMode: "dark", sidebarEntries: [], sidebarEntriesBase: ["route:usage"] },
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
    const a = server({ a: { [pinsKey]: ["route:usage", "route:cron"] } }).connect("a");
    expect(
      await writeProfileAppearancePrefs(
        a.writer.state.client,
        { sidebarEntries: ["route:usage"] },
        true,
        "a",
      ),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(a.request).toHaveBeenCalledExactlyOnceWith("users.prefs.get", expect.anything());
  });

  it("re-drains repeated CAS conflicts using the original intent rather than overwriting remote edits", async () => {
    vi.useFakeTimers();
    const backend = server({ a: { [pinsKey]: ["route:usage"] } });
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
            [pinsKey]:
              attempts === 1 ? ["route:usage", "route:cron"] : ["route:cron", "route:systems"],
          };
          started.resolve();
          return { status: "conflict" };
        }
      }
      return original(method, params);
    });
    pushServerUiPrefs(
      a.writer,
      { sidebarEntries: ["route:usage", "route:plugins"], sidebarEntriesBase: ["route:usage"] },
      { profileId: "a", canWrite: true, afterCommit: committed },
    );
    await started.promise;
    await vi.runAllTimersAsync();
    expect(committed).toHaveBeenCalledOnce();
    expect(attempts).toBe(3);
    expect(backend.profiles.a?.[pinsKey]).toEqual(["route:cron", "route:systems", "route:plugins"]);
    expect(loadSettings().sidebarEntries).toEqual(backend.profiles.a?.[pinsKey]);
    expect(
      localStorage.getItem("openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a"),
    ).toBeNull();
  });

  it.each(["carry", "readd", "readd-identical"])(
    "settles composed intent without losing remote removals or explicit readds (%s)",
    async (mode) => {
      const backend = server({ a: { [pinsKey]: ["route:usage"] } });
      const a = backend.connect("a");
      await a.refresh();
      const original = a.request.getMockImplementation()!;
      const firstAck = createDeferred<unknown>();
      const started = createDeferred();
      const settled = createDeferred();
      let writes = 0;
      let commits = 0;
      a.request.mockImplementation(async (method, params) => {
        if (method === "users.prefs.set" && ++writes === 1) {
          const result = await original(method, params);
          expect(result).toEqual({ status: "ok" });
          started.resolve();
          return firstAck.promise;
        }
        return original(method, params);
      });
      const hooks = {
        profileId: "a",
        canWrite: true,
        afterCommit: () => {
          if (++commits === 2) {
            settled.resolve();
          }
        },
      };
      const before = loadSettings();
      const first = patchSettings({ sidebarEntries: ["route:usage", "route:plugins"] });
      pushServerUiPrefs(a.writer, changedServerUiPrefs(before, first)!, hooks);
      await started.promise;
      const second = patchSettings({
        sidebarEntries:
          mode === "readd-identical" ? first.sidebarEntries : ["route:plugins", "route:systems"],
      });
      if (mode !== "carry") {
        const removed = patchSettings({
          sidebarEntries: second.sidebarEntries.filter((entry) => entry !== "route:plugins"),
        });
        pushServerUiPrefs(a.writer, changedServerUiPrefs(first, removed)!, hooks);
        patchSettings({ sidebarEntries: second.sidebarEntries });
        pushServerUiPrefs(a.writer, changedServerUiPrefs(removed, second)!, hooks);
      } else {
        pushServerUiPrefs(a.writer, changedServerUiPrefs(first, second)!, hooks);
      }
      backend.profiles.a = { [pinsKey]: ["route:cron"] };
      firstAck.resolve({ status: "ok" });
      await settled.promise;
      expect(backend.profiles.a?.[pinsKey]).toEqual(
        mode === "carry"
          ? ["route:cron", "route:systems"]
          : mode === "readd"
            ? ["route:cron", "route:plugins", "route:systems"]
            : ["route:cron", "route:plugins"],
      );
    },
  );

  it("persists the observed base through offline reload before rebasing", async () => {
    const backend = server({ a: { [pinsKey]: ["route:usage"] } });
    const a = backend.connect("a");
    await a.refresh();
    Object.assign(a.writer.state, { connected: false });
    const previous = loadSettings();
    const next = patchSettings({ sidebarEntries: ["route:usage", "route:plugins"] });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(previous, next)!, {
      profileId: "a",
      canWrite: true,
    });
    resetServerUiPrefsSync();
    backend.profiles.a = { [pinsKey]: ["route:usage", "route:cron"] };
    const fresh = backend.connect("a");
    const committed = createDeferred();
    flushServerUiPrefs(fresh.writer, {
      profileId: "a",
      canWrite: true,
      afterCommit: () => committed.resolve(),
    });
    await committed.promise;
    expect(backend.profiles.a?.[pinsKey]).toEqual(["route:usage", "route:plugins", "route:cron"]);
  });

  it("preserves a remote pin added after this device observed its edit base", async () => {
    const backend = server({ a: { [pinsKey]: ["route:usage"] } });
    const a = backend.connect("a");
    await a.refresh();
    backend.profiles.a = { [pinsKey]: ["route:usage", "route:cron"] };
    const previous = loadSettings();
    const next = patchSettings({ sidebarEntries: ["route:usage", "route:plugins"] });
    const committed = createDeferred();
    pushServerUiPrefs(a.writer, changedServerUiPrefs(previous, next)!, {
      profileId: "a",
      canWrite: true,
      afterCommit: () => committed.resolve(),
    });
    await committed.promise;
    expect(backend.profiles.a?.[pinsKey]).toEqual(["route:usage", "route:plugins", "route:cron"]);
  });

  it("ignores another profile's shared browser mirror even before its storage event", async () => {
    const a = server({ a: { [pinsKey]: ["route:usage"], [scopeKey]: "all" } }).connect("a");
    await a.refresh();
    const key = settingsKeyForGateway(scope);
    const stored = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(
      key,
      JSON.stringify({
        ...stored,
        sidebarEntries: ["session:private-b"],
        navigationScope: "mine",
        navWidth: 360,
      }),
    );
    expect(loadSettings()).toMatchObject({
      sidebarEntries: ["route:usage"],
      navigationScope: "all",
      navWidth: 360,
    });
    patchSettings({ sidebarEntries: ["route:cron"] });
    expect(loadSettings()).toMatchObject({
      sidebarEntries: ["route:cron"],
      navigationScope: "all",
    });
  });

  it("restores only the selected profile's pending pins while its read is unavailable", async () => {
    const a = server({ a: { [pinsKey]: ["route:usage"] } }).connect("a");
    await a.refresh();
    localStorage.setItem(
      "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:b",
      JSON.stringify({ sidebarEntries: ["route:cron"], navigationScope: "all" }),
    );
    applyServerUiPrefs(config, { scope, profileId: "b", onApplied: vi.fn() });
    expect(loadSettings()).toMatchObject({
      sidebarEntries: ["route:cron"],
      navigationScope: "all",
    });
    applyServerUiPrefs({ ...config }, { scope, profileId: "b", onApplied: vi.fn() });
    expect(loadSettings().sidebarEntries).toEqual(["route:cron"]);
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
    pushServerUiPrefs(writer, { sidebarEntries: ["route:cron"], sidebarEntriesBase: [] }, hooks);
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

  it("does not seed migration or an explicit write after an incomplete first read", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({
      status: "no_durable_identity",
    }));
    const writer = createServerPrefsWriter(request, scope);
    expect(
      await readProfileAppearancePrefs(writer.state.client!, "a", {
        configObject: config,
        canMigrate: true,
        isCurrent: () => true,
      }),
    ).toBeNull();
    expect(
      await writeProfileAppearancePrefs(writer.state.client, { sidebarEntries: [] }, true, "a"),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(request.mock.calls.every(([method]) => method === "users.prefs.get")).toBe(true);
  });

  it("isolates two profiles and synchronizes the same profile through fresh reads", async () => {
    const backend = server({
      a: { [pinsKey]: ["route:usage"], [scopeKey]: "all" },
      b: { [pinsKey]: [] },
    });
    const a = backend.connect("a");
    const b = backend.connect("b");
    const otherA = backend.connect("a");
    await a.refresh();
    expect(loadSettings()).toMatchObject({
      sidebarEntries: ["route:usage"],
      navigationScope: "all",
    });
    await b.refresh();
    expect(loadSettings()).toMatchObject({ sidebarEntries: [], navigationScope: "mine" });
    const result = await writeProfileAppearancePrefs(
      a.writer.state.client,
      {
        sidebarEntries: ["route:cron"],
        sidebarEntriesBase: ["route:usage"],
        navigationScope: "mine",
      },
      true,
      "a",
    );
    expect(result.ok).toBe(true);
    await otherA.refresh();
    expect(loadSettings()).toMatchObject({
      sidebarEntries: ["route:cron"],
      navigationScope: "mine",
    });
    expect(backend.profiles.b).toEqual({ [pinsKey]: [] });
  });

  it("imports legacy order only once and never overwrites an existing empty list", async () => {
    const backend = server({ b: { [pinsKey]: [] } });
    const a = backend.connect("a");
    const b = backend.connect("b");
    patchSettings({ sidebarEntries: ["session:some-other-person"] });
    await a.refresh();
    await a.refresh();
    await b.refresh();
    expect(backend.profiles.a?.[pinsKey]).toEqual(config.ui.prefs.sidebarEntries);
    expect(backend.profiles.b?.[pinsKey]).toEqual([]);
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([
      [
        "users.prefs.set",
        {
          entries: { [pinsKey]: config.ui.prefs.sidebarEntries },
          expectedEntries: { [pinsKey]: null },
        },
      ],
    ]);
    expect(b.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
  });

  it("adopts a concurrent profile winner instead of overwriting during migration", async () => {
    let entries: Record<string, unknown> = {};
    const request = vi.fn(async (method: string) => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries: structuredClone(entries) };
      }
      if (method === "sessions.list") {
        return pinnedPage();
      }
      entries = { [pinsKey]: ["route:cron"] };
      return { status: "conflict" };
    });
    const writer = createServerPrefsWriter(request, scope);
    const prefs = await readProfileAppearancePrefs(writer.state.client!, "a", {
      configObject: config,
      canMigrate: true,
      isCurrent: () => true,
    });
    expect(prefs?.sidebarEntries).toEqual(["route:cron"]);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  });

  it("never imports the singleton browser mirror for a profile without legacy config", async () => {
    patchSettings({ sidebarEntries: ["session:private-other-user"], navigationScope: "all" });
    const connection = server().connect("b");
    await refreshProfileAppearancePrefs({
      client: connection.writer.state.client!,
      profileId: "b",
      configObject: {},
      scope,
      canWrite: true,
      onApplied: vi.fn(),
    });
    expect(loadSettings()).toMatchObject({
      sidebarEntries: DEFAULT_SIDEBAR_ENTRIES,
      navigationScope: "mine",
    });
    expect(connection.request.mock.calls.map(([method]) => method)).toEqual([
      "users.prefs.get",
      "sessions.list",
      "users.prefs.set",
      "users.prefs.get",
    ]);
  });

  it("preserves its confirmed mirror when a profile read is incomplete without saving defaults", async () => {
    const backend = server({ a: { [pinsKey]: ["route:usage"], [scopeKey]: "all" } });
    const a = backend.connect("a");
    await a.refresh();
    a.request.mockResolvedValue({ status: "no_durable_identity" });
    invalidateUserPreferences(a.writer.state.client!);
    await a.refresh();
    applyServerUiPrefs({ ...config }, { scope, profileId: "a", onApplied: vi.fn() });
    expect(loadSettings()).toMatchObject({
      sidebarEntries: ["route:usage"],
      navigationScope: "all",
    });
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
  });

  it("fences a late profile read and migration after identity or connection replacement", async () => {
    const deferred = createDeferred<unknown>();
    const request = vi.fn(() => deferred.promise);
    const writer = createServerPrefsWriter(request, scope);
    let current = true;
    const pending = refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId: "a",
      configObject: config,
      scope,
      canWrite: true,
      isCurrent: () => current,
      onApplied: vi.fn(),
    });
    current = false;
    deferred.resolve({ status: "ok", entries: {} });
    expect(await pending).toBe(false);
    expect(request.mock.calls).toHaveLength(1);
  });

  it.each([false, true])(
    "never writes profileless navigation to global config (offline=%s)",
    async (offline) => {
      const request = vi.fn(async () => ({}));
      const writer = createServerPrefsWriter(request, scope, !offline);
      pushServerUiPrefs(writer, { sidebarEntries: [], navigationScope: "all" });
      Object.assign(writer.state, { connected: true });
      flushServerUiPrefs(writer);
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rechecks dispatch authority after its CAS read", async () => {
    const deferred = createDeferred<unknown>();
    const request = vi.fn(() => deferred.promise);
    const writer = createServerPrefsWriter(request, scope);
    let current = true;
    const pending = writeProfileAppearancePrefs(
      writer.state.client,
      { sidebarEntries: [] },
      () => current,
      "a",
    );
    current = false;
    deferred.resolve({ status: "ok", entries: {} });
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("serializes rapid reorders and retries CAS conflicts without losing newest intent", async () => {
    vi.useFakeTimers();
    const backend = server({ a: { [pinsKey]: ["route:usage", "route:cron"] } });
    const a = backend.connect("a");
    await a.refresh();
    const original = a.request.getMockImplementation()!;
    const firstWrite = createDeferred<unknown>();
    const started = createDeferred();
    let writes = 0;
    a.request.mockImplementation(async (method, params) => {
      if (method === "users.prefs.set" && ++writes === 1) {
        started.resolve();
        return firstWrite.promise;
      }
      return original(method, params);
    });
    const committed = createDeferred();
    const hooks = { profileId: "a", canWrite: true, afterCommit: () => committed.resolve() };
    pushServerUiPrefs(
      a.writer,
      {
        sidebarEntries: ["route:cron", "route:usage"],
        sidebarEntriesBase: ["route:usage", "route:cron"],
      },
      hooks,
    );
    await started.promise;
    pushServerUiPrefs(
      a.writer,
      { sidebarEntries: ["route:cron"], sidebarEntriesBase: ["route:cron", "route:usage"] },
      hooks,
    );
    firstWrite.resolve({ status: "conflict" });
    await vi.advanceTimersByTimeAsync(250);
    await committed.promise;
    expect(backend.profiles.a?.[pinsKey]).toEqual(["route:cron"]);
    expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(2);
  });
});

/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { ShellGatewayOwner } from "./app-shell-gateway.ts";
import type { ApplicationContext } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

type ShellServerPreferencesState = {
  runtime: { context: ApplicationContext };
  shellGateway: ShellGatewayOwner;
};

describe("OpenClaw shell locale preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
    patchSettings({ gatewayUrl: "ws://locale.test" });
  });

  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses canonical server locale provenance and clears a stale local pin", async () => {
    localStorage.setItem("openclaw.i18n.locale", "fr");
    const setLocale = vi.spyOn(i18n, "setLocale").mockResolvedValue();
    const useSystemLocale = vi.spyOn(i18n, "useSystemLocale").mockResolvedValue();
    const state: {
      configSnapshot: {
        config: { ui: { prefs: Record<string, unknown> } };
        hash: string;
      };
    } = {
      configSnapshot: {
        config: { ui: { prefs: { locale: "de" } } },
        hash: "locale-config-hash",
      },
    };
    const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
    const refreshTheme = vi.fn();
    const context = {
      gateway: {
        connection: { gatewayUrl: "ws://locale.test" },
        snapshot: { phase: "connected", client: {} },
      },
      theme: { refresh: refreshTheme },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);
    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);
    state.configSnapshot = {
      config: { ui: { prefs: {} } },
      hash: "locale-config-cleared-hash",
    };
    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);
    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);

    expect(setLocale).toHaveBeenCalledExactlyOnceWith("de");
    expect(useSystemLocale).toHaveBeenCalledOnce();
    expect(loadSettings().locale).toBeUndefined();
  });

  it("keeps a retained device-local locale instead of realigning to the rejected server value", async () => {
    const setLocale = vi.spyOn(i18n, "setLocale").mockResolvedValue();
    const useSystemLocale = vi.spyOn(i18n, "useSystemLocale").mockResolvedValue();
    const state = {
      configSnapshot: {
        config: { ui: { prefs: { locale: "de" } } },
        hash: "locale-config-hash",
      },
    };
    const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
    const refreshTheme = vi.fn();
    const context = {
      gateway: {
        connection: { gatewayUrl: "ws://locale.test" },
        snapshot: { phase: "connected", client: {} },
      },
      theme: { refresh: refreshTheme },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);
    refreshTheme.mockClear();
    patchSettings({ locale: "fr" });
    await shell.shellGateway.reconcileCommittedServerUiPrefs(runtimeConfig, false, true);

    expect(setLocale).toHaveBeenNthCalledWith(1, "de");
    expect(setLocale).toHaveBeenNthCalledWith(2, "fr");
    expect(useSystemLocale).not.toHaveBeenCalled();
    expect(loadSettings().locale).toBe("fr");
    expect(refreshTheme).toHaveBeenCalledOnce();
  });

  it("publishes authored theme changes when the local mirror needs no patch", async () => {
    patchSettings({ gatewayUrl: "ws://theme.test" });
    const state = {
      configSnapshot: {
        config: { ui: { prefs: { theme: "custom" } } },
        hash: "theme-custom",
      },
    };
    const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
    const recordServerSelection = vi.fn();
    const context = {
      gateway: {
        connection: { gatewayUrl: "ws://theme.test" },
        snapshot: { phase: "connected", client: {} },
      },
      theme: { recordServerSelection, refresh: vi.fn(), serverSelection: null },
      runtimeConfig,
    } as unknown as ApplicationContext;
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellServerPreferencesState;
    shell.runtime = { context };

    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);
    expect(recordServerSelection).toHaveBeenLastCalledWith("custom", "ws://theme.test");

    state.configSnapshot = {
      config: { ui: { prefs: { theme: "claw" } } },
      hash: "theme-claw",
    };
    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);
    expect(recordServerSelection).toHaveBeenLastCalledWith("claw", "ws://theme.test");
    expect(loadSettings().theme).toBe("claw");
  });
});

// This file already owns an isolated module graph. Each realm starts its request
// before loading the next realm, so the pending drain retains its own module state.
async function loadPreferenceRealm() {
  vi.resetModules();
  const prefs = await import("./server-prefs.ts");
  const settings = await import("./settings.ts");
  const reconcile = await import("./server-prefs-reconcile.ts");
  const intent = await import("./server-prefs-intent.ts");
  const fixtures = await import("./server-prefs.test-support.ts");
  return { prefs, settings, reconcile, intent, fixtures };
}

describe("profile preference ACK publication across browser realms", () => {
  beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const publicationCases = [
    "settled",
    "settled-empty",
    "published-read",
    "published-baseline",
    "published-identical",
    "cancelled",
  ];
  it.each(publicationCases)(
    "keeps B's newer publication when A's older ACK arrives (%s)",
    async (mode) => {
      const cancelled = mode === "cancelled";
      const empty = mode === "settled-empty" || cancelled;
      const baseline = mode === "published-baseline";
      const identical = mode === "published-identical";
      const observed = mode === "published-read" || baseline || identical;
      const scope = "ws://ack-publication";
      const profileId = "profile-a";
      const pinsKey = "ui.sidebarEntries";
      const pendingKey =
        "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:" + profileId;
      const lastSeenKey = "openclaw.control.serverPrefs.v1:" + scope + ":profile:" + profileId;
      const config = {};
      const server: Record<string, unknown> = { [pinsKey]: ["route:usage"] };
      const aCommitted = createDeferred();
      const aReply = createDeferred<unknown>();
      const requestFor = (holdReply: boolean) =>
        vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
          if (method === "users.prefs.get") {
            return { status: "ok", entries: structuredClone(server) };
          }
          if (method !== "users.prefs.set") {
            throw new Error("Unexpected request: " + method);
          }
          const mutation = params as {
            entries: Record<string, unknown>;
            expectedEntries: Record<string, unknown>;
          };
          for (const [key, value] of Object.entries(mutation.expectedEntries)) {
            if (JSON.stringify(server[key] ?? null) !== JSON.stringify(value)) {
              return { status: "conflict" };
            }
          }
          Object.assign(server, structuredClone(mutation.entries));
          if (holdReply) {
            aCommitted.resolve();
            return aReply.promise;
          }
          return { status: "ok" };
        });
      const a = await loadPreferenceRealm();
      const aRequest = requestFor(true);
      const aWriter = a.fixtures.createServerPrefsWriter(
        aRequest,
        scope,
        true,
        { ok: true },
        false,
      );
      let b: Awaited<ReturnType<typeof loadPreferenceRealm>> | undefined;
      try {
        a.settings.patchSettings({ gatewayUrl: scope });
        await a.reconcile.refreshProfileAppearancePrefs({
          client: aWriter.state.client!,
          profileId,
          scope,
          configObject: config,
          onApplied: vi.fn(),
        });
        const aAfterCommit = vi.fn(() =>
          a.reconcile.applyServerUiPrefs(config, { scope, profileId, onApplied: vi.fn() }),
        );
        const beforeA = a.settings.loadSettings();
        const wantedA = a.settings.patchSettings({
          sidebarEntries: ["route:usage", "route:cron"],
        });
        a.prefs.pushServerUiPrefs(aWriter, a.intent.changedServerUiPrefs(beforeA, wantedA)!, {
          profileId,
          canWrite: true,
          afterCommit: aAfterCommit,
        });
        await aCommitted.promise;
        b = await loadPreferenceRealm();
        const bRequest = requestFor(false);
        const bWriter = b.fixtures.createServerPrefsWriter(
          bRequest,
          scope,
          true,
          { ok: true },
          false,
        );
        const wantedB = {
          sidebarEntries: identical
            ? wantedA.sidebarEntries
            : empty
              ? []
              : baseline
                ? ["route:usage"]
                : ["route:plugins"],
        };
        if (observed && !identical) {
          // A different writer can publish a confirmed read without settling A's outbox.
          await bWriter.state.client!.request("users.prefs.set", {
            entries: { [pinsKey]: wantedB.sidebarEntries },
            expectedEntries: { [pinsKey]: server[pinsKey] },
          });
        }
        await b.reconcile.refreshProfileAppearancePrefs({
          client: bWriter.state.client!,
          profileId,
          scope,
          configObject: config,
          onApplied: vi.fn(),
        });
        if (identical) {
          const receipt = JSON.parse(localStorage.getItem(lastSeenKey)!).navigationConfirmation;
          b.reconcile.applyServerUiPrefs(
            { ui: { prefs: { locale: "de" } } },
            {
              scope,
              profileId,
              onApplied: vi.fn(),
            },
          );
          expect(JSON.parse(localStorage.getItem(lastSeenKey)!).navigationConfirmation).toEqual(
            receipt,
          );
        }
        if (!observed) {
          const beforeB = b.settings.loadSettings(scope);
          const nextB = b.settings.patchSettings(wantedB);
          b.prefs.pushServerUiPrefs(bWriter, b.intent.changedServerUiPrefs(beforeB, nextB)!, {
            profileId,
            canWrite: !cancelled,
          });
        }
        await vi.dynamicImportSettled();
        expect(server[pinsKey]).toEqual(
          cancelled ? wantedA.sidebarEntries : wantedB.sidebarEntries,
        );
        expect(localStorage.getItem(pendingKey) === null).toBe(!observed);
        if (observed && !identical) {
          const confirmed = JSON.parse(localStorage.getItem(lastSeenKey)!);
          a.reconcile.applyServerUiPrefs(
            { ui: { prefs: { locale: "de" } } },
            {
              scope,
              profileId,
              onApplied: vi.fn(),
            },
          );
          expect(JSON.parse(localStorage.getItem(lastSeenKey)!)).toMatchObject({
            sidebarEntries: confirmed.sidebarEntries,
            navigationConfirmation: confirmed.navigationConfirmation,
          });
        }
        const newestLastSeen = localStorage.getItem(lastSeenKey);
        expect(JSON.parse(newestLastSeen!)).toMatchObject({
          sidebarEntries: cancelled ? wantedA.sidebarEntries : wantedB.sidebarEntries,
        });
        const aReads = aRequest.mock.calls.filter(
          ([method]) => method === "users.prefs.get",
        ).length;
        aReply.resolve({ status: "ok" });
        await vi.dynamicImportSettled();
        expect(a.settings.loadSettings(scope)).toMatchObject({
          sidebarEntries: wantedB.sidebarEntries,
        });
        expect(b.settings.loadSettings(scope).sidebarEntries).toEqual(wantedB.sidebarEntries);
        if (identical) {
          expect(aAfterCommit).toHaveBeenCalledOnce();
        } else {
          if (!observed) {
            expect(localStorage.getItem(lastSeenKey)).toBe(newestLastSeen);
          }
          expect(aAfterCommit).not.toHaveBeenCalled();
        }
        // A later reconciliation must not consume a cache rolled backward by that stale receipt.
        a.reconcile.applyServerUiPrefs({}, { scope, profileId, onApplied: vi.fn() });
        expect(a.settings.loadSettings(scope).sidebarEntries).toEqual(wantedB.sidebarEntries);
        expect(JSON.parse(localStorage.getItem(lastSeenKey)!)).toMatchObject({
          sidebarEntries: cancelled ? wantedA.sidebarEntries : wantedB.sidebarEntries,
        });
        expect(aRequest.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(
          aReads + (observed && !identical ? 1 : 0),
        );
        expect(aRequest.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
          1,
        );
        expect(bRequest.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
          cancelled || identical ? 0 : 1,
        );
      } finally {
        aReply.resolve({ status: "ok" });
        a.prefs.resetServerUiPrefsSync();
        b?.prefs.resetServerUiPrefsSync();
        await vi.dynamicImportSettled();
      }
    },
  );
  it("accepts a successful write after an identical read published before the commit", async () => {
    const a = await loadPreferenceRealm();
    const scope = "ws://ack-before-commit";
    const profileId = "profile-a";
    const server = { "ui.sidebarEntries": ["route:usage"] };
    const dispatched = createDeferred();
    const commit = createDeferred();
    const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries: structuredClone(server) };
      }
      dispatched.resolve();
      await commit.promise;
      Object.assign(server, (params as { entries: Record<string, unknown> }).entries);
      return { status: "ok" };
    });
    const writer = a.fixtures.createServerPrefsWriter(request, scope, true, { ok: true }, false);
    let b: Awaited<ReturnType<typeof loadPreferenceRealm>> | undefined;
    try {
      a.settings.patchSettings({ gatewayUrl: scope });
      await a.reconcile.refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId,
        scope,
        configObject: {},
        onApplied: vi.fn(),
      });
      const before = a.settings.loadSettings(scope);
      const desired = a.settings.patchSettings({
        sidebarEntries: ["route:usage", "route:cron"],
      });
      const afterCommit = vi.fn();
      a.prefs.pushServerUiPrefs(writer, a.intent.changedServerUiPrefs(before, desired)!, {
        profileId,
        canWrite: true,
        afterCommit,
      });
      await dispatched.promise;
      b = await loadPreferenceRealm();
      const bRequest = vi.fn(async (): Promise<unknown> => ({
        status: "ok",
        entries: structuredClone(server),
      }));
      const bWriter = b.fixtures.createServerPrefsWriter(
        bRequest,
        scope,
        true,
        { ok: true },
        false,
      );
      await b.reconcile.refreshProfileAppearancePrefs({
        client: bWriter.state.client!,
        profileId,
        scope,
        configObject: {},
        onApplied: vi.fn(),
      });
      commit.resolve();
      await vi.dynamicImportSettled();
      expect(a.settings.loadSettings(scope)).toMatchObject({
        sidebarEntries: desired.sidebarEntries,
      });
      expect(server).toMatchObject({
        "ui.sidebarEntries": desired.sidebarEntries,
      });
      expect(afterCommit).toHaveBeenCalledOnce();
    } finally {
      commit.resolve();
      a.prefs.resetServerUiPrefsSync();
      b?.prefs.resetServerUiPrefsSync();
      await vi.dynamicImportSettled();
    }
  });

  it.each(["unavailable", "quota"])(
    "fences an ABA confirmation with %s storage",
    async (failure) => {
      const realm = await loadPreferenceRealm();
      const scope = "ws://ack-storage-blocked";
      const profileId = "profile-a";
      const entries: Record<string, unknown> = {
        "ui.sidebarEntries": ["route:usage"],
      };
      const committed = createDeferred();
      const reply = createDeferred<unknown>();
      const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
        if (method === "users.prefs.get") {
          return { status: "ok", entries: structuredClone(entries) };
        }
        const update = params as { entries: Record<string, unknown> };
        Object.assign(entries, update.entries);
        committed.resolve();
        return reply.promise;
      });
      const writer = realm.fixtures.createServerPrefsWriter(
        request,
        scope,
        true,
        { ok: true },
        false,
      );
      const refresh = () =>
        realm.reconcile.refreshProfileAppearancePrefs({
          client: writer.state.client!,
          profileId,
          scope,
          configObject: {},
          onApplied: vi.fn(),
        });
      realm.settings.patchSettings({ gatewayUrl: scope });
      const storage = globalThis.localStorage;
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => {
          if (failure === "quota") {
            return storage.getItem(key);
          }
          throw new Error("storage blocked");
        },
        setItem: () => {
          throw new Error("storage blocked");
        },
        removeItem: () => {
          throw new Error("storage blocked");
        },
      });
      try {
        await refresh();
        const before = realm.settings.loadSettings(scope);
        const desired = realm.settings.patchSettings({
          sidebarEntries: ["route:usage", "route:cron"],
        });
        const afterCommit = vi.fn();
        realm.prefs.pushServerUiPrefs(writer, realm.intent.changedServerUiPrefs(before, desired)!, {
          profileId,
          canWrite: true,
          afterCommit,
        });
        await committed.promise;
        entries["ui.sidebarEntries"] = ["route:usage"];
        await refresh();
        const confirmed = realm.prefs.serverUiPrefsOutbox.confirmedPrefsFallback?.prefs;
        reply.resolve({ status: "ok" });
        await vi.dynamicImportSettled();
        expect(realm.settings.loadSettings(scope)).toMatchObject({
          sidebarEntries: ["route:usage"],
        });
        expect(realm.prefs.serverUiPrefsOutbox.confirmedPrefsFallback?.prefs).toMatchObject({
          sidebarEntries: confirmed?.sidebarEntries,
        });
        expect(afterCommit).not.toHaveBeenCalled();
        expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
          1,
        );
      } finally {
        reply.resolve({ status: "ok" });
        realm.prefs.resetServerUiPrefsSync();
        await vi.dynamicImportSettled();
      }
    },
  );
});

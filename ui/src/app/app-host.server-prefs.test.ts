/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import type { ShellGatewayOwner } from "./app-shell-gateway.ts";
import type { ApplicationContext } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

function createPreferenceShell(
  prefs: Record<string, string>,
  theme: Pick<ApplicationContext["theme"], "refresh"> &
    Partial<Pick<ApplicationContext["theme"], "recordServerSelection">>,
  scope = "ws://locale.test",
) {
  const state = { configSnapshot: { config: { ui: { prefs } }, hash: scope } };
  const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
  const context = {
    gateway: { connection: { gatewayUrl: scope }, snapshot: { phase: "connected", client: {} } },
    theme,
    runtimeConfig,
  } as unknown as ApplicationContext;
  const shell = createShellOwner() as unknown as ShellServerPreferencesState;
  shell.runtime = { context };
  return { shell, state, runtimeConfig };
}

type ShellServerPreferencesState = {
  runtime: { context: ApplicationContext };
  shellGateway: ShellGatewayOwner;
};

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
afterEach(() => {
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenClaw shell locale preferences", () => {
  beforeEach(() => {
    resetServerUiPrefsSync();
    patchSettings({ gatewayUrl: "ws://locale.test" });
  });

  it("keeps a retained device-local locale instead of realigning to the rejected server value", async () => {
    const setLocale = vi.spyOn(i18n, "setLocale").mockResolvedValue();
    const useSystemLocale = vi.spyOn(i18n, "useSystemLocale").mockResolvedValue();
    const refresh = vi.fn();
    const { shell, runtimeConfig } = createPreferenceShell({ locale: "de" }, { refresh });

    await shell.shellGateway.reconcileServerUiPrefs(runtimeConfig);
    refresh.mockClear();
    patchSettings({ locale: "fr" });
    await shell.shellGateway.reconcileCommittedServerUiPrefs(runtimeConfig, false, true);

    expect(setLocale).toHaveBeenNthCalledWith(1, "de");
    expect(setLocale).toHaveBeenNthCalledWith(2, "fr");
    expect(useSystemLocale).not.toHaveBeenCalled();
    expect(loadSettings().locale).toBe("fr");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("publishes authored theme changes when the local mirror needs no patch", async () => {
    patchSettings({ gatewayUrl: "ws://theme.test" });
    const recordServerSelection = vi.fn();
    const { shell, state, runtimeConfig } = createPreferenceShell(
      { theme: "custom" },
      { recordServerSelection, refresh: vi.fn() },
      "ws://theme.test",
    );

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

// Reset only between realms: each pending drain keeps its original module state.
async function loadPreferenceRealm(scope: string) {
  vi.resetModules();
  const prefs = await import("./server-prefs.ts");
  const settings = await import("./settings.ts");
  const reconcile = await import("./server-prefs-reconcile.ts");
  const intent = await import("./server-prefs-intent.ts");
  const fixtures = await import("./server-prefs.test-support.ts");
  return {
    prefs,
    settings,
    server: fixtures.createProfilePrefsServer,
    read: () => settings.loadSettings(scope).sidebarEntries,
    apply: (config = {}) =>
      reconcile.applyServerUiPrefs(config, { scope, profileId: "profile-a", onApplied: vi.fn() }),
    publish: (
      writer: ReturnType<typeof fixtures.createServerPrefsWriter>,
      sidebarEntries: string[],
      canWrite = true,
      afterCommit?: () => void,
    ) => {
      const before = settings.loadSettings(scope);
      const next = settings.patchSettings({ sidebarEntries });
      prefs.pushServerUiPrefs(writer, intent.changedServerUiPrefs(before, next)!, {
        profileId: "profile-a",
        canWrite,
        afterCommit,
      });
      return next.sidebarEntries;
    },
    writer: (request: Parameters<typeof fixtures.createServerPrefsWriter>[0]) =>
      fixtures.createServerPrefsWriter(request, scope, true, { ok: true }, false),
    refresh: (writer: ReturnType<typeof fixtures.createServerPrefsWriter>, configObject = {}) =>
      reconcile.refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId: "profile-a",
        scope,
        configObject,
        onApplied: vi.fn(),
      }),
  };
}

describe("profile preference ACK publication across browser realms", () => {
  const publicationCases = ["settled", "published-read", "published-identical", "cancelled"];
  it.each(publicationCases)(
    "keeps B's newer publication when A's older ACK arrives (%s)",
    async (mode) => {
      const cancelled = mode === "cancelled";
      const identical = mode === "published-identical";
      const observed = mode === "published-read" || identical;
      const scope = "ws://ack-publication";
      const pinsKey = "ui.railShortcuts";
      const pendingKey = `openclaw.control.serverPrefs.pending.v1:${scope}:profile:profile-a`;
      const lastSeenKey = `openclaw.control.serverPrefs.v1:${scope}:profile:profile-a`;
      const lastSeenPins = () => JSON.parse(localStorage.getItem(lastSeenKey)!).railShortcuts;
      const a = await loadPreferenceRealm(scope);
      const serverFixture = a.server({ "profile-a": { [pinsKey]: ["route:usage"] } }, scope);
      const server = serverFixture.profiles["profile-a"]!;
      const aCommitted = createDeferred();
      const aReply = createDeferred<unknown>();
      const requestFor = (holdReply: boolean) => {
        const { request } = serverFixture.connect("profile-a");
        return vi.fn(async (method: string, params?: unknown) => {
          const result = await request(method, params);
          if (holdReply && method === "users.prefs.set") {
            aCommitted.resolve();
            await aReply.promise;
          }
          return result;
        });
      };
      const aRequest = requestFor(true);
      const aWriter = a.writer(aRequest);
      let b: Awaited<ReturnType<typeof loadPreferenceRealm>> | undefined;
      try {
        a.settings.patchSettings({ gatewayUrl: scope });
        await a.refresh(aWriter);
        const aAfterCommit = vi.fn(() => a.apply());
        const wantedA = a.publish(aWriter, ["route:usage", "route:cron"], true, aAfterCommit);
        await aCommitted.promise;
        b = await loadPreferenceRealm(scope);
        const bRequest = requestFor(false);
        const bWriter = b.writer(bRequest);
        const wantedB = identical ? wantedA : cancelled ? [] : ["route:plugins"];
        if (observed && !identical) {
          // A different writer can publish a confirmed read without settling A's outbox.
          await bWriter.state.client!.request("users.prefs.set", {
            entries: { [pinsKey]: wantedB },
            expectedEntries: { [pinsKey]: server[pinsKey] },
          });
        }
        await b.refresh(bWriter);
        if (identical) {
          b.apply({ ui: { prefs: { locale: "de" } } });
        }
        if (!observed) {
          b.publish(bWriter, wantedB, !cancelled);
        }
        await vi.dynamicImportSettled();
        const expectedServer = cancelled ? wantedA : wantedB;
        expect(server[pinsKey]).toEqual(expectedServer);
        expect(localStorage.getItem(pendingKey) === null).toBe(!observed);
        if (observed && !identical) {
          const confirmed = lastSeenPins();
          a.apply({ ui: { prefs: { locale: "de" } } });
          expect(lastSeenPins()).toEqual(confirmed);
        }
        const newestLastSeen = localStorage.getItem(lastSeenKey);
        expect(lastSeenPins()).toEqual(expectedServer);
        aReply.resolve({ status: "ok" });
        await vi.dynamicImportSettled();
        expect([a.read(), b.read()]).toEqual([wantedB, wantedB]);
        if (identical) {
          expect(aAfterCommit).toHaveBeenCalledOnce();
        } else {
          if (!observed) {
            expect(localStorage.getItem(lastSeenKey)).toBe(newestLastSeen);
          }
          expect(aAfterCommit).not.toHaveBeenCalled();
        }
        // A later reconciliation must not consume a cache rolled backward by that stale receipt.
        a.apply();
        expect(a.read()).toEqual(wantedB);
        expect(lastSeenPins()).toEqual(expectedServer);
        expect(
          [aRequest, bRequest].map(
            (request) =>
              request.mock.calls.filter(([method]) => method === "users.prefs.set").length,
          ),
        ).toEqual([1, cancelled || identical ? 0 : 1]);
      } finally {
        aReply.resolve({ status: "ok" });
        a.prefs.resetServerUiPrefsSync();
        b?.prefs.resetServerUiPrefsSync();
        await vi.dynamicImportSettled();
      }
    },
  );
  it("accepts a successful write after an identical read published before the commit", async () => {
    const scope = "ws://ack-before-commit";
    const a = await loadPreferenceRealm(scope);
    const server = { "ui.railShortcuts": ["route:usage"] };
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
    const writer = a.writer(request);
    let b: Awaited<ReturnType<typeof loadPreferenceRealm>> | undefined;
    try {
      a.settings.patchSettings({ gatewayUrl: scope });
      await a.refresh(writer);
      const afterCommit = vi.fn();
      const desired = a.publish(writer, ["route:usage", "route:cron"], true, afterCommit);
      await dispatched.promise;
      b = await loadPreferenceRealm(scope);
      const bRequest = vi.fn(async (): Promise<unknown> => ({
        status: "ok",
        entries: structuredClone(server),
      }));
      const bWriter = b.writer(bRequest);
      await b.refresh(bWriter);
      commit.resolve();
      await vi.dynamicImportSettled();
      expect([a.read(), server["ui.railShortcuts"]]).toEqual([desired, desired]);
      expect(afterCommit).toHaveBeenCalledOnce();
    } finally {
      commit.resolve();
      a.prefs.resetServerUiPrefsSync();
      b?.prefs.resetServerUiPrefsSync();
      await vi.dynamicImportSettled();
    }
  });
});

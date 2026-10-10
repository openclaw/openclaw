/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resetServerUiPref, selectThemeSettings } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { extractServerUiPrefs } from "./server-prefs-state.ts";
import { configWithPrefs, createServerPrefsWriter } from "./server-prefs.test-support.ts";
import {
  flushServerUiPrefs,
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";

const scope = "ws://tab-icon-prefs";
const profileId = "profile-icon";
const tabIcon = "agent:circle";
const pendingKey = `openclaw.control.serverPrefs.pending.v1:${scope}:profile:${profileId}`;

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.unstubAllGlobals();
});

describe("tab icon preference ownership", () => {
  it.each(["default", "agent", "agent:rounded", "agent:circle", "lobster:crimson"] as const)(
    "preserves %s on theme selection and removes the preference on reset",
    (choice) => {
      patchSettings({ tabIcon: choice });
      selectThemeSettings("dash");
      expect(loadSettings().tabIcon).toEqual(choice);
      const previous = loadSettings();
      const next = resetServerUiPref("tabIcon");
      expect(next.tabIcon).toBeUndefined();
      expect(changedServerUiPrefs(previous, next)).toMatchObject({ tabIcon: null });
      expect(JSON.parse(localStorage.getItem(settingsKeyForGateway(scope))!)).not.toHaveProperty(
        "tabIcon",
      );
    },
  );

  it("rejects malformed browser mirrors and never reads the icon from gateway config", () => {
    const key = settingsKeyForGateway(scope);
    localStorage.setItem(
      key,
      JSON.stringify({
        gatewayUrl: scope,
        tabIcon: { mode: "agent" },
      }),
    );
    expect(loadSettings().tabIcon).toBeUndefined();
    expect(extractServerUiPrefs(configWithPrefs({ tabIcon, theme: "claw" }))).toEqual({
      theme: "claw",
    });
  });

  it.each([null, profileId])("keeps an unwritable icon browser-local (profile=%s)", (id) => {
    const request = vi.fn(async () => ({ status: "ok" }));
    const writer = createServerPrefsWriter(request, scope);
    const afterCommit = vi.fn();
    patchSettings({ tabIcon });
    pushServerUiPrefs(writer, { tabIcon }, { profileId: id, canWrite: false, afterCommit });
    expect(request).not.toHaveBeenCalled();
    expect(afterCommit).toHaveBeenCalledExactlyOnceWith({
      needsRefresh: false,
      retainedLocal: true,
    });
    expect(loadSettings().tabIcon).toEqual(tabIcon);
  });

  it.each([false, true])(
    "writes a mixed theme batch without falsely acknowledging its icon (reject=%s)",
    async (rejected) => {
      const iconStarted = createDeferred();
      const iconReply = createDeferred<{ status: "ok" | "no_durable_identity" }>();
      const completed = createDeferred();
      const request = vi.fn(async (method: string) => {
        if (method === "users.prefs.get") {
          return { status: "ok", entries: {} };
        }
        if (method === "users.prefs.set") {
          iconStarted.resolve();
          return iconReply.promise;
        }
        return { application: "saved" };
      });
      const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
      const config = configWithPrefs({});
      await refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      });
      request.mockClear();
      patchSettings({
        theme: "dash",
        fontUi: undefined,
        fontChat: undefined,
        accent: "theme",
        tabIcon,
      });
      let commits = 0;
      const afterCommit = vi.fn(() => {
        if (++commits === 2) {
          completed.resolve();
        }
      });
      pushServerUiPrefs(
        writer,
        {
          theme: "dash",
          accent: "theme",
          fontUi: null,
          fontChat: null,
          tabIcon,
        },
        { profileId, canWrite: true, afterCommit },
      );
      await iconStarted.promise;
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "themes.set",
        "users.prefs.set",
      ]);
      expect(request).toHaveBeenNthCalledWith(1, "themes.set", {
        id: "dash",
        appearance: { accent: "theme", fontUi: null, fontChat: null },
      });
      expect(request).toHaveBeenNthCalledWith(2, "users.prefs.set", {
        entries: { "ui.tabIcon": tabIcon },
      });
      expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ tabIcon });
      expect(
        resolveServerUiPrefState(config, "tabIcon", scope, loadSettings(), { profileId })
          .provenance,
      ).toBe("pending");
      iconReply.resolve({ status: rejected ? "no_durable_identity" : "ok" });
      await completed.promise;
      expect(localStorage.getItem(pendingKey)).toBeNull();
      expect(afterCommit).toHaveBeenLastCalledWith(
        rejected ? { needsRefresh: false, retainedLocal: true } : { needsRefresh: false },
      );
      expect(
        resolveServerUiPrefState(config, "tabIcon", scope, loadSettings(), { profileId })
          .provenance,
      ).toBe(rejected ? "device-local" : "profile");
    },
  );

  it("keeps the icon independent of rejected theme writes and sends a whole-value reset", async () => {
    const completed = createDeferred();
    const request = vi.fn(async (method: string) => {
      if (method === "themes.set") {
        throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Theme unavailable" });
      }
      return { status: "ok" };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    let commits = 0;
    pushServerUiPrefs(
      writer,
      { theme: "dash", tabIcon: null },
      {
        profileId,
        canWrite: true,
        afterCommit: () => {
          if (++commits === 2) {
            completed.resolve();
          }
        },
      },
    );
    await completed.promise;
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: { "ui.tabIcon": null },
    });
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });

  it("rejects unsupported queued icons before any profile write", async () => {
    const request = vi.fn(async () => ({ status: "ok" }));
    const writer = createServerPrefsWriter(request, scope);
    const completed = createDeferred();
    const afterCommit = vi.fn(() => completed.resolve());
    localStorage.setItem(pendingKey, JSON.stringify({ tabIcon: "custom" }));

    flushServerUiPrefs(writer, { profileId, canWrite: true, afterCommit });
    await completed.promise;

    expect(afterCommit).toHaveBeenCalledExactlyOnceWith({
      needsRefresh: false,
      retainedLocal: true,
    });
    expect(request).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });
});

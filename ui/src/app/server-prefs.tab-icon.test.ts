/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabIconPreference } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { changedServerUiPrefs, selectThemeSettings } from "./server-prefs-intent.ts";
import { writeProfileAppearancePrefs } from "./server-prefs-profile-runtime.ts";
import {
  extractServerUiPrefs,
  prefValuesEqual,
  serverPrefsLocalPatch,
} from "./server-prefs-state.ts";
import { configWithPrefs, createServerPrefsWriter } from "./server-prefs.test-support.ts";
import {
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPref,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";

const scope = "ws://tab-icon-prefs";
const profileId = "profile-icon";
const image = {
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=",
  fileName: "icon.png",
};
const tabIcon: TabIconPreference = { mode: "custom", image };
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
  it("round-trips the upload through all modes and leaves it intact on theme selection", () => {
    for (const mode of ["custom", "agent", "default"] as const) {
      patchSettings({ tabIcon: { mode, image } });
      expect(loadSettings().tabIcon).toEqual({ mode, image });
      expect(JSON.parse(localStorage.getItem(settingsKeyForGateway(scope))!).tabIcon).toEqual({
        mode,
        image,
      });
    }
    selectThemeSettings("dash");
    expect(loadSettings().tabIcon).toEqual({ mode: "default", image });
    patchSettings({ tabIcon: { mode: "custom" } });
    expect(loadSettings().tabIcon).toEqual({ mode: "custom" });
    const previous = loadSettings();
    const next = resetServerUiPref("tabIcon");
    expect(next.tabIcon).toBeUndefined();
    expect(changedServerUiPrefs(previous, next)).toMatchObject({ tabIcon: null });
    expect(JSON.parse(localStorage.getItem(settingsKeyForGateway(scope))!)).not.toHaveProperty(
      "tabIcon",
    );
  });

  it("compares normalized structured values rather than object identity or key order", () => {
    patchSettings({ tabIcon });
    const previous = loadSettings();
    const copied: TabIconPreference = {
      image: { fileName: image.fileName, dataUrl: image.dataUrl },
      mode: "custom",
    };
    expect(prefValuesEqual(tabIcon, copied)).toBe(true);
    expect(changedServerUiPrefs(previous, { ...previous, tabIcon: copied })).toBeNull();
    expect(serverPrefsLocalPatch({ tabIcon: copied }, previous)).toBeNull();
    expect(prefValuesEqual(tabIcon, { ...copied, mode: "agent" })).toBe(false);
    expect(
      prefValuesEqual(tabIcon, { ...copied, image: { ...image, fileName: "other.png" } }),
    ).toBe(false);
    expect(prefValuesEqual({ mode: "custom" }, { mode: "custom", image })).toBe(false);
  });

  it("rejects malformed browser mirrors and never reads the icon from gateway config", () => {
    const key = settingsKeyForGateway(scope);
    localStorage.setItem(
      key,
      JSON.stringify({
        gatewayUrl: scope,
        tabIcon: {
          mode: "custom",
          image: { fileName: "unsafe.svg", dataUrl: "data:image/svg+xml,<svg/>" },
        },
      }),
    );
    expect(loadSettings().tabIcon).toBeUndefined();
    expect(extractServerUiPrefs(configWithPrefs({ tabIcon, theme: "claw" }))).toEqual({
      theme: "claw",
    });
  });

  it("reconciles profile changes and clears an icon absent from the next profile", async () => {
    const config = configWithPrefs({ tabIcon: { mode: "agent" } });
    const first = createServerPrefsWriter(
      vi.fn(async () => ({
        status: "ok",
        entries: { "ui.tabIcon": tabIcon },
      })),
      scope,
    );
    const second = createServerPrefsWriter(
      vi.fn(async () => ({ status: "ok", entries: {} })),
      scope,
    );
    const options = { profileId, configObject: config, scope, onApplied: vi.fn() };
    await refreshProfileAppearancePrefs({ ...options, client: first.state.client! });
    expect(loadSettings().tabIcon).toEqual(tabIcon);
    expect(
      resolveServerUiPrefState(config, "tabIcon", scope, loadSettings(), { profileId }),
    ).toMatchObject({ provenance: "profile", value: tabIcon, resetValue: undefined });
    await refreshProfileAppearancePrefs({
      ...options,
      profileId: "profile-other",
      client: second.state.client!,
    });
    expect(loadSettings().tabIcon).toBeUndefined();
    await refreshProfileAppearancePrefs({ ...options, client: first.state.client! });
    expect(loadSettings().tabIcon).toEqual(tabIcon);
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
      const iconStarted = createDeferred<void>();
      const iconReply = createDeferred<{ status: "ok" | "no_durable_identity" }>();
      const completed = createDeferred<void>();
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
        if (++commits === 2) completed.resolve();
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
    const completed = createDeferred<void>();
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
          if (++commits === 2) completed.resolve();
        },
      },
    );
    await completed.promise;
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: { "ui.tabIcon": null },
    });
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });

  it("rejects malformed queued icons before any profile write", async () => {
    const request = vi.fn(async () => ({ status: "ok" }));
    const writer = createServerPrefsWriter(request, scope);
    const invalid = {
      mode: "custom",
      image: { dataUrl: "https://example.com/icon.png", fileName: "icon.png" },
    } as const;
    const result = await writeProfileAppearancePrefs(
      writer.state.client,
      { tabIcon: invalid },
      true,
    );
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(request).not.toHaveBeenCalled();
  });
});

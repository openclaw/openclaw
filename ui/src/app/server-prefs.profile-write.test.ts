/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { configWithPrefs, createServerPrefsWriter } from "./server-prefs.test-support.ts";
import {
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const profileId = "profile-theme-writer";
const scope = "ws://appearance-batch";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "keeps mixed profile appearance edits in one mutation (rejected=%s)",
  async (rejected) => {
    const entries = {
      "ui.theme": "knot",
      "ui.accent": "#123456",
      "ui.fontUi": "geist",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries };
      }
      if (rejected) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Theme is no longer available.",
        });
      }
      return { application: "saved" };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const config = configWithPrefs({ theme: "claw" });
    const profileRead = {
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs(profileRead);
    request.mockClear();

    const local = {
      theme: "space-pack/xenovessel",
      themeMode: "dark",
      accent: "#654321",
      fontUi: undefined,
      fontChat: "lora",
    } as const;
    patchSettings(local);
    const afterCommit = vi.fn();
    pushServerUiPrefs(
      writer,
      { ...local, fontUi: null },
      { profileId, canWrite: true, afterCommit },
    );
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledExactlyOnceWith("themes.set", {
      id: "space-pack/xenovessel",
      mode: "dark",
      appearance: { accent: "#654321", fontUi: null, fontChat: "lora" },
    });
    expect(afterCommit).toHaveBeenCalledWith(
      rejected ? { needsRefresh: false, retainedLocal: true } : { needsRefresh: false },
    );
    expect(loadSettings()).toMatchObject(local);
    if (rejected) {
      await refreshProfileAppearancePrefs(profileRead);
      expect(loadSettings()).toMatchObject(local);
    }
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId }),
    ).toMatchObject({ provenance: rejected ? "device-local" : "profile", value: local.theme });
  },
);

/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { resolveServerUiPrefWriteStatus, retryServerUiPrefWrite } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { applyServerUiPrefs } from "./server-prefs-reconcile.ts";
import {
  createServerPrefsWriter,
  initializeServerPrefsProfile,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://background-retry";
const profileId = "viewer-retry";
const none = selectBackgroundSource({ kind: "none" });
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:" + profileId;
const status = () => resolveServerUiPrefWriteStatus("background", scope, profileId).status;

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  await initializeServerPrefsProfile(scope, profileId);
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function failBackgroundWrite() {
  const request = vi.fn(async () => {
    throw new Error("offline");
  });
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  patchSettings({ background: none });
  pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("error"));
  return { request, writer };
}

it.each(["transient", "rejected"] as const)(
  "retries an unchanged None after %s failure using the original writer and commit hook",
  async (failure) => {
    let fail = true;
    const request = vi.fn(async () => {
      if (fail) {
        throw failure === "rejected"
          ? new GatewayRequestError({ code: "INVALID_REQUEST", message: "Try again" })
          : new Error("Connection lost");
      }
      return { status: "ok" };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const afterCommit = vi.fn();
    patchSettings({ background: none });
    pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: true, afterCommit });
    await waitForFast(() => expect(status()).toBe("error"));
    const before = loadSettings();
    expect(changedServerUiPrefs(before, patchSettings({ background: none }))).toBeNull();
    fail = false;
    expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
    expect(status()).toBe("pending");
    await waitForFast(() => expect(status()).toBe("saved"));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: { "ui.background": none },
      expectedEntries: { "ui.background": null },
    });
    expect(afterCommit).toHaveBeenLastCalledWith({ needsRefresh: false });
    expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(false);
  },
);

it("refuses another Gateway, anonymous target, switched identity, or disconnected writer", async () => {
  const { request, writer } = await failBackgroundWrite();
  expect(retryServerUiPrefWrite("background", "ws://another", profileId)).toBe(false);
  expect(retryServerUiPrefWrite("background", scope, null)).toBe(false);
  expect(retryServerUiPrefWrite("background", scope, "another-person")).toBe(false);
  Object.assign(writer.state, { connected: false });
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(false);
  Object.assign(writer.state, { connected: true });
  applyServerUiPrefs({}, { scope, profileId: "another-person", onApplied: vi.fn() });
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(false);
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ background: none });
});

it("does not resurrect a failed pending write cancelled by another tab", async () => {
  const { request } = await failBackgroundWrite();
  localStorage.removeItem(pendingKey);
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(false);
  expect(localStorage.getItem(pendingKey)).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});

it("does not replay a stale failure above newer local intent", async () => {
  const { request } = await failBackgroundWrite();
  const replacement = selectBackgroundSource({ kind: "theme" });
  patchSettings({ background: replacement });
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(false);
  expect(loadSettings().background).toEqual(replacement);
  expect(request).toHaveBeenCalledOnce();
});

it("requires current write authority before retrying retained local intent", async () => {
  const request = vi.fn(async () => ({ status: "ok" }));
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  const afterCommit = vi.fn();
  patchSettings({ background: none });
  pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: false, afterCommit });
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(false);
  expect(request).not.toHaveBeenCalled();
  flushServerUiPrefs(writer, { profileId, canWrite: true, afterCommit });
  expect(retryServerUiPrefWrite("background", scope)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.set", {
    entries: { "ui.background": none },
    expectedEntries: { "ui.background": null },
  });
  expect(afterCommit).toHaveBeenLastCalledWith({ needsRefresh: false });
});

it.each(["transient", "rejected"] as const)(
  "retries an explicit deletion after %s failure without creating a default override",
  async (failure) => {
    let fail = true;
    const request = vi.fn(async () => {
      if (fail) {
        throw failure === "rejected"
          ? new GatewayRequestError({ code: "INVALID_REQUEST", message: "Try again" })
          : new Error("offline");
      }
      return { status: "ok" };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    pushServerUiPrefs(writer, { background: null }, { profileId, canWrite: true });
    await waitForFast(() => expect(status()).toBe("error"));
    fail = false;
    expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
    await waitForFast(() => expect(status()).toBe("saved"));
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: { "ui.background": null },
      expectedEntries: { "ui.background": null },
    });
  },
);

it.each(["push", "flush"] as const)(
  "continues config preferences after a background CAS conflict through %s",
  async (entry) => {
    vi.useFakeTimers();
    const refreshStarted = createDeferred();
    const refresh = createDeferred();
    const changedElsewhere = selectBackgroundSource({ kind: "theme" });
    const request = vi.fn(async (method: string) => {
      if (method === "users.prefs.set") {
        return { status: "conflict" };
      }
      if (method === "users.prefs.get") {
        refreshStarted.resolve();
        await refresh.promise;
        return { status: "ok", entries: { "ui.background": changedElsewhere } };
      }
      return { ok: true };
    });
    const writer = createServerPrefsWriter(request, scope);
    const afterCommit = vi.fn();
    const hooks = { profileId, canWrite: true, afterCommit };
    patchSettings({ background: none, locale: "de" });
    pushServerUiPrefs(
      entry === "push" ? writer : createServerPrefsWriter(request, scope, false),
      { background: none, locale: "de" },
      hooks,
    );
    if (entry === "flush") {
      flushServerUiPrefs(writer, hooks);
    }
    await refreshStarted.promise;
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ locale: "de" });
    refresh.resolve();
    await vi.runAllTimersAsync();

    expect(request).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { locale: "de" } } }),
      note: "control-ui prefs sync",
      response: "summary",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "users.prefs.set",
      "users.prefs.get",
      "config.patch",
    ]);
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(afterCommit).toHaveBeenCalledTimes(2);
    expect(afterCommit).toHaveBeenNthCalledWith(1, { needsRefresh: false, retainedLocal: true });
    expect(afterCommit).toHaveBeenNthCalledWith(2, { needsRefresh: false });
    expect(status()).toBe("error");
    expect(loadSettings().background).toEqual(none);
    expect(resolveServerUiPrefWriteStatus("locale", scope, profileId).status).toBe("saved");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  },
);

it.each(["writer", "identity", "disconnect", "commit-hook"] as const)(
  "does not continue a conflicted mixed batch after %s retirement",
  async (retirement) => {
    vi.useFakeTimers();
    const refreshStarted = createDeferred();
    const refresh = createDeferred();
    const request = vi.fn(async (method: string) => {
      if (method === "users.prefs.set") {
        return { status: "conflict" };
      }
      if (method === "users.prefs.get") {
        refreshStarted.resolve();
        await refresh.promise;
        return { status: "ok", entries: {} };
      }
      return { ok: true };
    });
    const writer = createServerPrefsWriter(request, scope);
    const retireIdentity = () =>
      applyServerUiPrefs(
        {},
        {
          scope,
          profileId: "another-viewer",
          onApplied: vi.fn(),
        },
      );
    const afterCommit = vi.fn(() => {
      if (retirement === "commit-hook") {
        retireIdentity();
      }
    });
    patchSettings({ background: none, locale: "de" });
    pushServerUiPrefs(
      writer,
      { background: none, locale: "de" },
      {
        profileId,
        canWrite: true,
        afterCommit,
      },
    );
    await refreshStarted.promise;
    if (retirement === "writer") {
      flushServerUiPrefs(createServerPrefsWriter(vi.fn(), "ws://replacement"), {
        profileId: "another-viewer",
        canWrite: true,
      });
    } else if (retirement === "identity") {
      retireIdentity();
    } else if (retirement === "disconnect") {
      Object.assign(writer.state, { connected: false });
    }
    refresh.resolve();
    await vi.runAllTimersAsync();

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "users.prefs.set",
      "users.prefs.get",
    ]);
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ locale: "de" });
    expect(afterCommit).toHaveBeenCalledTimes(retirement === "commit-hook" ? 1 : 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  },
);

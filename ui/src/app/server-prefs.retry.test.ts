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
  type RequestMock,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://background-retry";
const profileId = "viewer-retry";
const none = selectBackgroundSource({ kind: "none" });
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:" + profileId;
const status = () => resolveServerUiPrefWriteStatus("background", scope, profileId).status;
const createWriter = (request: RequestMock, canPatch = false) =>
  createServerPrefsWriter(request, scope, true, { ok: true }, canPatch);
const retry = () => retryServerUiPrefWrite("background", scope, profileId);
const hooks = { profileId, canWrite: true };
const expectedEntries = { "ui.background": null };
const readPending = () => JSON.parse(localStorage.getItem(pendingKey)!);

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
  const request: RequestMock = vi.fn().mockRejectedValue(new Error("offline"));
  const writer = createWriter(request);
  patchSettings({ background: none });
  pushServerUiPrefs(writer, { background: none }, hooks);
  await waitForFast(() => expect(status()).toBe("error"));
  return { request, writer };
}

it.each([
  ["unchanged None after transient failure", none, new Error("Connection lost")],
  [
    "deletion after rejection",
    null,
    new GatewayRequestError({ code: "INVALID_REQUEST", message: "Try again" }),
  ],
] as const)("retries %s through its original writer", async (_name, background, error) => {
  let fail = true;
  const request: RequestMock = vi.fn(() =>
    fail ? Promise.reject(error) : Promise.resolve({ status: "ok" }),
  );
  const writer = createWriter(request);
  const afterCommit = vi.fn();
  if (background) {
    patchSettings({ background });
  }
  pushServerUiPrefs(writer, { background }, { ...hooks, afterCommit });
  await waitForFast(() => expect(status()).toBe("error"));
  if (background) {
    const before = loadSettings();
    expect(changedServerUiPrefs(before, patchSettings({ background }))).toBeNull();
  }
  fail = false;
  expect(retry()).toBe(true);
  expect(status()).toBe("pending");
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
    entries: { "ui.background": background },
    expectedEntries,
  });
  expect(afterCommit).toHaveBeenLastCalledWith({ needsRefresh: false });
  expect(retry()).toBe(false);
});

it("refuses another Gateway, anonymous target, switched identity, or disconnected writer", async () => {
  const { request, writer } = await failBackgroundWrite();
  expect(retryServerUiPrefWrite("background", "ws://another", profileId)).toBe(false);
  expect(retryServerUiPrefWrite("background", scope, null)).toBe(false);
  expect(retryServerUiPrefWrite("background", scope, "another-person")).toBe(false);
  Object.assign(writer.state, { connected: false });
  expect(retry()).toBe(false);
  Object.assign(writer.state, { connected: true });
  applyServerUiPrefs({}, { scope, profileId: "another-person", onApplied: vi.fn() });
  expect(retry()).toBe(false);
  expect(request).toHaveBeenCalledOnce();
  expect(readPending()).toEqual({ background: none });
});

it("does not resurrect a failed pending write cancelled by another tab", async () => {
  const { request } = await failBackgroundWrite();
  localStorage.removeItem(pendingKey);
  expect(retry()).toBe(false);
  expect(localStorage.getItem(pendingKey)).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});

it("requires current write authority before retrying retained local intent", async () => {
  const request: RequestMock = vi.fn().mockResolvedValue({ status: "ok" });
  const writer = createWriter(request);
  const afterCommit = vi.fn();
  patchSettings({ background: none });
  pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: false, afterCommit });
  expect(retry()).toBe(false);
  expect(request).not.toHaveBeenCalled();
  flushServerUiPrefs(writer, { profileId, canWrite: true, afterCommit });
  expect(retryServerUiPrefWrite("background", scope)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.set", {
    entries: { "ui.background": none },
    expectedEntries,
  });
  expect(afterCommit).toHaveBeenLastCalledWith({ needsRefresh: false });
});

it.each(["none", "writer", "identity", "disconnect", "commit-hook"] as const)(
  "settles a conflicted batch after %s retirement",
  async (retirement) => {
    vi.useFakeTimers();
    const retireIdentity = () =>
      applyServerUiPrefs({}, { scope, profileId: "another-viewer", onApplied: vi.fn() });
    const afterCommit = vi.fn(retirement === "commit-hook" ? retireIdentity : undefined);
    const entries =
      retirement === "none" ? { "ui.background": selectBackgroundSource({ kind: "theme" }) } : {};
    const started = createDeferred();
    const refresh = createDeferred();
    const request = vi.fn(async (method: string) => {
      if (method === "users.prefs.get") {
        started.resolve();
        await refresh.promise;
        return { status: "ok", entries };
      }
      return method === "users.prefs.set" ? { status: "conflict" } : { ok: true };
    });
    const writer = createWriter(request, true);
    const prefs = { background: none, locale: "de" };
    patchSettings(prefs);
    pushServerUiPrefs(writer, prefs, { ...hooks, afterCommit });
    await started.promise;
    expect(readPending()).toEqual({ locale: "de" });
    if (retirement === "writer") {
      flushServerUiPrefs(createServerPrefsWriter(vi.fn(), "ws://replacement"), {
        ...hooks,
        profileId: "another-viewer",
      });
    } else if (retirement === "identity") {
      retireIdentity();
    } else if (retirement === "disconnect") {
      Object.assign(writer.state, { connected: false });
    }
    refresh.resolve();
    await vi.runAllTimersAsync();

    if (retirement === "none") {
      expect(request).toHaveBeenCalledWith("config.patch", {
        raw: JSON.stringify({ ui: { prefs: { locale: "de" } } }),
        note: "control-ui prefs sync",
      });
      expect(localStorage.getItem(pendingKey)).toBeNull();
      expect(afterCommit.mock.calls).toEqual([
        [{ needsRefresh: false, retainedLocal: true }],
        [{ needsRefresh: false }],
      ]);
      expect(status()).toBe("error");
      expect(loadSettings().background).toEqual(none);
      expect(resolveServerUiPrefWriteStatus("locale", scope, profileId).status).toBe("saved");
    } else {
      expect(readPending()).toEqual({ locale: "de" });
      expect(afterCommit).toHaveBeenCalledTimes(retirement === "commit-hook" ? 1 : 0);
    }
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "users.prefs.set",
      "users.prefs.get",
      ...(retirement === "none" ? ["config.patch"] : []),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  },
);

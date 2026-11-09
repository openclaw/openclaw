// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { AgentToolGatewayRequestCaller } from "../../../src/agents/tools/in-process-gateway.js";
import { runPersonalSessionGroups } from "../../../src/agents/tools/sessions-personal-groups.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { resolveServerUiPrefWriteStatus } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { adoptLocalPersonalSessionGroups } from "./server-prefs-profile-runtime.ts";
import {
  createProfilePrefsServer,
  installServerPrefsStorage,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

const scope = "ws://navigation";
const key = "ui.personalSessionGroups";
const focus = { id: "focus", label: "Focus", sessionKeys: ["agent:main:focus"] };
const later = { id: "later", label: "Later", sessionKeys: [] };
const hooks = (write = true) => ({
  profile: {
    selfUser: { id: "guest" },
    hello: gatewayHelloForMethods(
      ["users.prefs.get", "users.prefs.set"],
      ["operator.sessions.read", ...(write ? ["operator.sessions.write"] : [])],
    ),
  },
});
installServerPrefsStorage(scope, true);

it("retains an existing guest layout through agent editing and reload without syncing other preferences", async () => {
  const backend = createProfilePrefsServer({ guest: {} });
  const guest = backend.connect("guest");
  await guest.refresh();
  const before = loadSettings();
  const next = patchSettings({ personalSessionGroups: [focus] });
  // The previous release's guest policy left this authored layout in browser storage.
  pushServerUiPrefs(guest.writer, changedServerUiPrefs(before, next)!, {
    profileId: "guest",
    canWrite: false,
  });
  await vi.dynamicImportSettled();
  expect(backend.profiles.guest![key]).toBeUndefined();
  flushServerUiPrefs(guest.writer, hooks());
  adoptLocalPersonalSessionGroups(guest.writer, hooks());
  await vi.dynamicImportSettled();
  const request: AgentToolGatewayRequestCaller = async <T>({
    method,
    params,
  }: Parameters<AgentToolGatewayRequestCaller>[0]) => (await guest.request(method, params)) as T;
  const listed = await runPersonalSessionGroups(
    "personal_group_list",
    { action: "personal_group_list" },
    request,
  );
  expect(listed.details).toEqual({ status: "ok", groups: [focus], expectedGroups: [focus] });
  await runPersonalSessionGroups(
    "personal_group_set",
    {
      action: "personal_group_set",
      groups: [focus, later],
      expectedGroups: [focus],
    },
    request,
  );
  const previous = loadSettings();
  const local = patchSettings({ theme: "rose", sidebarEntries: ["route:cron"] });
  pushServerUiPrefs(guest.writer, changedServerUiPrefs(previous, local)!, hooks());
  await vi.dynamicImportSettled();
  resetServerUiPrefsSync();
  invalidateUserPreferences(guest.writer.state.client!);
  await guest.refresh();
  expect(loadSettings()).toMatchObject({
    personalSessionGroups: [focus, later],
    theme: "rose",
    sidebarEntries: ["route:cron"],
  });
  expect(backend.profiles.guest).toEqual({ [key]: [focus, later] });
});

it.each([false, true])(
  "adoption preserves both layouts when the server changed (same group conflict=%s)",
  async (conflict) => {
    const backend = createProfilePrefsServer({ guest: {} });
    const guest = backend.connect("guest");
    await guest.refresh();
    const before = loadSettings();
    const local = patchSettings({ personalSessionGroups: [focus] });
    pushServerUiPrefs(guest.writer, changedServerUiPrefs(before, local)!, {
      profileId: "guest",
      canWrite: false,
    });
    const remote = conflict ? { ...focus, label: "Remote focus" } : later;
    backend.profiles.guest![key] = [remote];
    invalidateUserPreferences(guest.writer.state.client!);
    flushServerUiPrefs(guest.writer, hooks());
    adoptLocalPersonalSessionGroups(guest.writer, hooks());
    await vi.dynamicImportSettled();
    if (conflict) {
      expect(backend.profiles.guest![key]).toEqual([remote]);
      expect(loadSettings().personalSessionGroups).toEqual([focus]);
      expect(resolveServerUiPrefWriteStatus("personalSessionGroups", scope, "guest").status).toBe(
        "error",
      );
    } else {
      expect(backend.profiles.guest![key]).toEqual([remote, focus]);
      expect(loadSettings().personalSessionGroups).toEqual([remote, focus]);
    }
  },
);

it("rechecks scoped authority after the group read before saving", async () => {
  const guest = createProfilePrefsServer({ guest: {} }).connect("guest");
  await guest.refresh();
  const read = createDeferred<unknown>();
  const started = createDeferred();
  guest.request.mockImplementation(async (method) => {
    if (method === "users.prefs.get") {
      started.resolve();
      return read.promise;
    }
    throw new Error("unexpected save after access revocation");
  });
  const before = loadSettings();
  const next = patchSettings({ personalSessionGroups: [focus] });
  pushServerUiPrefs(guest.writer, changedServerUiPrefs(before, next)!, hooks());
  await started.promise;
  flushServerUiPrefs(guest.writer, hooks(false));
  read.resolve({ status: "ok", entries: {} });
  await vi.dynamicImportSettled();
  expect(guest.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
  expect(loadSettings().personalSessionGroups).toEqual([focus]);
});

it.each([
  { operation: "remove", remote: false, foreign: false },
  { operation: "rename", remote: false, foreign: false },
  { operation: "remove", remote: true, foreign: false },
  { operation: "remove", remote: false, foreign: true },
])(
  "settles descendant $operation without erasing concurrent groups (remote=$remote, foreign=$foreign)",
  async ({ operation, remote, foreign }) => {
    const backend = createProfilePrefsServer({ guest: {} });
    const guest = backend.connect("guest");
    await guest.refresh();
    const started = createDeferred();
    const ack = createDeferred();
    const original = guest.request.getMockImplementation()!;
    let held = false;
    if (remote) {
      backend.profiles.guest![key] = [later];
    }
    guest.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === "users.prefs.set" && !held) {
        held = true;
        started.resolve();
        await ack.promise;
      }
      return result;
    });
    const before = loadSettings();
    const first = patchSettings({ personalSessionGroups: [focus] });
    pushServerUiPrefs(guest.writer, changedServerUiPrefs(before, first)!, hooks());
    await started.promise;
    const desired = operation === "remove" ? [] : [{ ...focus, label: "Renamed" }];
    const second = patchSettings({ personalSessionGroups: desired });
    pushServerUiPrefs(guest.writer, changedServerUiPrefs(first, second)!, hooks());
    if (foreign) {
      localStorage.setItem(
        "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:guest",
        JSON.stringify({ personalSessionGroups: [later], personalSessionGroupsBase: null }),
      );
    }
    ack.resolve();
    await vi.dynamicImportSettled();
    const expected = foreign ? [focus, later] : remote ? [later, ...desired] : desired;
    expect(backend.profiles.guest![key]).toEqual(expected);
    expect(loadSettings().personalSessionGroups).toEqual(expected);
  },
);

it("adopts a pre-upgrade queued layout using its saved confirmed profile baseline", async () => {
  const backend = createProfilePrefsServer({ guest: {} });
  const guest = backend.connect("guest");
  await guest.refresh();
  Object.assign(guest.writer.state, { connected: false });
  const before = loadSettings();
  const next = patchSettings({ personalSessionGroups: [focus] });
  pushServerUiPrefs(guest.writer, changedServerUiPrefs(before, next)!, hooks());
  const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:guest";
  const oldPayload = JSON.parse(localStorage.getItem(pendingKey)!);
  delete oldPayload.personalSessionGroupsBase;
  localStorage.setItem(pendingKey, JSON.stringify(oldPayload));
  resetServerUiPrefsSync();
  Object.assign(guest.writer.state, { connected: true });
  flushServerUiPrefs(guest.writer, hooks());
  await vi.dynamicImportSettled();
  expect(backend.profiles.guest![key]).toEqual([focus]);
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

it.each(
  [false, true].flatMap((committed) => [
    { committed, kind: "remove", original: [], intermediate: [focus], desired: [] },
    { committed, kind: "restore", original: [focus], intermediate: [], desired: [focus] },
    {
      committed,
      kind: "label reversal",
      original: [focus],
      intermediate: [{ ...focus, label: "Work" }],
      desired: [focus],
    },
    {
      committed,
      kind: "reference reversal",
      original: [focus],
      intermediate: [{ ...focus, sessionKeys: ["agent:main:later"] }],
      desired: [focus],
    },
    {
      committed,
      kind: "order reversal",
      original: [focus, later],
      intermediate: [later, focus],
      desired: [focus, later],
    },
    {
      committed,
      kind: "order reversal with addition",
      original: [focus, later],
      intermediate: [later, focus],
      desired: [focus, later, { id: "extra", label: "Extra", sessionKeys: [] }],
    },
  ]),
)(
  "preserves queued $kind across reload before acknowledgement (committed=$committed)",
  async ({ committed, original: groups, intermediate, desired }) => {
    const backend = createProfilePrefsServer({ guest: groups.length ? { [key]: groups } : {} });
    const guest = backend.connect("guest");
    await guest.refresh();
    const started = createDeferred();
    const release = createDeferred();
    const original = guest.request.getMockImplementation()!;
    let held = false;
    guest.request.mockImplementation(async (method, params) => {
      if (method === "users.prefs.set" && !held) {
        held = true;
        const result = committed ? await original(method, params) : undefined;
        started.resolve();
        await release.promise;
        if (!committed) {
          throw new Error("connection closed before commit");
        }
        return result;
      }
      return original(method, params);
    });
    const before = loadSettings();
    const first = patchSettings({ personalSessionGroups: intermediate });
    pushServerUiPrefs(guest.writer, changedServerUiPrefs(before, first)!, hooks());
    await started.promise;
    const removed = patchSettings({ personalSessionGroups: desired });
    pushServerUiPrefs(guest.writer, changedServerUiPrefs(first, removed)!, hooks());
    // Losing this tab retires the in-memory composition callback; only storage survives.
    resetServerUiPrefsSync();
    release.resolve();
    const restored = backend.connect("guest");
    flushServerUiPrefs(restored.writer, hooks());
    await vi.dynamicImportSettled();
    expect(backend.profiles.guest![key]).toEqual(desired);
    expect(loadSettings().personalSessionGroups).toEqual(desired);
    expect(
      localStorage.getItem("openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:guest"),
    ).toBeNull();
  },
);

it("retains a localized collection conflict while unrelated profile preferences drain", async () => {
  const backend = createProfilePrefsServer({ guest: { [key]: [focus] } });
  const guest = backend.connect("guest");
  await guest.refresh();
  const translate = i18n.t.bind(i18n);
  vi.spyOn(i18n, "t").mockImplementation((name, params) =>
    name === "quickSettings.personal.groupsConflict"
      ? "localized collection conflict"
      : translate(name, params),
  );
  const before = loadSettings();
  const local = { ...focus, label: "Local focus" };
  const next = patchSettings({ personalSessionGroups: [local] });
  const remote = { ...focus, label: "Remote focus" };
  backend.profiles.guest![key] = [remote];
  invalidateUserPreferences(guest.writer.state.client!);
  const authority = { profileId: "guest", canWrite: true };
  pushServerUiPrefs(guest.writer, changedServerUiPrefs(before, next)!, authority);
  await vi.dynamicImportSettled();
  expect
    .soft(resolveServerUiPrefWriteStatus("personalSessionGroups", scope, "guest"))
    .toEqual({ status: "error", error: "localized collection conflict" });
  const withFont = patchSettings({ fontUi: "geist" });
  pushServerUiPrefs(guest.writer, changedServerUiPrefs(next, withFont)!, authority);
  await vi.dynamicImportSettled();
  expect(backend.profiles.guest).toEqual({ [key]: [remote], "ui.fontUi": "geist" });
  expect(loadSettings().personalSessionGroups).toEqual([local]);
  expect(resolveServerUiPrefWriteStatus("personalSessionGroups", scope, "guest").status).toBe(
    "error",
  );
});

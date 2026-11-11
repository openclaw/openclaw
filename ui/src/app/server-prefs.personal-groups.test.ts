// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { refreshProfileAppearancePrefs } from "./server-prefs-reconcile.ts";
import {
  createProfilePrefsServer,
  installServerPrefsStorage,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

const scope = "ws://navigation";
const groupsKey = "ui.personalSessionGroups";
const pinsKey = "ui.railShortcuts";
const group = (id: string) => ({ id, label: id, sessionKeys: ["agent:main:" + id] });
const authority = { profileId: "a", canWrite: true };
installServerPrefsStorage(scope, true);

it("syncs only the authored field through profile CAS and hydrates it in another device", async () => {
  const backend = createProfilePrefsServer({ a: { [pinsKey]: ["route:usage"] } });
  const a = backend.connect("a");
  await a.refresh();
  const previous = loadSettings();
  const next = patchSettings({ personalSessionGroups: [group("project")] });
  const delta = changedServerUiPrefs(previous, next)!;
  expect(delta).toEqual({ personalSessionGroups: [group("project")] });
  pushServerUiPrefs(a.writer, delta, authority);
  await vi.dynamicImportSettled();
  expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([
    [
      "users.prefs.set",
      { entries: { [groupsKey]: [group("project")] }, expectedEntries: { [groupsKey]: null } },
    ],
  ]);
  a.request.mockClear();
  const beforePin = loadSettings();
  const withPin = patchSettings({ sidebarEntries: ["route:cron"] });
  pushServerUiPrefs(a.writer, changedServerUiPrefs(beforePin, withPin)!, authority);
  await vi.dynamicImportSettled();
  expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([
    [
      "users.prefs.set",
      { entries: { [pinsKey]: ["route:cron"] }, expectedEntries: { [pinsKey]: ["route:usage"] } },
    ],
  ]);
  resetServerUiPrefsSync();
  localStorage.clear();
  patchSettings({ gatewayUrl: scope });
  await backend.connect("a").refresh();
  expect(loadSettings()).toMatchObject({
    personalSessionGroups: [group("project")],
    sidebarEntries: ["route:cron"],
  });
});

it("retains read-only groups through reload until a confirmed profile delta arrives", async () => {
  const backend = createProfilePrefsServer({ a: { [groupsKey]: [group("server")] } });
  const a = backend.connect("a");
  await a.refresh();
  const before = loadSettings();
  const next = patchSettings({ personalSessionGroups: [group("local")] });
  pushServerUiPrefs(a.writer, changedServerUiPrefs(before, next)!, {
    ...authority,
    canWrite: false,
  });
  resetServerUiPrefsSync();
  await a.refresh();
  expect(loadSettings().personalSessionGroups).toEqual([group("local")]);
  backend.profiles.a![groupsKey] = [group("updated")];
  invalidateUserPreferences(a.writer.state.client!);
  await a.refresh();
  expect(loadSettings().personalSessionGroups).toEqual([group("updated")]);
  expect(a.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
});

it("replays offline groups only into their original profile", async () => {
  const backend = createProfilePrefsServer({ a: {}, b: {} });
  const a = backend.connect("a");
  await a.refresh();
  Object.assign(a.writer.state, { connected: false });
  const before = loadSettings();
  const next = patchSettings({ personalSessionGroups: [group("offline")] });
  pushServerUiPrefs(a.writer, changedServerUiPrefs(before, next)!, authority);
  const b = backend.connect("b");
  await b.refresh();
  flushServerUiPrefs(b.writer, { profileId: "b", canWrite: true });
  await vi.dynamicImportSettled();
  expect(loadSettings().personalSessionGroups).toEqual([]);
  expect(backend.profiles.b).toEqual({});
  Object.assign(a.writer.state, { connected: true });
  flushServerUiPrefs(a.writer, authority);
  await vi.dynamicImportSettled();
  await a.refresh();
  expect(backend.profiles.a![groupsKey]).toEqual([group("offline")]);
});

it("does not write groups if identity changes during the CAS read", async () => {
  const backend = createProfilePrefsServer({ a: {}, b: {} });
  const a = backend.connect("a");
  await a.refresh();
  const read = createDeferred<unknown>();
  const started = createDeferred();
  const original = a.request.getMockImplementation()!;
  a.request.mockImplementation(async (method, params) => {
    if (method === "users.prefs.get") {
      started.resolve();
      return read.promise;
    }
    return original(method, params);
  });
  pushServerUiPrefs(a.writer, { personalSessionGroups: [group("a-private")] }, authority);
  await started.promise;
  const b = backend.connect("b");
  await refreshProfileAppearancePrefs({
    client: b.writer.state.client!,
    profileId: "b",
    scope,
    configObject: {},
    onApplied: vi.fn(),
  });
  read.resolve({ status: "ok", entries: {} });
  await vi.dynamicImportSettled();
  expect(a.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
  expect(loadSettings().personalSessionGroups).toEqual([]);
});

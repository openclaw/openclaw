// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { AgentToolGatewayRequestCaller } from "../../../src/agents/tools/in-process-gateway.js";
import { runPersonalSessionGroups } from "../../../src/agents/tools/sessions-personal-groups.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { resolveServerUiPrefWriteStatus } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { adoptLocalPersonalSessionGroups } from "./server-prefs-reconcile.ts";
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
  const snapshot = listed.details as { groups: (typeof focus)[]; expectedGroups: unknown };
  expect(snapshot.groups).toEqual([focus]);
  await runPersonalSessionGroups(
    "personal_group_set",
    {
      action: "personal_group_set",
      groups: [...snapshot.groups, later],
      expectedGroups: snapshot.expectedGroups,
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

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { acquirePaletteIdentityPreferences } from "./palette-identity-preferences.ts";

async function fixture(isCurrent = () => true) {
  const firstWrite = createDeferred();
  const entries: Record<string, unknown> = { "new-session.v1:main": { folder: "/normal" } };
  const writes: Record<string, unknown>[] = [];
  const request = vi.fn(async (method: string, params?: { entries?: Record<string, unknown> }) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: structuredClone(entries) };
    }
    if (method === "users.prefs.set") {
      const patch = params?.entries ?? {};
      writes.push(patch);
      if (writes.length === 1) {
        await firstWrite.promise;
      }
      Object.assign(entries, patch);
      Object.keys(patch)
        .filter((key) => patch[key] === null)
        .forEach((key) => delete entries[key]);
      return { status: "ok" };
    }
    throw new Error(method);
  });
  const owner = {
    client: { request } as unknown as GatewayBrowserClient,
    hello: {},
    gatewayUrl: "ws://gateway.example",
    profileId: "alice",
  };
  const state = acquirePaletteIdentityPreferences(owner);
  const save = state.setPalettePreference.bind(state);
  const stop = state.subscribe(() => {}, isCurrent);
  onTestFinished(() => {
    firstWrite.resolve();
    stop();
  });
  const listen = (current: () => boolean) => {
    const listener = vi.fn();
    onTestFinished(state.subscribe(listener, current));
    return listener;
  };
  await vi.waitFor(() => expect(state.mode).toBe("remote"));
  return { owner, state, entries, writes, release: firstWrite.resolve, listen, save };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("scopes its cache and reads without migrating or writing ordinary defaults", async () => {
  const { owner, state, entries, writes } = await fixture();
  expect(acquirePaletteIdentityPreferences(owner)).toBe(state);
  expect(acquirePaletteIdentityPreferences({ ...owner, hello: {} })).not.toBe(state);
  expect(acquirePaletteIdentityPreferences({ ...owner, profileId: "bob" })).not.toBe(state);
  expect(state.palettePreference).toBeNull();
  expect(writes).toEqual([]);
  expect(entries).toEqual({ "new-session.v1:main": { folder: "/normal" } });
});

it.each(["queued", "new"] as const)("rejects retired %s intent", async (phase) => {
  let current = phase === "queued";
  const { save, writes, release } = await fixture(() => phase === "new" || current);
  const first =
    phase === "queued" ? save({ agentId: "first", selection: {} }, () => true) : undefined;
  const rejected = save({ agentId: "retired", selection: {} }, () => current);
  if (first) {
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    current = false;
    release();
    expect(await first).toBe(true);
  }
  expect(await rejected).toBe(false);
  expect(writes).toHaveLength(phase === "queued" ? 1 : 0);
});

it("publishes a confirmed write to surviving current subscribers, not a retired initiator", async () => {
  const { save, writes, release, listen } = await fixture();
  let current = true;
  const retired = listen(() => current);
  const surviving = listen(() => true);
  const saved = save({ agentId: "main", selection: { worktree: true } }, () => current);
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  current = false;
  release();
  expect(await saved).toBe(true);
  expect(surviving).toHaveBeenCalledWith("changed");
  expect(retired).not.toHaveBeenCalled();
});

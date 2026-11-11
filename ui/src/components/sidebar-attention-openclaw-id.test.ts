/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createApplicationConfigCapability,
  type ApplicationConfigCapability,
} from "../app/config.ts";
import { client, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import type { OpenClawIdPublication, OpenClawIdStatusResult } from "../lib/openclaw-id/types.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { readOpenClawIdKeyAttention } from "./sidebar-attention-openclaw-id.ts";
import { createStore, cronPage } from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";

const status: OpenClawIdStatusResult = {
  status: { state: "keys_refused", key: "gateway", reason: "keys_missing" },
  channel: "local_operator",
  owner: true,
  link: { linked: true, clawId: "test-claw", hostname: "test.claw.example" },
  services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
};
const superseded = { state: "failed", code: "binding_superseded", message: "superseded" } as const;
let store: SidebarAttentionStore | undefined;
afterEach(() => {
  store?.dispose();
  vi.restoreAllMocks();
});

function setup(read: () => Promise<OpenClawIdStatusResult>) {
  let enabled = true;
  let publication: OpenClawIdPublication = superseded;
  const changes = new Set<Parameters<ApplicationConfigCapability["subscribe"]>[0]>();
  const defaults = createApplicationConfigCapability({ resourceBasePath: "" }).current;
  const config = {
    get current() {
      return { ...defaults, openclawIdEnabled: enabled };
    },
    subscribe(listener: Parameters<ApplicationConfigCapability["subscribe"]>[0]) {
      changes.add(listener);
      return () => changes.delete(listener);
    },
  } satisfies Pick<ApplicationConfigCapability, "current" | "subscribe">;
  const request = vi.fn(async (method: string) => {
    if (method === "openclawId.status") {
      return read();
    }
    if (method === "openclawId.people") {
      return { link: { publication } };
    }
    if (method === "cron.list") {
      return cronPage();
    }
    if (method === "cron.status") {
      return { enabled: true, jobs: 0 };
    }
    return { ts: 1, providers: [] };
  });
  const harness = createGatewayHarness(client(request));
  harness.update({ selfUser: { id: "alice", name: "Alice" } });
  store = createStore(harness.gateway, undefined, undefined, config);
  store.activate(SidebarAttentionStoreOwner);
  return {
    ...harness,
    request,
    recovered() {
      publication = { state: "published", ownerAccountId: "fixture", snapshotSeq: 1 };
      harness.emitEvent("openclawId.people.changed", {});
    },
    disable() {
      enabled = false;
      changes.forEach((listener) => listener(config.current));
    },
  };
}

it.each(["keys_missing", "key_mismatch"] as const)(
  "shows %s in the system inbox",
  async (reason) => {
    const h = setup(async () => ({ ...status, status: { ...status.status, reason } }));
    await waitForFast(() =>
      expect(store?.entries).toMatchObject([
        {
          type: "attention",
          kind: "openClawIdKeys",
          category: "system",
          severity: "error",
          action: { kind: "openClawIdRecovery", label: "Move to new keys" },
        },
      ]),
    );
    expect(h.request.mock.calls.some(([method]) => method === "openclawId.people")).toBe(false);
  },
);

it("shows binding_superseded and clears after recovery", async () => {
  const current = { ...status, status: { state: "on" as const } };
  const h = setup(async () => current);
  await waitForFast(() =>
    expect(store?.entries[0]).toMatchObject({ label: "Newer keys are in use for this claw" }),
  );
  store?.refreshOpenClawId();
  await waitForFast(() =>
    expect(h.request.mock.calls.filter(([method]) => method === "openclawId.people")).toHaveLength(
      2,
    ),
  );
  h.recovered();
  await waitForFast(() => expect(store?.entries).toEqual([]));
});

it("clears on Labs disable and rejects its pending reply", async () => {
  const pending = createDeferred<OpenClawIdStatusResult>();
  let read = async () => status;
  const h = setup(() => read());
  await waitForFast(() => expect(store?.entries).toHaveLength(1));
  read = () => pending.promise;
  store?.refreshOpenClawId();
  const changed = vi.fn();
  const stop = store!.subscribe(changed);
  h.disable();
  expect(store?.entries).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(1);
  changed.mockClear();
  h.request.mockClear();
  h.disable();
  store?.refreshOpenClawId();
  expect(changed).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  stop();
  pending.resolve(status);
  await pending.promise;
  await Promise.resolve();
  expect(store?.entries).toEqual([]);
});

it("rejects an old connection reply", async () => {
  const pending = createDeferred<OpenClawIdStatusResult>();
  const h = setup(() => pending.promise);
  h.update({ phase: "stopped", client: null });
  pending.resolve(status);
  await pending.promise;
  await Promise.resolve();
  expect(store?.entries).toEqual([]);
  expect(h.request.mock.calls.some(([method]) => method === "openclawId.people")).toBe(false);
});

it("never offers local key recovery to a tunnel caller or an off feature", async () => {
  for (const unavailable of [
    { ...status, channel: "tunnel" as const },
    { ...status, status: { state: "off" as const } },
  ]) {
    const gateway = client(vi.fn(async () => unavailable));
    expect(await readOpenClawIdKeyAttention(gateway, () => true)).toBeNull();
  }
});

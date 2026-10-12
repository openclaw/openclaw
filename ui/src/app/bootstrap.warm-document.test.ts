import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient, type GatewayBrowserClientOptions } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, type BootRecord } from "./boot-record.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import * as gatewayStore from "./gateway-store.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

const originalUrl = window.location.href;
const runtimes: ApplicationRuntime[] = [];
let connections: GatewayBrowserClientOptions[];
const mainRecord = (): BootRecord => ({
  version: 2,
  authMethod: "token",
  credential: "9d17676d",
  recoveryScope: "main-device",
  scope: gatewayCredentialScope(loadSettings().gatewayUrl),
  savedAt: Date.now(),
  profileId: "same-profile",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [{ name: "Main private group", position: 0 }],
  sectionOrder: ["Main private group"],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  persistSessionToken(loadSettings().gatewayUrl, "test-token");
  connections = [];
  const createGateway = gatewayStore.createApplicationGateway;
  vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation(
    (settings, password, bootstrap, _factory, options) =>
      createGateway(
        settings,
        password,
        bootstrap,
        (opts) => {
          connections.push(opts);
          const client = new GatewayBrowserClient(opts);
          vi.spyOn(client, "start").mockImplementation(() => {});
          vi.spyOn(client, "request").mockImplementation(async (method) => {
            if (method === "agents.list") {
              return mainRecord().agents;
            }
            if (method === "sessions.groups.list") {
              return { groups: [], sectionOrder: [] };
            }
            if (method === "sessions.groups.defaults") {
              return { defaults: {} };
            }
            return {};
          });
          return client;
        },
        options,
      ),
  );
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.stop();
  }
  clearBootRecords();
  await vi.dynamicImportSettled();
  window.history.replaceState({}, "", originalUrl);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(path: string) {
  window.history.replaceState({}, "", path);
  const runtime = bootstrapApplication();
  runtimes.push(runtime);
  runtime.context.gateway.connect();
  const opts = connections.at(-1)!;
  return { runtime, opts };
}

it.each(["/focus/terminal", "/approve/exec%3A1", "/ask/question-1"])(
  "keeps shellless %s out of main admission reads, publication, and retirement",
  async (route) => {
    const record = mainRecord();
    const key = "openclaw.control.bootRecord.v1:" + record.scope;
    const bytes = JSON.stringify(record);
    localStorage.setItem(key, bytes);
    const reads = vi.spyOn(localStorage, "getItem");
    const { runtime, opts } = open(route + "#bootstrapToken=synthetic-independent-handoff");
    expect(reads.mock.calls.filter(([readKey]) => readKey === key)).toEqual([]);
    expect(runtime.warmBoot).toBe(false);
    expect(opts.offlineRecoveryScope).toBeUndefined();
    expect(runtime.context.sessions.state.groupSettings).toEqual([]);
    opts.onHello?.({
      type: "hello-ok",
      protocol: 1,
      auth: {
        role: "operator",
        scopes: [],
        method: "bootstrap-token",
        deviceToken: "independent-device-grant",
        recoveryScope: "independent-device",
      },
      snapshot: { presence: [{ instanceId: opts.instanceId, user: { id: "same-profile" } }] },
    });
    await runtime.context.agents.ensureList();
    await runtime.context.sessions.groupsLoad();
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(key)).toBe(bytes);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue: bytes, newValue: null }));
    expect(runtime.context.gateway.snapshot.phase).toBe("connected");
    runtime.context.gateway.connect({ password: "independent-password" });
    connections.at(-1)!.onClose?.({
      code: 4008,
      reason: "rejected",
      willRetry: false,
      error: { code: "PAIRING_REQUIRED", message: "Independent rejection" },
    });
    expect(localStorage.getItem(key)).toBe(bytes);
  },
);

it.each(["accepted", "rejected"])(
  "keeps an admitted Chat beside a fresh %s bootstrap document",
  async (outcome) => {
    const record = mainRecord();
    const key = "openclaw.control.bootRecord.v1:" + record.scope;
    localStorage.setItem(key, JSON.stringify(record));
    const chat = open("/chat/main");
    chat.opts.onHello?.({
      type: "hello-ok",
      protocol: 1,
      auth: {
        role: "operator",
        scopes: [],
        method: "token",
        recoveryScope: "main-device",
      },
      snapshot: { authMode: "token" },
    });
    const writes = vi.spyOn(localStorage, "removeItem");
    const peer = open("/activity?view=run&run=synthetic#bootstrapToken=synthetic-fresh-handoff");
    expect(peer.runtime.warmBoot).toBe(false);
    if (outcome === "rejected") {
      peer.opts.onClose?.({
        code: 4008,
        reason: "rejected",
        willRetry: false,
        error: { code: "PAIRING_REQUIRED", message: "Rejected synthetic handoff" },
      });
    } else {
      peer.opts.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: [],
          method: "bootstrap-token",
          deviceToken: "test-token",
          recoveryScope: "main-device",
        },
      });
      await peer.runtime.context.agents.ensureList();
      await peer.runtime.context.sessions.groupsLoad();
      window.dispatchEvent(new Event("pagehide"));
    }
    expect(writes.mock.calls.filter(([removed]) => removed === key)).toEqual([]);
    expect(chat.runtime.context.gateway.snapshot.phase).toBe("connected");
    expect(chat.runtime.warmBoot).toBe(true);
    const stored = JSON.parse(localStorage.getItem(key)!);
    expect(stored.recoveryScope).toBe("main-device");
    if (outcome === "accepted") {
      expect(stored.authMethod).toBe("device-token");
      expect(stored.credential).toBe("9d17676d");
      expect(JSON.stringify(stored)).not.toContain("synthetic-fresh-handoff");
    }
  },
);

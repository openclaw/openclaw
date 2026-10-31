import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as browserGateway from "../api/gateway.ts";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords } from "./boot-record.ts";
import { makeBootRecord } from "./bootstrap.test-support.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { captureGatewayClients } from "./gateway-store.test-support.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

const originalUrl = window.location.href;
const runtimes: ApplicationRuntime[] = [];
let connections: GatewayBrowserClientOptions[];
let key: string;
let bytes: string;
const mainRecord = () =>
  makeBootRecord(gatewayCredentialScope(loadSettings().gatewayUrl), {
    recoveryScope: "main-device",
    profileId: "same-profile",
    groups: [{ name: "Main private group", position: 0 }],
    sectionOrder: ["Main private group"],
  });
const replies = new Map<string, () => unknown>([
  ["agents.list", () => mainRecord().agents],
  ["sessions.groups.list", () => ({ groups: [], sectionOrder: [] })],
  ["sessions.groups.defaults", () => ({ defaults: {} })],
]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  persistSessionToken(loadSettings().gatewayUrl, "test-token");
  const record = mainRecord();
  key = "openclaw.control.bootRecord.v1:" + record.scope;
  bytes = JSON.stringify(record);
  localStorage.setItem(key, bytes);
  connections = [];
  const NativeClient = browserGateway.GatewayBrowserClient;
  vi.spyOn(NativeClient.prototype, "start").mockImplementation(() => {});
  vi.spyOn(NativeClient.prototype, "request").mockImplementation(
    async (method) => replies.get(method)?.() ?? {},
  );
  captureGatewayClients((_client, options) => connections.push(options));
});
afterEach(async () => {
  runtimes.splice(0).forEach((runtime) => runtime.stop());
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
  return { runtime, opts: connections.at(-1)! };
}

type HelloSnapshot = Parameters<NonNullable<GatewayBrowserClientOptions["onHello"]>>[0]["snapshot"];
function admit(
  opts: GatewayBrowserClientOptions,
  recoveryScope: string,
  deviceToken?: string,
  snapshot?: HelloSnapshot,
) {
  opts.onHello?.({
    type: "hello-ok",
    protocol: 1,
    auth: {
      role: "operator",
      scopes: [],
      recoveryScope,
      method: deviceToken ? "bootstrap-token" : "token",
      ...(deviceToken ? { deviceToken } : {}),
    },
    ...(snapshot ? { snapshot } : {}),
  });
}

function reject(opts: GatewayBrowserClientOptions, message: string) {
  opts.onClose?.({
    code: 4008,
    reason: "rejected",
    willRetry: false,
    error: { code: "PAIRING_REQUIRED", message },
  });
}

it.each(["pagehide", "hidden"])(
  "preserves a peer's sidebar profile while self discovery is pending at %s",
  async (boundary) => {
    const self = createDeferred<unknown>();
    replies.set("users.self", () => self.promise);
    try {
      const { runtime, opts } = open("/chat/main");
      opts.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.read"],
          method: "token",
          recoveryScope: "main-device",
        },
        snapshot: { authMode: "token", presence: [] },
      });
      await runtime.context.agents.ensureList();
      await runtime.context.sessions.groupsLoad();
      expect(runtime.context.gateway.snapshot.selfUser).toBeUndefined();
      if (boundary === "pagehide") {
        window.dispatchEvent(new Event("pagehide"));
      } else {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      expect(localStorage.getItem(key)).toBe(bytes);

      const loaded = runtime.context.gateway.loadSelfProfile();
      self.resolve({
        profile: {
          id: "same-profile",
          displayName: "Riley",
          emails: [],
          avatarMime: null,
          hasAvatar: false,
          githubIdentity: null,
          mergedInto: null,
          createdAt: 1,
          updatedAt: 2,
        },
      });
      await loaded;
      window.dispatchEvent(new Event("pagehide"));
      expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
        recoveryScope: "main-device",
        profileId: "same-profile",
        groups: [],
      });
    } finally {
      self.resolve({});
      replies.delete("users.self");
    }
  },
);

it.each(["/focus/terminal", "/approve/exec%3A1", "/ask/question-1"])(
  "keeps shellless %s out of main admission reads, publication, and retirement",
  async (route) => {
    const reads = vi.spyOn(localStorage, "getItem");
    const { runtime, opts } = open(route + "#bootstrapToken=synthetic-independent-handoff");
    expect(reads.mock.calls.filter(([readKey]) => readKey === key)).toEqual([]);
    expect(runtime.warmBoot).toBe(false);
    expect(opts.offlineRecoveryScope).toBeUndefined();
    expect(runtime.context.sessions.state.groupSettings).toEqual([]);
    admit(opts, "independent-device", "independent-device-grant", {
      presence: [{ ts: 0, instanceId: opts.instanceId, user: { id: "same-profile" } }],
    });
    await runtime.context.agents.ensureList();
    await runtime.context.sessions.groupsLoad();
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(key)).toBe(bytes);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue: bytes, newValue: null }));
    expect(runtime.context.gateway.snapshot.phase).toBe("connected");
    runtime.context.gateway.connect({ password: "independent-password" });
    reject(connections.at(-1)!, "Independent rejection");
    expect(localStorage.getItem(key)).toBe(bytes);
  },
);

it.each(["accepted", "rejected"])(
  "keeps an admitted Chat beside a fresh %s bootstrap document",
  async (outcome) => {
    const chat = open("/chat/main");
    admit(chat.opts, "main-device", undefined, { authMode: "token" });
    const writes = vi.spyOn(localStorage, "removeItem");
    const peer = open("/activity?view=run&run=synthetic#bootstrapToken=synthetic-fresh-handoff");
    expect(peer.runtime.warmBoot).toBe(false);
    if (outcome === "rejected") {
      reject(peer.opts, "Rejected synthetic handoff");
    } else {
      admit(peer.opts, "main-device", "test-token");
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
      expect(stored).toMatchObject({ authMethod: "device-token", credential: "9d17676d" });
      expect(JSON.stringify(stored)).not.toContain("synthetic-fresh-handoff");
    }
  },
);

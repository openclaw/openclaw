/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  clearBootRecords,
  persistBootRecord,
  subscribeBootRecordChanges,
  type BootRecord,
} from "./boot-record.ts";
import { subscribeWarmBootConnection } from "./bootstrap-warm-boot.ts";
import { makeBootRecord } from "./bootstrap.test-support.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";

let connection: ReturnType<typeof createGatewayStoreTestStore> | undefined;
const disposers: Array<() => void> = [];
function createConnection() {
  connection = createGatewayStoreTestStore();
  const scope = gatewayCredentialScope(connection.gateway.connection.gatewayUrl);
  return {
    ...connection,
    scope,
    key: "openclaw.control.bootRecord.v1:" + scope,
    rejected: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  connection?.gateway.stop();
  connection = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const record = (scope: string, recoveryScope = "account-a") =>
  makeBootRecord(scope, { authMethod: "trusted-proxy", credential: "", recoveryScope });

function storageChange(key: string | null, oldRecord: BootRecord | null, next: BootRecord | null) {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      oldValue: oldRecord ? JSON.stringify(oldRecord) : null,
      newValue: next ? JSON.stringify(next) : null,
    }),
  );
}
function hello(source: ReturnType<ReturnType<typeof createGatewayStoreTestStore>["current"]>) {
  source.opts.onHello?.({
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [], method: "trusted-proxy", recoveryScope: "account-a" },
    snapshot: { presence: [{ ts: 0, instanceId: source.instanceId, user: { id: "profile-a" } }] },
  });
}

it.each([
  { name: "first save", next: "account-a" },
  { name: "refresh", previous: "account-a", next: "account-a" },
  { name: "new profile", previous: "account-a", next: "account-a", profileId: "profile-b" },
  { name: "different account", previous: "account-a", next: "account-b", retires: true },
  { name: "removal", previous: "account-a", retires: true },
  { name: "other owner removal", previous: "account-b", pending: true },
  { name: "site clear", clearAll: true, pending: true, retires: true },
  {
    name: "pending new profile",
    previous: "account-a",
    next: "account-a",
    profileId: "profile-b",
    pending: true,
  },
  { name: "cold save", next: "account-a", cold: true },
  { name: "cold remove", previous: "account-a", cold: true },
  { name: "cold clear", clearAll: true, cold: true },
] satisfies Array<{
  name: string;
  previous?: string;
  next?: string;
  profileId?: string;
  retires?: boolean;
  pending?: boolean;
  clearAll?: boolean;
  cold?: boolean;
}>)(
  "scopes peer $name to the admitted owner",
  ({ previous, next, profileId, retires, pending, clearAll, cold }) => {
    const { gateway, current, scope, key, rejected } = createConnection();
    gateway.connect();
    if (!cold) {
      hello(current());
    }
    disposers.push(subscribeWarmBootConnection(gateway, null, rejected));
    const saved = record(scope);
    const replacement = next
      ? { ...record(scope, next), profileId: profileId ?? "profile-a" }
      : null;
    if (pending) {
      persistBootRecord(saved);
      if (replacement) {
        localStorage.setItem(key, JSON.stringify(replacement));
      }
    }
    storageChange(clearAll ? null : key, previous ? record(scope, previous) : null, replacement);
    expect(gateway.snapshot.phase).toBe(retires ? "stopped" : cold ? "connecting" : "connected");
    expect(rejected).toHaveBeenCalledTimes(retires ? 1 : 0);
    if (cold) {
      expect(gateway.snapshot.hello).toBeNull();
    }
    if (pending) {
      window.dispatchEvent(new Event("pagehide"));
      const stored = localStorage.getItem(key);
      expect(stored && JSON.parse(stored)).toEqual(retires ? null : saved);
    }
  },
);

it.each(["local", "external"])(
  "isolates a throwing %s retirement observer without keeping boot access",
  (source) => {
    const scope = "ws://test.invalid";
    const key = "openclaw.control.bootRecord.v1:" + scope;
    localStorage.setItem(key, JSON.stringify(record(scope)));
    persistBootRecord(record(scope));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    disposers.push(
      subscribeBootRecordChanges(() => {
        throw new Error("synthetic observer failure");
      }),
    );
    const observed = vi.fn();
    disposers.push(subscribeBootRecordChanges(observed));
    if (source === "local") {
      expect(() => clearBootRecords(scope)).not.toThrow();
    } else {
      localStorage.removeItem(key);
      storageChange(key, record(scope), null);
    }
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(key)).toBeNull();
    expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope }));
    expect(error).toHaveBeenCalledOnce();
  },
);
it.each(["unreplaced", "local replacement", "peer replacement"])(
  "tracks captured legacy admission after hello until %s",
  (publication) => {
    const { gateway, current, scope, key, rejected } = createConnection();
    const legacy: BootRecord = {
      ...record(scope),
      recoveryScope: undefined,
      authMethod: "token",
      credential: "legacy-fingerprint",
    };
    localStorage.setItem(key, JSON.stringify(legacy));
    disposers.push(subscribeWarmBootConnection(gateway, legacy, rejected));
    gateway.connect();
    hello(current());
    const next = record(scope);
    if (publication === "peer replacement") {
      localStorage.setItem(key, JSON.stringify(next));
      storageChange(key, legacy, next);
    } else {
      persistBootRecord(next);
      if (publication === "local replacement") {
        window.dispatchEvent(new Event("pagehide"));
      }
    }
    storageChange(key, { ...legacy, credential: "foreign-fingerprint" }, null);
    expect(gateway.snapshot.phase).toBe("connected");
    expect(rejected).not.toHaveBeenCalled();
    storageChange(key, legacy, null);
    const retired = publication === "unreplaced";
    expect(gateway.snapshot.phase).toBe(retired ? "stopped" : "connected");
    expect(rejected).toHaveBeenCalledTimes(retired ? 1 : 0);
    if (retired) {
      localStorage.removeItem(key);
      window.dispatchEvent(new Event("pagehide"));
      expect(localStorage.getItem(key)).toBeNull();
    } else {
      storageChange(key, record(scope), null);
      expect(gateway.snapshot.phase).toBe("stopped");
      expect(rejected).toHaveBeenCalledOnce();
    }
  },
);

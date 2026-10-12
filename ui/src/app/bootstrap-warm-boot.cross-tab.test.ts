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
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const record = (scope: string, recoveryScope = "account-a"): BootRecord => ({
  version: 2,
  authMethod: "trusted-proxy",
  credential: "",
  recoveryScope,
  scope,
  savedAt: Date.now(),
  profileId: "profile-a",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [],
  sectionOrder: [],
});

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
    const { gateway, current } = createGatewayStoreTestStore();
    gateway.connect();
    const source = current();
    if (!cold) {
      source.opts.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: [], method: "trusted-proxy", recoveryScope: "account-a" },
        snapshot: { presence: [{ instanceId: source.instanceId, user: { id: "profile-a" } }] },
      });
    }
    const rejected = vi.fn();
    const stop = subscribeWarmBootConnection(gateway, null, rejected);
    const scope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    const key = "openclaw.control.bootRecord.v1:" + scope;
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
    try {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: clearAll ? null : key,
          oldValue: previous ? JSON.stringify(record(scope, previous)) : null,
          newValue: replacement ? JSON.stringify(replacement) : null,
        }),
      );
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
    } finally {
      stop();
      gateway.stop();
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
    const failed = subscribeBootRecordChanges(() => {
      throw new Error("synthetic observer failure");
    });
    const observed = vi.fn();
    const stop = subscribeBootRecordChanges(observed);
    try {
      if (source === "local") {
        expect(() => clearBootRecords(scope)).not.toThrow();
      } else {
        localStorage.removeItem(key);
        window.dispatchEvent(
          new StorageEvent("storage", {
            key,
            oldValue: JSON.stringify(record(scope)),
            newValue: null,
          }),
        );
      }
      window.dispatchEvent(new Event("pagehide"));
      expect(localStorage.getItem(key)).toBeNull();
      expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope }));
      expect(error).toHaveBeenCalledOnce();
    } finally {
      failed();
      stop();
    }
  },
);
it.each(["unreplaced", "local replacement", "peer replacement"])(
  "tracks captured legacy admission after hello until %s",
  (publication) => {
    const { gateway, current } = createGatewayStoreTestStore();
    const scope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    const legacy: BootRecord = {
      ...record(scope),
      recoveryScope: undefined,
      authMethod: "token",
      credential: "legacy-fingerprint",
    };
    const key = "openclaw.control.bootRecord.v1:" + scope;
    localStorage.setItem(key, JSON.stringify(legacy));
    const rejected = vi.fn();
    const stop = subscribeWarmBootConnection(gateway, legacy, rejected);
    try {
      gateway.connect();
      const source = current();
      source.opts.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: [], method: "trusted-proxy", recoveryScope: "account-a" },
        snapshot: { presence: [{ instanceId: source.instanceId, user: { id: "profile-a" } }] },
      });
      if (publication === "unreplaced") {
        persistBootRecord(record(scope));
      }
      if (publication !== "unreplaced") {
        const next = record(scope);
        if (publication === "local replacement") {
          persistBootRecord(next);
          window.dispatchEvent(new Event("pagehide"));
        } else {
          localStorage.setItem(key, JSON.stringify(next));
          window.dispatchEvent(
            new StorageEvent("storage", {
              key,
              oldValue: JSON.stringify(legacy),
              newValue: JSON.stringify(next),
            }),
          );
        }
      }
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          oldValue: JSON.stringify({ ...legacy, credential: "foreign-fingerprint" }),
          newValue: null,
        }),
      );
      expect(gateway.snapshot.phase).toBe("connected");
      expect(rejected).not.toHaveBeenCalled();
      window.dispatchEvent(
        new StorageEvent("storage", { key, oldValue: JSON.stringify(legacy), newValue: null }),
      );
      const retired = publication === "unreplaced";
      expect(gateway.snapshot.phase).toBe(retired ? "stopped" : "connected");
      expect(rejected).toHaveBeenCalledTimes(retired ? 1 : 0);
      if (retired) {
        localStorage.removeItem(key);
        window.dispatchEvent(new Event("pagehide"));
        expect(localStorage.getItem(key)).toBeNull();
      }
      if (!retired) {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key,
            oldValue: JSON.stringify(record(scope)),
            newValue: null,
          }),
        );
        expect(gateway.snapshot.phase).toBe("stopped");
        expect(rejected).toHaveBeenCalledOnce();
      }
    } finally {
      stop();
      gateway.stop();
    }
  },
);

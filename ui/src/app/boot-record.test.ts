/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  clearBootRecords,
  persistBootRecord,
  readBootRecord,
  resolveBootRecordAuth,
  subscribeBootRecordChanges,
  type BootRecord,
} from "./boot-record.ts";
import { subscribeWarmBootConnection } from "./bootstrap-warm-boot.ts";
import { makeBootRecord } from "./bootstrap.test-support.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";

const credential = () => "test-token";
const recordScope = "https://gateway.example";
const recordKey = `openclaw.control.bootRecord.v1:${recordScope}`;
const record = (overrides: Partial<BootRecord> = {}) =>
  makeBootRecord(recordScope, {
    groups: [{ name: "Work", position: 0 }],
    sectionOrder: ["category:Work", "ungrouped"],
    ...overrides,
  });

const settleWrite = () => vi.advanceTimersByTimeAsync(500);

async function write(saved = record()): Promise<void> {
  persistBootRecord(saved);
  await settleWrite();
}

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

const accountRecord = (scope: string, recoveryScope = "account-a") =>
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
  source.testOptions.onHello?.({
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [], method: "trusted-proxy", recoveryScope: "account-a" },
    snapshot: { presence: [{ ts: 0, instanceId: source.instanceId, user: { id: "profile-a" } }] },
  });
}

describe("Control UI boot record", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
  });
  afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose());
    connection?.gateway.stop();
    connection = undefined;
    clearBootRecords();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["debounce", "pagehide", "hidden"])(
    "flushes the latest pending record on %s",
    async (event) => {
      persistBootRecord(record());
      const saved = record({ sectionOrder: ["ungrouped", "category:Work"] });
      saved.agents.agents = [
        { id: "main", identity: { name: "Main", avatar: "private", avatarUrl: "/avatar" } },
      ];
      persistBootRecord(saved);
      expect(readBootRecord(recordScope, credential)).toBeNull();

      if (event === "debounce") {
        await settleWrite();
      } else if (event === "pagehide") {
        window.dispatchEvent(new Event("pagehide"));
      } else {
        const visibility = vi.spyOn(document, "visibilityState", "get");
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        expect(readBootRecord(recordScope, credential)).toBeNull();
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }

      expect(readBootRecord(recordScope, credential)).toEqual({
        ...saved,
        agents: { ...saved.agents, agents: [{ id: "main", identity: { name: "Main" } }] },
      });
      expect(readBootRecord("https://another.example", credential)).toBeNull();
    },
  );

  it.each([
    ["invalid JSON", "{"],
    ["version-1 record", { ...record(), version: 1 }],
    ["missing method", { ...record(), authMethod: undefined }],
    ["proxy method", { ...record(), authMethod: "trusted-proxy" }],
    ["missing fingerprint", { ...record(), credential: undefined }],
    ["wrong scope", { ...record(), scope: "https://another.example" }],
    ["invalid agent roster", { ...record(), agents: { defaultId: 42 } }],
    ["invalid group", { ...record(), groups: [{ name: "Work", position: "first" }] }],
    ["old record", { ...record(), savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 - 1 }],
    ["oversized record", { ...record(), sectionOrder: ["x".repeat(64 * 1024)] }],
  ])("removes %s without blocking startup", (_name, value) => {
    localStorage.setItem(recordKey, typeof value === "string" ? value : JSON.stringify(value));
    expect(readBootRecord(recordScope, credential)).toBeNull();
    expect(localStorage.getItem(recordKey)).toBeNull();
  });

  it("binds boot admission to the accepted reusable credential", () => {
    const cases = [
      ["password", "test-token", "test-token", null],
      [undefined, "test-token", "test-token", null],
      ["token", "other-token", " test-token ", "token"],
      ["device-token", "test-token", "rejected-token", "device-token"],
      ["token", "test-token", "", null],
      ["device-token", undefined, "test-token", null],
      ["bootstrap-token", "test-token", "bootstrap-secret", "device-token"],
      ["bootstrap-token", undefined, "bootstrap-secret", null],
    ] as const;
    for (const [method, deviceToken, token, authMethod] of cases) {
      expect(resolveBootRecordAuth({ method, deviceToken }, token), method).toEqual(
        authMethod ? { authMethod, credential: "9d17676d" } : null,
      );
    }
  });

  it.each([
    ["oversized", true],
    ["oversized", false],
    ["quota", false],
  ] as const)(
    "evicts only the publishing owner after %s failure (same owner: %s)",
    async (failure, sameOwner) => {
      const peer = record(sameOwner ? {} : { recoveryScope: "peer-account" });
      await write(peer);
      const bytes = localStorage.getItem(recordKey);
      expect(readBootRecord(recordScope, credential)).toEqual(peer);
      if (failure === "quota") {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        });
      }
      await write(
        record({
          ...(sameOwner ? {} : { recoveryScope: "new-account" }),
          ...(failure === "oversized" ? { sectionOrder: ["🦞".repeat((64 * 1024) / 3)] } : {}),
        }),
      );
      expect(localStorage.getItem(recordKey)).toBe(sameOwner ? null : bytes);
      expect(readBootRecord(recordScope, credential)).toEqual(sameOwner ? null : peer);
    },
  );

  it("clears all scopes and fences pending writes even on pagehide", async () => {
    await write();
    await write(record({ scope: "https://another.example" }));
    localStorage.setItem("unrelated", "keep");
    persistBootRecord(record());
    clearBootRecords();
    window.dispatchEvent(new Event("pagehide"));
    await settleWrite();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("tolerates unavailable storage", async () => {
    vi.stubGlobal("localStorage", null);
    await write();
    expect(readBootRecord(recordScope, credential)).toBeNull();
    expect(clearBootRecords).not.toThrow();
  });
  it.each(["trusted-proxy", "tailscale", "password"])(
    "retains %s storage identity without a credential",
    async (method) => {
      const auth = resolveBootRecordAuth({ method, recoveryScope: "account-a" });
      expect(auth).toEqual({ authMethod: method, credential: "" });
      await write(record({ ...auth!, recoveryScope: "account-a" }));
      expect(readBootRecord(recordScope, () => "")?.recoveryScope).toBe("account-a");
      clearBootRecords(recordScope);
      window.dispatchEvent(new Event("pagehide"));
      expect(readBootRecord(recordScope, () => "")).toBeNull();
    },
  );
  it.each([
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
      const saved = accountRecord(scope);
      const replacement = next
        ? { ...accountRecord(scope, next), profileId: profileId ?? "profile-a" }
        : null;
      if (pending) {
        persistBootRecord(saved);
        if (replacement) {
          localStorage.setItem(key, JSON.stringify(replacement));
        }
      }
      storageChange(
        clearAll ? null : key,
        previous ? accountRecord(scope, previous) : null,
        replacement,
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
    },
  );

  it.each(["local", "external"])(
    "isolates a throwing %s retirement observer without keeping boot access",
    (source) => {
      const scope = "ws://test.invalid";
      const key = "openclaw.control.bootRecord.v1:" + scope;
      localStorage.setItem(key, JSON.stringify(accountRecord(scope)));
      persistBootRecord(accountRecord(scope));
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
        storageChange(key, accountRecord(scope), null);
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
        ...accountRecord(scope),
        recoveryScope: undefined,
        authMethod: "token",
        credential: "legacy-fingerprint",
      };
      localStorage.setItem(key, JSON.stringify(legacy));
      disposers.push(subscribeWarmBootConnection(gateway, legacy, rejected));
      gateway.connect();
      hello(current());
      const next = accountRecord(scope);
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
        storageChange(key, accountRecord(scope), null);
        expect(gateway.snapshot.phase).toBe("stopped");
        expect(rejected).toHaveBeenCalledOnce();
      }
    },
  );
});

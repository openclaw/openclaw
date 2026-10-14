import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  clearBootRecords,
  persistBootRecord,
  readBootRecord,
  resolveBootRecordAuth,
  type BootRecord,
} from "./boot-record.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

const credential = () => "test-token";
const scope = "https://gateway.example";
const record = (): BootRecord => ({
  version: 2,
  authMethod: "token",
  credential: "9d17676d",
  scope,
  savedAt: Date.now(),
  profileId: "profile-a",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [{ name: "Work", position: 0 }],
  sectionOrder: ["category:Work", "ungrouped"],
});

async function settleWrite(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

describe("Control UI boot record", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    clearBootRecords();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["debounce", "pagehide", "hidden"])(
    "flushes the latest pending record on %s",
    async (event) => {
      persistBootRecord(record());
      const saved = { ...record(), sectionOrder: ["ungrouped", "category:Work"] };
      saved.agents.agents = [
        { id: "main", identity: { name: "Main", avatar: "private", avatarUrl: "/avatar" } },
      ];
      persistBootRecord(saved);
      expect(readBootRecord(scope, credential)).toBeNull();

      if (event === "debounce") {
        await settleWrite();
      } else if (event === "pagehide") {
        window.dispatchEvent(new Event("pagehide"));
      } else {
        const visibility = vi.spyOn(document, "visibilityState", "get");
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        expect(readBootRecord(scope, credential)).toBeNull();
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }

      expect(readBootRecord(scope, credential)).toEqual({
        ...saved,
        agents: { ...saved.agents, agents: [{ id: "main", identity: { name: "Main" } }] },
      });
      expect(readBootRecord("https://another.example", credential)).toBeNull();
      clearBootRecords();
      await vi.advanceTimersByTimeAsync(500);
      expect(readBootRecord(scope, credential)).toBeNull();
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
    const key = BOOT_RECORD_PREFIX + scope;
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    expect(readBootRecord(scope, credential)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it.each([undefined, null, "", "changed-token"])(
    "rejects without deleting another document’s record when the credential is %s",
    async (current) => {
      const saved = record();
      persistBootRecord(saved);
      await settleWrite();
      expect(readBootRecord(scope, () => current)).toBeNull();
      expect(readBootRecord(scope, credential)).toEqual(saved);
    },
  );

  it.each(["token", "device-token"])(
    "compares the credential for the recorded %s method",
    async (authMethod) => {
      persistBootRecord({ ...record(), authMethod });
      await settleWrite();
      const current = vi.fn((method: string) =>
        method === authMethod ? "test-token" : "other-token",
      );
      expect(readBootRecord(scope, current)?.authMethod).toBe(authMethod);
      expect(current).toHaveBeenCalledExactlyOnceWith(authMethod);
    },
  );

  it("binds boot admission to the accepted reusable credential", () => {
    const cases: Array<
      [
        method: string | undefined,
        deviceToken: string | undefined,
        token: string,
        authMethod: string | null,
      ]
    > = [
      ["password", "test-token", "test-token", null],
      [undefined, "test-token", "test-token", null],
      ["token", "other-token", " test-token ", "token"],
      ["device-token", "test-token", "rejected-token", "device-token"],
      ["token", "test-token", "", null],
      ["device-token", undefined, "test-token", null],
      ["bootstrap-token", "test-token", "bootstrap-secret", "device-token"],
      ["bootstrap-token", undefined, "bootstrap-secret", null],
    ];
    for (const [method, deviceToken, token, authMethod] of cases) {
      expect(resolveBootRecordAuth({ method, deviceToken }, token), method).toEqual(
        authMethod ? { authMethod, credential: "9d17676d" } : null,
      );
    }
  });

  it.each([
    { failure: "oversized", sameOwner: true },
    { failure: "oversized", sameOwner: false },
    { failure: "quota", sameOwner: false },
  ])(
    "evicts only the publishing owner after $failure failure (same owner: $sameOwner)",
    async ({ failure, sameOwner }) => {
      const peer = { ...record(), ...(sameOwner ? {} : { recoveryScope: "peer-account" }) };
      persistBootRecord(peer);
      await settleWrite();
      const key = BOOT_RECORD_PREFIX + scope;
      const bytes = localStorage.getItem(key);
      expect(readBootRecord(scope, credential)).toEqual(peer);
      if (failure === "quota") {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        });
      }
      persistBootRecord({
        ...record(),
        ...(sameOwner ? {} : { recoveryScope: "new-account" }),
        ...(failure === "oversized" ? { sectionOrder: ["🦞".repeat((64 * 1024) / 3)] } : {}),
      });
      await settleWrite();
      expect(localStorage.getItem(key)).toBe(sameOwner ? null : bytes);
      expect(readBootRecord(scope, credential)).toEqual(sameOwner ? null : peer);
    },
  );

  it("clears all scopes and fences pending writes even on pagehide", async () => {
    persistBootRecord(record());
    await settleWrite();
    persistBootRecord({ ...record(), scope: "https://another.example" });
    await settleWrite();
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
    persistBootRecord(record());
    await settleWrite();
    expect(readBootRecord(scope, credential)).toBeNull();
    expect(clearBootRecords).not.toThrow();
  });
  it.each(["trusted-proxy", "tailscale", "password"])(
    "retains %s storage identity without a credential",
    async (method) => {
      const auth = resolveBootRecordAuth({ method, recoveryScope: "account-a" });
      expect(auth).toEqual({ authMethod: method, credential: "" });
      persistBootRecord({ ...record(), ...auth!, recoveryScope: "account-a" });
      await settleWrite();
      expect(readBootRecord(scope, () => "")?.recoveryScope).toBe("account-a");
      clearBootRecords(scope);
      window.dispatchEvent(new Event("pagehide"));
      expect(readBootRecord(scope, () => "")).toBeNull();
    },
  );
  it("retires an admitted legacy credential without deleting a replacement account", () => {
    const saved = record();
    const key = BOOT_RECORD_PREFIX + scope;
    localStorage.setItem(key, JSON.stringify(saved));
    const owner = { authMethod: saved.authMethod, credential: saved.credential };
    clearBootRecords(scope, owner);
    expect(localStorage.getItem(key)).toBeNull();
    const replacement = { ...saved, recoveryScope: "replacement-account" };
    localStorage.setItem(key, JSON.stringify(replacement));
    clearBootRecords(scope, owner);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(replacement);
    localStorage.removeItem(key);
  });
});

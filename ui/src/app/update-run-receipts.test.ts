// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunReceipts } from "./update-run-receipts.ts";

const ACKNOWLEDGED_KEY = "openclaw:control-ui:update-acknowledged:v1";
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("update result acknowledgments", () => {
  it("retains result dismissal across reload while scoping it to Gateway, profile, and run", () => {
    const receipts = createUpdateRunReceipts();
    expect(receipts.acknowledge("ws://gateway.test", "operator", "run-1")).toBe(true);
    const reloaded = createUpdateRunReceipts();
    expect(reloaded.acknowledged("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(reloaded.acknowledged("ws://other.test", "operator", "run-1")).toBe(false);
    expect(reloaded.acknowledged("ws://gateway.test", "other", "run-1")).toBe(false);
    expect(reloaded.acknowledged("ws://gateway.test", "operator", "run-2")).toBe(false);
  });

  it.each([
    "unavailable",
    "read denied",
    "quota exceeded",
    "invalid receipts",
    "oversized history",
  ])("preserves stored acknowledgments when storage is %s", (failure) => {
    const storage = createStorageMock();
    storage.setItem(
      ACKNOWLEDGED_KEY,
      JSON.stringify([JSON.stringify(["ws://gateway.test", null, "previous"])]),
    );
    if (failure === "invalid receipts") {
      storage.setItem(ACKNOWLEDGED_KEY, JSON.stringify([42]));
    }
    if (failure === "oversized history") {
      storage.setItem(ACKNOWLEDGED_KEY, "x".repeat(32_768));
    }
    const previous = storage.getItem(ACKNOWLEDGED_KEY);
    if (failure === "read denied") {
      vi.spyOn(storage, "getItem").mockImplementation(() => {
        throw new Error("Access denied");
      });
    }
    if (failure === "quota exceeded") {
      vi.spyOn(storage, "setItem").mockImplementation(() => {
        throw new Error("Quota exceeded");
      });
    }
    vi.stubGlobal("localStorage", failure === "unavailable" ? undefined : storage);
    const receipts = createUpdateRunReceipts();
    expect(receipts.acknowledge("ws://gateway.test", null, "new-failure")).toBe(false);
    expect(receipts.acknowledged("ws://gateway.test", null, "new-failure")).toBe(false);
    vi.restoreAllMocks();
    expect(storage.getItem(ACKNOWLEDGED_KEY)).toBe(previous);
  });

  it("bounds retained dismissals while preserving the newest results", () => {
    const receipts = createUpdateRunReceipts();
    for (let index = 0; index <= 32; index++) {
      expect(receipts.acknowledge("ws://gateway.test", null, String(index))).toBe(true);
    }
    const reloaded = createUpdateRunReceipts();
    expect(reloaded.acknowledged("ws://gateway.test", null, "0")).toBe(false);
    expect(reloaded.acknowledged("ws://gateway.test", null, "1")).toBe(true);
    expect(reloaded.acknowledged("ws://gateway.test", null, "32")).toBe(true);
  });
});

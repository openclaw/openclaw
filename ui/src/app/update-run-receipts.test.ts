// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunReceipts } from "./update-run-receipts.ts";

const TRIAGED_KEY = "openclaw:control-ui:update:v1";
const OPT_OUT_KEY = "openclaw:control-ui:update-triage-opt-out:v1";
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => vi.unstubAllGlobals());

describe("update browser receipts", () => {
  it("keeps explicit browser opt-out separate from acknowledgements and tab investigations", () => {
    const receipts = createUpdateRunReceipts();
    receipts.acknowledge("ws://gateway.test", "operator", "acknowledged");
    receipts.recordTriage("ws://gateway.test", "operator", "investigated");
    expect(receipts.triageOptOut("ws://gateway.test", "operator", "acknowledged")).toBe(false);
    expect(receipts.triageOptOut("ws://gateway.test", "operator", "investigated")).toBe(false);
    expect(receipts.recordTriageOptOut("ws://gateway.test", "operator", "declined")).toBe(true);
    expect(receipts.acknowledged("ws://gateway.test", "operator", "declined")).toBe(false);
    expect(receipts.triaged("ws://gateway.test", "operator", "declined")).toBe(false);
    sessionStorage.clear();
    const nextTab = createUpdateRunReceipts();
    expect(nextTab.triageOptOut("ws://gateway.test", "operator", "declined")).toBe(true);
    expect(nextTab.triageOptOut("ws://other.test", "operator", "declined")).toBe(false);
    expect(nextTab.triageOptOut("ws://gateway.test", "other", "declined")).toBe(false);
    expect(nextTab.triageOptOut("ws://gateway.test", "operator", "new-run")).toBe(false);
    expect(nextTab.recordTriageOptOut("ws://gateway.test", "operator", "another")).toBe(true);
    expect(receipts.triageOptOut("ws://gateway.test", "operator", "another")).toBe(true);
  });

  it("retains at most 32 browser opt-outs without clearing investigated history", () => {
    const receipts = createUpdateRunReceipts();
    receipts.recordTriage("ws://gateway.test", null, "investigated");
    const previous = sessionStorage.getItem(TRIAGED_KEY);
    for (let index = 0; index <= 32; index++) {
      expect(receipts.recordTriageOptOut("ws://gateway.test", null, String(index))).toBe(true);
    }
    expect(receipts.triageOptOut("ws://gateway.test", null, "0")).toBe(false);
    expect(receipts.triageOptOut("ws://gateway.test", null, "1")).toBe(true);
    expect(receipts.triageOptOut("ws://gateway.test", null, "32")).toBe(true);
    expect(sessionStorage.getItem(TRIAGED_KEY)).toBe(previous);
  });

  it.each(["unavailable", "read denied", "malformed", "oversized"])(
    "does not treat %s browser opt-out history as permission to investigate",
    (failure) => {
      const local = createStorageMock();
      if (failure === "malformed" || failure === "oversized") {
        local.setItem(OPT_OUT_KEY, failure === "malformed" ? "[42]" : "x".repeat(32_768));
      }
      if (failure === "read denied") {
        vi.spyOn(local, "getItem").mockImplementation(() => {
          throw new Error("Access denied");
        });
      }
      vi.stubGlobal("localStorage", failure === "unavailable" ? undefined : local);
      const receipts = createUpdateRunReceipts();
      expect(receipts.triageOptOut("ws://gateway.test", null, "run")).toBeNull();
      expect(receipts.recordTriageOptOut("ws://gateway.test", null, "run")).toBe(false);
      expect(sessionStorage.getItem(TRIAGED_KEY)).toBeNull();
    },
  );

  it("keeps result dismissal separate from automatic triage and scoped to Gateway and profile", () => {
    const receipts = createUpdateRunReceipts();
    expect(receipts.acknowledge("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(receipts.triaged("ws://gateway.test", "operator", "run-1")).toBe(false);
    expect(receipts.recordTriage("ws://gateway.test", "operator", "run-1")).toBe(true);
    const reloaded = createUpdateRunReceipts();
    expect(reloaded.acknowledged("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(reloaded.triaged("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(reloaded.acknowledged("ws://other.test", "operator", "run-1")).toBe(false);
    expect(reloaded.triaged("ws://gateway.test", "other", "run-1")).toBe(false);
    sessionStorage.clear();
    const nextTab = createUpdateRunReceipts();
    expect(nextTab.acknowledged("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(nextTab.triaged("ws://gateway.test", "operator", "run-1")).toBe(false);
  });

  it.each([
    "unavailable",
    "read denied",
    "quota exceeded",
    "invalid receipts",
    "oversized history",
  ])("does not admit automatic triage or overwrite history when storage is %s", (failure) => {
    const storage = createStorageMock();
    storage.setItem(
      TRIAGED_KEY,
      JSON.stringify({ triaged: [JSON.stringify(["ws://gateway.test", null, "previous"])] }),
    );
    if (failure === "invalid receipts") {
      storage.setItem(TRIAGED_KEY, JSON.stringify({ triaged: false }));
    }
    if (failure === "oversized history") {
      storage.setItem(TRIAGED_KEY, "x".repeat(150_000));
    }
    const previous = storage.getItem(TRIAGED_KEY);
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
    vi.stubGlobal("sessionStorage", failure === "unavailable" ? undefined : storage);
    const receipts = createUpdateRunReceipts();
    expect(receipts.recordTriage("ws://gateway.test", null, "new-failure")).toBe(false);
    expect(receipts.triaged("ws://gateway.test", null, "new-failure")).toBe(false);
    vi.restoreAllMocks();
    expect(storage.getItem(TRIAGED_KEY)).toBe(previous);
  });

  it("bounds retained receipts while keeping the newest diagnostic consumed", () => {
    const receipts = createUpdateRunReceipts();
    for (let index = 0; index <= 32; index++) {
      receipts.recordTriage("ws://gateway.test", null, String(index));
    }
    const reloaded = createUpdateRunReceipts();
    expect(reloaded.triaged("ws://gateway.test", null, "0")).toBe(false);
    expect(reloaded.triaged("ws://gateway.test", null, "1")).toBe(true);
    expect(reloaded.triaged("ws://gateway.test", null, "32")).toBe(true);
  });
  it.each(["2026.9.1", "2026.9.2", "both"])(
    "preserves consumed failures from %s through reload and the next write",
    (version) => {
      const receipt = (run: string) => JSON.stringify(["ws://gateway.test", null, run]);
      const previous = [];
      if (version !== "2026.9.2") {
        sessionStorage.setItem(TRIAGED_KEY, JSON.stringify({ triaged: [receipt("older")] }));
        previous.push("older");
      }
      if (version !== "2026.9.1") {
        sessionStorage.setItem(
          "openclaw:control-ui:update-triaged:v1",
          JSON.stringify([receipt("newer")]),
        );
        previous.push("newer");
      }
      const receipts = createUpdateRunReceipts();
      for (const run of previous) {
        expect(receipts.triaged("ws://gateway.test", null, run)).toBe(true);
      }
      expect(receipts.recordTriage("ws://gateway.test", null, "new-run")).toBe(true);
      expect(JSON.parse(sessionStorage.getItem(TRIAGED_KEY)!)).toEqual({
        triaged: [...previous, "new-run"].map(receipt),
      });
      const reloaded = createUpdateRunReceipts();
      for (const run of [...previous, "new-run"]) {
        expect(reloaded.triaged("ws://gateway.test", null, run)).toBe(true);
      }
      expect(sessionStorage.getItem("openclaw:control-ui:update-triaged:v1")).toBeNull();
    },
  );

  it.each(["not-json", JSON.stringify([42]), "x".repeat(32_768)])(
    "does not admit triage over unreadable 2026.9.2 receipts (%#)",
    (raw) => {
      sessionStorage.setItem("openclaw:control-ui:update-triaged:v1", raw);
      const receipts = createUpdateRunReceipts();
      expect(receipts.recordTriage("ws://gateway.test", null, "new-run")).toBe(false);
      expect(sessionStorage.getItem("openclaw:control-ui:update-triaged:v1")).toBe(raw);
      expect(sessionStorage.getItem(TRIAGED_KEY)).toBeNull();
    },
  );
});

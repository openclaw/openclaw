import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileBackedWal, readWalEventsFromStorage } from "./wal-file.js";

describe("file-backed WAL", () => {
  it("appends event and readWalEventsFromStorage returns it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-wal-"));
    try {
      const wal = createFileBackedWal(dir);
      wal.append({
        type: "CONSENT_ISSUED",
        jti: "jti-1",
        tool: "exec",
        sessionKey: "sess-1",
        trustTier: "T0",
        decision: "allow",
        reasonCode: "CONSENT_ALLOWED",
        correlationId: "corr-1",
        actor: {},
        tenantId: "t1",
      });
      const events = readWalEventsFromStorage(dir, { limit: 10 });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("CONSENT_ISSUED");
      expect(events[0].jti).toBe("jti-1");
      expect(events[0].correlationId).toBe("corr-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters by sinceMs and limit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-wal-"));
    try {
      const wal = createFileBackedWal(dir);
      const t0 = Date.now();
      wal.append({
        type: "CONSENT_DENIED",
        jti: null,
        tool: "exec",
        sessionKey: "s1",
        trustTier: "T0",
        decision: "deny",
        reasonCode: "CONSENT_NO_TOKEN",
        correlationId: "c1",
        actor: {},
        tenantId: "",
      });
      const events = readWalEventsFromStorage(dir, { sinceMs: t0 - 1000, limit: 5 });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.every((e) => e.ts >= t0 - 1000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array when wal dir does not exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-wal-empty-"));
    rmSync(dir, { recursive: true, force: true });
    const events = readWalEventsFromStorage(dir, {});
    expect(events).toEqual([]);
  });
});

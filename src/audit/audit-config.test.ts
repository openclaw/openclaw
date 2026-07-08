import { describe, expect, it } from "vitest";
import { isAuditLedgerEnabled } from "./audit-config.js";

describe("isAuditLedgerEnabled", () => {
  it("defaults to enabled without config or audit section", () => {
    expect(isAuditLedgerEnabled(undefined)).toBe(true);
    expect(isAuditLedgerEnabled({})).toBe(true);
    expect(isAuditLedgerEnabled({ audit: {} })).toBe(true);
  });

  it("stays enabled on explicit true", () => {
    expect(isAuditLedgerEnabled({ audit: { enabled: true } })).toBe(true);
  });

  it("disables only on explicit false", () => {
    expect(isAuditLedgerEnabled({ audit: { enabled: false } })).toBe(false);
  });
});

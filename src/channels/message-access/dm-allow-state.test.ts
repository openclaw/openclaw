import { describe, expect, it } from "vitest";
import { resolveDmAllowAuditState } from "./dm-allow-state.js";

function normalizeEntry(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^(demo|user):/i, "")
    .trim();
  return trimmed.toLowerCase();
}

async function auditState(allowFrom: string[]) {
  return await resolveDmAllowAuditState({
    provider: "demo",
    accountId: "default",
    allowFrom,
    dmPolicy: "open",
    normalizeEntry,
  });
}

describe("resolveDmAllowAuditState", () => {
  it.each(["*", "demo:*", "user:*"])("reports %s as an open DM allowlist", async (entry) => {
    await expect(auditState([entry])).resolves.toEqual({
      hasWildcard: true,
      admittedPrincipals: [],
    });
  });

  it("keeps narrow allowlists unchanged", async () => {
    await expect(auditState(["demo:Owner-1", "owner-2"])).resolves.toEqual({
      hasWildcard: false,
      admittedPrincipals: ["owner-1", "owner-2"],
    });
  });

  it("keeps configured owners alongside a prefixed wildcard", async () => {
    await expect(auditState(["demo:*", "demo:Owner-1"])).resolves.toEqual({
      hasWildcard: true,
      admittedPrincipals: ["owner-1"],
    });
  });

  it("merges persisted principals", async () => {
    await expect(
      resolveDmAllowAuditState({
        provider: "demo",
        accountId: "default",
        allowFrom: ["demo:*"],
        dmPolicy: "pairing",
        normalizeEntry,
        readStore: async () => ["demo:Paired-1"],
      }),
    ).resolves.toEqual({ hasWildcard: true, admittedPrincipals: ["paired-1"] });
  });
});

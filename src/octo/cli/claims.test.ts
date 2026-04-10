// Octopus Orchestrator -- `openclaw octo claims list` tests (M3-09)
//
// Covers:
//   - gatherClaimsList: empty registry, populated, filter by arm
//   - formatClaimsList: human-readable table, empty state message
//   - runClaimsList: exit code 0, json mode

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClaimInput, RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import { formatClaimsList, gatherClaimsList, runClaimsList } from "./claims.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-claims-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
});

afterEach(() => {
  try {
    closeOctoRegistry(db);
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Factory helpers -- minimal valid inputs
// ──────────────────────────────────────────────────────────────────────────

function makeClaimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    claim_id: `claim-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    grip_id: "grip-1",
    resource_type: "file",
    resource_key: "/tmp/x",
    owner_arm_id: "arm-1",
    mode: "exclusive",
    lease_expiry_ts: Date.now() + 60_000,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// gatherClaimsList
// ════════════════════════════════════════════════════════════════════════

describe("gatherClaimsList", () => {
  it("returns empty array on empty registry", () => {
    const claims = gatherClaimsList(registry, {});
    expect(claims).toEqual([]);
  });

  it("returns all claims when no filters are applied", () => {
    registry.putClaim(makeClaimInput());
    registry.putClaim(makeClaimInput());

    const claims = gatherClaimsList(registry, {});
    expect(claims).toHaveLength(2);
  });

  it("filters by owner arm", () => {
    registry.putClaim(makeClaimInput({ owner_arm_id: "arm-alpha" }));
    registry.putClaim(makeClaimInput({ owner_arm_id: "arm-beta" }));

    const claims = gatherClaimsList(registry, { arm: "arm-alpha" });
    expect(claims).toHaveLength(1);
    expect(claims[0].owner_arm_id).toBe("arm-alpha");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatClaimsList
// ════════════════════════════════════════════════════════════════════════

describe("formatClaimsList", () => {
  it("shows empty message when no claims", () => {
    const output = formatClaimsList([]);
    expect(output).toContain("No claims found.");
  });

  it("renders table with header and claim rows", () => {
    const claim = {
      claim_id: "claim-001",
      mission_id: "mission-x",
      grip_id: "grip-1",
      resource_type: "file",
      resource_key: "/tmp/test.txt",
      owner_arm_id: "arm-abc",
      mode: "exclusive" as const,
      lease_expiry_ts: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
      version: 1,
    };

    const output = formatClaimsList([claim]);
    expect(output).toContain("CLAIM_ID");
    expect(output).toContain("RESOURCE_TYPE");
    expect(output).toContain("RESOURCE_KEY");
    expect(output).toContain("MODE");
    expect(output).toContain("OWNER_ARM");
    expect(output).toContain("claim-001");
    expect(output).toContain("file");
    expect(output).toContain("exclusive");
    expect(output).toContain("arm-abc");
    expect(output).toContain("1 claim(s) total");
  });
});

// ════════════════════════════════════════════════════════════════════════
// runClaimsList
// ════════════════════════════════════════════════════════════════════════

describe("runClaimsList", () => {
  it("returns 0 and writes output", () => {
    registry.putClaim(makeClaimInput());

    const out = { write: vi.fn() };
    const code = runClaimsList(registry, {}, out);

    expect(code).toBe(0);
    expect(out.write).toHaveBeenCalledTimes(1);
  });

  it("with json: true produces JSON output", () => {
    registry.putClaim(makeClaimInput({ owner_arm_id: "arm-json" }));

    const out = { write: vi.fn() };
    const code = runClaimsList(registry, { json: true }, out);

    expect(code).toBe(0);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written.trimStart().startsWith("[")).toBe(true);

    const parsed = JSON.parse(written) as unknown[];
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as Record<string, unknown>).owner_arm_id).toBe("arm-json");
  });
});

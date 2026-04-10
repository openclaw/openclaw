// Octopus Orchestrator — ClaimService tests (M3-05)
//
// Covers: acquire (exclusive, shared-read, idempotent, conflict modes),
// release, expireStale, batch atomicity, isClaimedExclusive.
//
// Each test gets a fresh temp SQLite DB + event log via beforeEach/afterEach.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimRequest } from "../wire/schema.ts";
import { ClaimDeniedError, ClaimService } from "./claims.ts";
import { EventLogService } from "./event-log.ts";
import { RegistryService } from "./registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB + event log harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let eventLog: EventLogService;
let claimService: ClaimService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-claims-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  eventLog = new EventLogService({ path: path.join(tempDir, "events.jsonl") });
  claimService = new ClaimService(registry, eventLog, db);
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
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const FUTURE_TS = Date.now() + 60_000;

function makeClaimReq(overrides: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    resource_type: "file",
    resource_key: "/src/main.ts",
    mode: "exclusive",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("ClaimService", () => {
  // 1. Acquire exclusive claim on unclaimed resource -> succeeds
  it("acquires exclusive claim on unclaimed resource", async () => {
    const results = await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq()],
      FUTURE_TS,
    );
    expect(results).toHaveLength(1);
    expect(results[0].owner_arm_id).toBe("arm-1");
    expect(results[0].mode).toBe("exclusive");
    expect(results[0].resource_type).toBe("file");
    expect(results[0].resource_key).toBe("/src/main.ts");
  });

  // 2. Acquire exclusive on resource already exclusively claimed by another arm -> denied
  it("denies exclusive claim when resource is exclusively held by another arm", async () => {
    await claimService.acquire("arm-1", "mission-1", "grip-1", [makeClaimReq()], FUTURE_TS);

    await expect(
      claimService.acquire("arm-2", "mission-1", "grip-2", [makeClaimReq()], FUTURE_TS),
    ).rejects.toThrow(ClaimDeniedError);
  });

  // 3. Acquire exclusive claim on resource you already own -> idempotent (refreshes lease)
  it("refreshes lease when re-acquiring own exclusive claim", async () => {
    const first = await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq()],
      FUTURE_TS,
    );
    const newExpiry = FUTURE_TS + 30_000;
    const second = await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq()],
      newExpiry,
    );
    expect(second).toHaveLength(1);
    expect(second[0].claim_id).toBe(first[0].claim_id);
    expect(second[0].lease_expiry_ts).toBe(newExpiry);
  });

  // 4. Acquire shared-read on unclaimed resource -> succeeds
  it("acquires shared-read claim on unclaimed resource", async () => {
    const results = await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq({ mode: "shared-read" })],
      FUTURE_TS,
    );
    expect(results).toHaveLength(1);
    expect(results[0].mode).toBe("shared-read");
  });

  // 5. Two arms acquire shared-read on same resource -> both succeed
  it("allows multiple shared-read claims from different arms", async () => {
    const first = await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq({ mode: "shared-read" })],
      FUTURE_TS,
    );
    const second = await claimService.acquire(
      "arm-2",
      "mission-1",
      "grip-2",
      [makeClaimReq({ mode: "shared-read" })],
      FUTURE_TS,
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].owner_arm_id).toBe("arm-1");
    expect(second[0].owner_arm_id).toBe("arm-2");
  });

  // 6. Acquire exclusive on resource with existing shared-read by another arm -> denied
  it("denies exclusive claim when shared-read exists by another arm", async () => {
    await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq({ mode: "shared-read" })],
      FUTURE_TS,
    );

    await expect(
      claimService.acquire(
        "arm-2",
        "mission-1",
        "grip-2",
        [makeClaimReq({ mode: "exclusive" })],
        FUTURE_TS,
      ),
    ).rejects.toThrow(ClaimDeniedError);
  });

  // 7. Acquire shared-read on resource with existing exclusive by another arm -> denied
  it("denies shared-read claim when exclusive exists by another arm", async () => {
    await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq({ mode: "exclusive" })],
      FUTURE_TS,
    );

    await expect(
      claimService.acquire(
        "arm-2",
        "mission-1",
        "grip-2",
        [makeClaimReq({ mode: "shared-read" })],
        FUTURE_TS,
      ),
    ).rejects.toThrow(ClaimDeniedError);
  });

  // 8. Release claims -> resource becomes unclaimed
  it("releases claims so resource becomes unclaimed", async () => {
    const acquired = await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq()],
      FUTURE_TS,
    );

    await claimService.release("arm-1", [acquired[0].claim_id]);

    const exclusive = claimService.isClaimedExclusive("file", "/src/main.ts");
    expect(exclusive).toBeNull();
  });

  // 9. expireStale removes expired claims
  it("expires stale claims past lease_expiry_ts", async () => {
    const pastTs = Date.now() - 10_000;
    await claimService.acquire("arm-1", "mission-1", "grip-1", [makeClaimReq()], pastTs);

    const count = await claimService.expireStale();
    expect(count).toBe(1);

    const exclusive = claimService.isClaimedExclusive("file", "/src/main.ts");
    expect(exclusive).toBeNull();
  });

  // 10. Batch acquire: if one claim in the batch conflicts, NONE are acquired (atomicity)
  it("rolls back entire batch if any claim in the batch conflicts", async () => {
    // arm-1 holds exclusive on resource-B
    await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq({ resource_key: "/src/b.ts" })],
      FUTURE_TS,
    );

    // arm-2 tries to acquire resource-A (unclaimed) + resource-B (held) atomically
    const batch: ClaimRequest[] = [
      makeClaimReq({ resource_key: "/src/a.ts" }),
      makeClaimReq({ resource_key: "/src/b.ts" }),
    ];

    await expect(
      claimService.acquire("arm-2", "mission-1", "grip-2", batch, FUTURE_TS),
    ).rejects.toThrow(ClaimDeniedError);

    // resource-A should NOT be claimed (batch was rolled back)
    const claimA = claimService.isClaimedExclusive("file", "/src/a.ts");
    expect(claimA).toBeNull();
  });

  // 11. isClaimedExclusive returns the record when exclusive claim exists
  it("isClaimedExclusive returns record when exclusive claim exists", async () => {
    await claimService.acquire("arm-1", "mission-1", "grip-1", [makeClaimReq()], FUTURE_TS);
    const result = claimService.isClaimedExclusive("file", "/src/main.ts");
    expect(result).not.toBeNull();
    expect(result!.owner_arm_id).toBe("arm-1");
  });

  // 12. isClaimedExclusive returns null for shared-read claims
  it("isClaimedExclusive returns null when only shared-read claims exist", async () => {
    await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq({ mode: "shared-read" })],
      FUTURE_TS,
    );
    const result = claimService.isClaimedExclusive("file", "/src/main.ts");
    expect(result).toBeNull();
  });

  // 13. ClaimDeniedError carries structured information
  it("ClaimDeniedError includes resource and arm info", async () => {
    await claimService.acquire("arm-1", "mission-1", "grip-1", [makeClaimReq()], FUTURE_TS);

    try {
      await claimService.acquire("arm-2", "mission-1", "grip-2", [makeClaimReq()], FUTURE_TS);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimDeniedError);
      const denied = err as ClaimDeniedError;
      expect(denied.resource_type).toBe("file");
      expect(denied.resource_key).toBe("/src/main.ts");
      expect(denied.existingOwner).toBe("arm-1");
      expect(denied.requestingArm).toBe("arm-2");
    }
  });

  // 14. expireStale does not remove non-expired claims
  it("expireStale preserves claims with future lease_expiry_ts", async () => {
    await claimService.acquire("arm-1", "mission-1", "grip-1", [makeClaimReq()], FUTURE_TS);

    const count = await claimService.expireStale();
    expect(count).toBe(0);

    const result = claimService.isClaimedExclusive("file", "/src/main.ts");
    expect(result).not.toBeNull();
  });

  // 15. Release with wrong armId is a no-op
  it("release is a no-op when armId does not match claim owner", async () => {
    const acquired = await claimService.acquire(
      "arm-1",
      "mission-1",
      "grip-1",
      [makeClaimReq()],
      FUTURE_TS,
    );

    await claimService.release("arm-2", [acquired[0].claim_id]);

    const result = claimService.isClaimedExclusive("file", "/src/main.ts");
    expect(result).not.toBeNull();
  });

  // 16. Empty acquire batch returns empty array
  it("acquire with empty claims array returns empty array", async () => {
    const results = await claimService.acquire("arm-1", "mission-1", "grip-1", [], FUTURE_TS);
    expect(results).toEqual([]);
  });
});

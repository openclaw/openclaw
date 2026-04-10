// Octopus Orchestrator -- chaos test: two arms claim the same file (M3-14)
//
// Spawns two arm rows and races them through ClaimService.acquire on the
// same file path. Verifies exclusive-claim contention, release-then-reacquire,
// and shared-read compatibility.
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins, vitest, and
// relative imports inside src/octo/.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaimDeniedError, ClaimService } from "../../head/claims.ts";
import { EventLogService } from "../../head/event-log.ts";
import { RegistryService } from "../../head/registry.ts";
import type { ArmInput } from "../../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../../head/storage/migrate.ts";
import type { ArmSpec } from "../../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const CONTESTED_FILE = "src/core/engine.ts";

function makeArmSpec(): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-chaos-claim",
    adapter_type: "cli_exec",
    runtime_name: "claude",
    agent_id: "agent-1",
    cwd: "/tmp/test",
    idempotency_key: "idem-chaos-claim",
    runtime_options: { command: "echo" },
  };
}

function makeArmInput(armId: string): ArmInput {
  return {
    arm_id: armId,
    mission_id: "mission-chaos-claim",
    node_id: "node-local",
    adapter_type: "cli_exec",
    runtime_name: "claude",
    agent_id: "agent-1",
    task_ref: null,
    state: "running",
    current_grip_id: null,
    lease_owner: null,
    lease_expiry_ts: null,
    session_ref: null,
    checkpoint_ref: null,
    health_status: null,
    restart_count: 0,
    policy_profile: null,
    spec: makeArmSpec(),
  };
}

const LEASE_FUTURE = Date.now() + 60_000;

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("chaos: two arms claim the same file concurrently (M3-14)", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let registry: RegistryService;
  let eventLog: EventLogService;
  let claimSvc: ClaimService;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "octo-chaos-concurrent-claim-"));
    const dbPath = path.join(tmpDir, "registry.sqlite");
    const eventsPath = path.join(tmpDir, "events.jsonl");

    db = openOctoRegistry({ path: dbPath });
    registry = new RegistryService(db);
    eventLog = new EventLogService({ path: eventsPath });
    claimSvc = new ClaimService(registry, eventLog, db);

    // Insert two arm rows directly.
    registry.putArm(makeArmInput("arm-alpha"));
    registry.putArm(makeArmInput("arm-beta"));
  });

  afterEach(() => {
    closeOctoRegistry(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exactly one arm wins the exclusive claim; the other gets ClaimDeniedError", async () => {
    const acquireAlpha = claimSvc.acquire(
      "arm-alpha",
      "mission-chaos-claim",
      "grip-1",
      [{ resource_type: "file", resource_key: CONTESTED_FILE, mode: "exclusive" }],
      LEASE_FUTURE,
    );

    const acquireBeta = claimSvc.acquire(
      "arm-beta",
      "mission-chaos-claim",
      "grip-2",
      [{ resource_type: "file", resource_key: CONTESTED_FILE, mode: "exclusive" }],
      LEASE_FUTURE,
    );

    const results = await Promise.allSettled([acquireAlpha, acquireBeta]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The winner received a valid ClaimRecord array.
    const winnerClaims = (fulfilled[0] as PromiseFulfilledResult<unknown>).value;
    expect(Array.isArray(winnerClaims)).toBe(true);
    expect((winnerClaims as unknown[]).length).toBe(1);

    // The loser received a ClaimDeniedError.
    const loserReason = rejected[0]?.reason;
    expect(loserReason).toBeInstanceOf(ClaimDeniedError);
  }, 10_000);

  it("winner releases; after release the loser can acquire successfully", async () => {
    // Sequentially: alpha wins first.
    const alphaClaims = await claimSvc.acquire(
      "arm-alpha",
      "mission-chaos-claim",
      "grip-1",
      [{ resource_type: "file", resource_key: CONTESTED_FILE, mode: "exclusive" }],
      LEASE_FUTURE,
    );

    // Beta is denied while alpha holds.
    await expect(
      claimSvc.acquire(
        "arm-beta",
        "mission-chaos-claim",
        "grip-2",
        [{ resource_type: "file", resource_key: CONTESTED_FILE, mode: "exclusive" }],
        LEASE_FUTURE,
      ),
    ).rejects.toThrow(ClaimDeniedError);

    // Alpha releases.
    const claimIds = alphaClaims.map((c) => c.claim_id);
    await claimSvc.release("arm-alpha", claimIds);

    // Now beta can acquire.
    const betaClaims = await claimSvc.acquire(
      "arm-beta",
      "mission-chaos-claim",
      "grip-2",
      [{ resource_type: "file", resource_key: CONTESTED_FILE, mode: "exclusive" }],
      LEASE_FUTURE,
    );

    expect(betaClaims).toHaveLength(1);
    expect(betaClaims[0].owner_arm_id).toBe("arm-beta");
    expect(betaClaims[0].resource_key).toBe(CONTESTED_FILE);
    expect(betaClaims[0].mode).toBe("exclusive");
  }, 10_000);

  it("two shared-read claims on the same file both succeed", async () => {
    const acquireAlpha = claimSvc.acquire(
      "arm-alpha",
      "mission-chaos-claim",
      "grip-1",
      [{ resource_type: "file", resource_key: CONTESTED_FILE, mode: "shared-read" }],
      LEASE_FUTURE,
    );

    const acquireBeta = claimSvc.acquire(
      "arm-beta",
      "mission-chaos-claim",
      "grip-2",
      [{ resource_type: "file", resource_key: CONTESTED_FILE, mode: "shared-read" }],
      LEASE_FUTURE,
    );

    const results = await Promise.allSettled([acquireAlpha, acquireBeta]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(0);

    // Both arms hold a shared-read claim on the same file.
    for (const result of fulfilled) {
      const claims = (result as PromiseFulfilledResult<unknown>).value as Array<{
        resource_key: string;
        mode: string;
      }>;
      expect(claims).toHaveLength(1);
      expect(claims[0].resource_key).toBe(CONTESTED_FILE);
      expect(claims[0].mode).toBe("shared-read");
    }
  }, 10_000);
});

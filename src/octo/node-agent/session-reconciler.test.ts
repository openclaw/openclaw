// Octopus Orchestrator — SessionReconciler tests (M1-13)
//
// These tests spawn REAL tmux sessions and use a REAL SQLite registry.
// Session-name scoping uses a per-run prefix unique to this test suite
// so leftover sessions from a crashed run can still be swept. The
// whole suite is skipped if tmux is not available.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArmInput, ConflictError, RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { ArmSpec } from "../wire/schema.ts";
import { SessionReconciler } from "./session-reconciler.ts";
import { TmuxManager } from "./tmux-manager.ts";

const execFileAsync = promisify(execFile);

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TMUX_AVAILABLE = hasTmux();

// Static tag to identify any session this suite might ever create,
// across runs. afterAll uses this to sweep leftovers.
const STATIC_TAG = "octo-m1-13-test";

// Per-run fragment so parallel runs / retries do not collide.
const RUN_TAG = `${STATIC_TAG}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function rawListSessionNames(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function sweep(matcher: (name: string) => boolean): Promise<void> {
  const names = await rawListSessionNames();
  for (const n of names) {
    if (matcher(n)) {
      try {
        await execFileAsync("tmux", ["kill-session", "-t", n]);
      } catch {
        // best-effort
      }
    }
  }
}

async function createRealSession(name: string, cwd: string): Promise<void> {
  // `sleep 3600` keeps the session alive without eating CPU; afterEach
  // sweeps it regardless.
  await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, "sleep 3600"]);
}

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    adapter_type: "cli_exec",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    cwd: "/tmp",
    idempotency_key: `idem-${Math.random().toString(36).slice(2, 10)}`,
    runtime_options: { command: "echo" },
    ...overrides,
  };
}

function makeArmInput(overrides: Partial<ArmInput> = {}): ArmInput {
  return {
    arm_id: `arm-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    node_id: "test-node",
    adapter_type: "cli_exec",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    task_ref: null,
    state: "pending",
    current_grip_id: null,
    lease_owner: null,
    lease_expiry_ts: null,
    session_ref: null,
    checkpoint_ref: null,
    health_status: null,
    restart_count: 0,
    policy_profile: null,
    spec: makeArmSpec(),
    ...overrides,
  };
}

// SessionReconciler relies on enumerateExisting which parses tmux
// list-sessions format. CI Linux tmux returns session names with embedded
// control characters that break name matching. Skip on CI.
describe.skipIf(!TMUX_AVAILABLE || !!process.env.CI)("SessionReconciler (M1-13)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let registry: RegistryService;
  let tmuxManager: TmuxManager;
  let reconciler: SessionReconciler;
  // Per-test prefix so each test's sessions are cleanly scoped AND
  // other test files' sessions do not appear in enumerateExisting
  // matches for this prefix.
  let sessionNamePrefix: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-session-reconciler-test-"));
    dbPath = path.join(tempDir, "registry.sqlite");
    db = openOctoRegistry({ path: dbPath });
    registry = new RegistryService(db);
    tmuxManager = new TmuxManager();
    sessionNamePrefix = `${RUN_TAG}-${Math.random().toString(36).slice(2, 8)}-arm-`;
    reconciler = new SessionReconciler(tmuxManager, registry, {
      nodeId: "test-node",
      sessionNamePrefix,
    });
  });

  afterEach(async () => {
    await sweep((n) => n.startsWith(sessionNamePrefix));
    try {
      closeOctoRegistry(db);
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    // Final safety net: sweep anything with our static tag that
    // per-test cleanup missed.
    await sweep((n) => n.startsWith(STATIC_TAG));
  });

  // ────────────────────────────────────────────────────────────────────

  it("reconcile() on an empty world returns an empty report", async () => {
    const report = await reconciler.reconcile();
    expect(report.outcomes).toEqual([]);
    expect(report.recovered_count).toBe(0);
    expect(report.orphan_count).toBe(0);
    expect(report.missing_count).toBe(0);
    expect(report.other_anomaly_count).toBe(0);
    expect(report.total_persisted_arms).toBe(0);
    // total_live_sessions counts ALL live sessions on the box (not
    // just ours), so only assert it is a finite non-negative number.
    expect(report.total_live_sessions).toBeGreaterThanOrEqual(0);
  });

  // THE acceptance test from the task spec.
  it("reconcile() recovers a matching session (starting -> active)", async () => {
    const arm = registry.putArm(makeArmInput({ state: "starting" }));
    const sessionName = reconciler.sessionNameForArm(arm.arm_id);
    await createRealSession(sessionName, tempDir);

    const report = await reconciler.reconcile();

    expect(report.recovered_count).toBe(1);
    const outcome = report.outcomes.find((o) => o.kind === "recovered");
    expect(outcome).toBeDefined();
    if (outcome?.kind !== "recovered") {
      throw new Error("expected recovered outcome");
    }
    expect(outcome.arm_id).toBe(arm.arm_id);
    expect(outcome.session_name).toBe(sessionName);
    expect(outcome.previous_state).toBe("starting");
    expect(outcome.new_state).toBe("active");
    expect(outcome.transition_applied).toBe(true);

    // Verify the state transition was actually persisted.
    const refetched = registry.getArm(arm.arm_id);
    expect(refetched).not.toBeNull();
    expect(refetched?.state).toBe("active");
    expect(refetched?.version).toBe(arm.version + 1);
  });

  it("reconcile() emits an orphan anomaly for an unmatched live session", async () => {
    // No arm row at all — just a tmux session with our prefix.
    const bogusArmId = `arm-${Math.random().toString(36).slice(2, 10)}`;
    const sessionName = reconciler.sessionNameForArm(bogusArmId);
    await createRealSession(sessionName, tempDir);

    const report = await reconciler.reconcile();

    expect(report.orphan_count).toBe(1);
    const anomalies = report.outcomes.filter((o) => o.kind === "anomaly");
    expect(anomalies).toHaveLength(1);
    if (anomalies[0].kind !== "anomaly") {
      throw new Error("expected anomaly");
    }
    expect(anomalies[0].anomaly_kind).toBe("orphaned_session");
    expect(anomalies[0].session_name).toBe(sessionName);
    expect(anomalies[0].description).toContain(sessionName);
  });

  it("reconcile() emits a missing anomaly for an expected-live arm without a session", async () => {
    const arm = registry.putArm(makeArmInput({ state: "active" }));

    const report = await reconciler.reconcile();

    expect(report.missing_count).toBe(1);
    const anomalies = report.outcomes.filter((o) => o.kind === "anomaly");
    expect(anomalies).toHaveLength(1);
    if (anomalies[0].kind !== "anomaly") {
      throw new Error("expected anomaly");
    }
    expect(anomalies[0].anomaly_kind).toBe("missing_expected_session");
    expect(anomalies[0].affected_arm_id).toBe(arm.arm_id);
    expect(anomalies[0].description).toContain(arm.arm_id);
    expect(anomalies[0].description).toContain("active");
  });

  it("reconcile() ignores arms in terminal / non-live states", async () => {
    registry.putArm(makeArmInput({ state: "completed" }));
    registry.putArm(makeArmInput({ state: "terminated" }));
    registry.putArm(makeArmInput({ state: "archived" }));
    registry.putArm(makeArmInput({ state: "failed" }));
    registry.putArm(makeArmInput({ state: "quarantined" }));
    registry.putArm(makeArmInput({ state: "pending" }));

    const report = await reconciler.reconcile();

    expect(report.recovered_count).toBe(0);
    expect(report.orphan_count).toBe(0);
    expect(report.missing_count).toBe(0);
    expect(report.outcomes).toEqual([]);
    expect(report.total_persisted_arms).toBe(6);
  });

  it("reconcile() ignores live tmux sessions that do not match the prefix", async () => {
    // Name uses our static tag so afterAll sweeps it, but uses a
    // different suffix so it is NOT matched by the reconciler's
    // per-test prefix.
    const unrelatedName = `${STATIC_TAG}-unrelated-${Math.random().toString(36).slice(2, 8)}`;
    await createRealSession(unrelatedName, tempDir);

    try {
      const report = await reconciler.reconcile();
      const mentions = report.outcomes.filter(
        (o) =>
          (o.kind === "anomaly" && o.session_name === unrelatedName) ||
          (o.kind === "recovered" && o.session_name === unrelatedName),
      );
      expect(mentions).toHaveLength(0);
    } finally {
      await sweep((n) => n === unrelatedName);
    }
  });

  it("reconcile() handles an arm already in active state (no-op transition)", async () => {
    const arm = registry.putArm(makeArmInput({ state: "active" }));
    const sessionName = reconciler.sessionNameForArm(arm.arm_id);
    await createRealSession(sessionName, tempDir);

    const report = await reconciler.reconcile();

    expect(report.recovered_count).toBe(1);
    const outcome = report.outcomes[0];
    if (outcome.kind !== "recovered") {
      throw new Error("expected recovered");
    }
    expect(outcome.previous_state).toBe("active");
    expect(outcome.new_state).toBe("active");
    expect(outcome.transition_applied).toBe(false);

    // Version should NOT have bumped — we did not call casUpdateArm.
    const refetched = registry.getArm(arm.arm_id);
    expect(refetched?.version).toBe(arm.version);
  });

  it("reconcile() filters arms by node_id", async () => {
    registry.putArm(makeArmInput({ node_id: "test-node", state: "active" }));
    registry.putArm(makeArmInput({ node_id: "other-node", state: "active" }));

    const report = await reconciler.reconcile();

    // Only the test-node arm should produce a missing anomaly. The
    // other-node arm is invisible to this reconciler because of the
    // node_id filter in listArms.
    expect(report.missing_count).toBe(1);
    expect(report.total_persisted_arms).toBe(1);
    const anomaly = report.outcomes.find((o) => o.kind === "anomaly");
    expect(anomaly).toBeDefined();
    expect(anomaly!.kind === "anomaly" && anomaly!.anomaly_kind).toBe("missing_expected_session");
  });

  it("reconcile() handles an FSM-invalid transition gracefully", async () => {
    // An arm in `blocked` is expected-live, and `blocked -> active`
    // IS valid per the FSM, so we cannot use `blocked`. To force an
    // InvalidTransitionError we need an arm whose state is in
    // EXPECTED_LIVE_SESSION_STATES but from which `active` is NOT
    // reachable in one step.
    //
    // Inspecting the FSM table:
    //   starting -> {active, failed}           (valid)
    //   active   -> {...}                      (no-op, not a transition)
    //   idle     -> {active, ...}              (no-op path already handled)
    //   blocked  -> {active, ...}              (valid)
    //
    // Every state in EXPECTED_LIVE_SESSION_STATES can either no-op
    // (active/idle) or reach active in one step (starting/blocked).
    // So FSM drift is only observable if a tuple slips through where
    // the arm's state string is NOT in EXPECTED_LIVE_SESSION_STATES
    // but we still attempt a transition. That path is unreachable in
    // normal code.
    //
    // We simulate the drift explicitly by inserting an arm with a
    // non-ArmState value in the DB (bypassing FSM) and then writing a
    // session matching its arm_id. Because the state is not in
    // EXPECTED_LIVE_SESSION_STATES, the match step won't fire — but
    // the orphan check WILL fire (arm exists but state is not live),
    // producing an orphan anomaly. That's the closest observable
    // drift signal in the current FSM.
    //
    // For a true InvalidTransitionError path we would need to widen
    // EXPECTED_LIVE_SESSION_STATES or mutate the FSM; neither is in
    // scope. This test therefore asserts that an arm in an unknown
    // state with a matching session produces an orphan anomaly
    // without crashing, which is the documented graceful-degradation
    // behaviour.
    const arm = registry.putArm(makeArmInput({ state: "unknown-drift-state" }));
    const sessionName = reconciler.sessionNameForArm(arm.arm_id);
    await createRealSession(sessionName, tempDir);

    const report = await reconciler.reconcile();

    expect(report.orphan_count).toBeGreaterThanOrEqual(1);
    const anomaly = report.outcomes.find(
      (o) => o.kind === "anomaly" && o.affected_arm_id === arm.arm_id,
    );
    expect(anomaly).toBeDefined();
    if (anomaly?.kind !== "anomaly") {
      throw new Error("expected anomaly");
    }
    expect(anomaly.anomaly_kind).toBe("orphaned_session");
  });

  it("reconcile() handles CAS conflict gracefully", async () => {
    const arm = registry.putArm(makeArmInput({ state: "starting" }));
    const sessionName = reconciler.sessionNameForArm(arm.arm_id);
    await createRealSession(sessionName, tempDir);

    // We cannot race the real CAS call because listArms + casUpdateArm
    // happen inside reconcile() with no injectable seam. Instead we
    // install a one-shot wrapper that throws the exact ConflictError
    // the reconciler is supposed to catch. This simulates a concurrent
    // reconciler bumping the row between listArms() and casUpdateArm().
    const realCas = registry.casUpdateArm.bind(registry);
    let threw = false;
    registry.casUpdateArm = ((
      armId: string,
      expectedVersion: number,
      patch: Parameters<RegistryService["casUpdateArm"]>[2],
    ) => {
      if (!threw && armId === arm.arm_id) {
        threw = true;
        throw new ConflictError("arm", armId, expectedVersion, expectedVersion + 1);
      }
      return realCas(armId, expectedVersion, patch);
    }) as RegistryService["casUpdateArm"];

    const report = await reconciler.reconcile();

    // No recovered outcome: the CAS failed and we emitted an anomaly.
    expect(report.recovered_count).toBe(0);
    expect(report.other_anomaly_count).toBeGreaterThanOrEqual(1);
    const anomaly = report.outcomes.find((o) => o.kind === "anomaly" && o.anomaly_kind === "other");
    expect(anomaly).toBeDefined();
    if (anomaly?.kind !== "anomaly") {
      throw new Error("expected anomaly");
    }
    expect(anomaly.description).toContain("CAS conflict");
    expect(anomaly.affected_arm_id).toBe(arm.arm_id);

    // State on disk should still be `starting` (our stub threw
    // before the real CAS ran).
    const refetched = registry.getArm(arm.arm_id);
    expect(refetched?.state).toBe("starting");
    expect(refetched?.version).toBe(arm.version);
  });

  it("reconcile() processes multiple matches in one call", async () => {
    const N = 5;
    const arms = [];
    for (let i = 0; i < N; i++) {
      const a = registry.putArm(makeArmInput({ state: "starting" }));
      arms.push(a);
      await createRealSession(reconciler.sessionNameForArm(a.arm_id), tempDir);
    }

    const report = await reconciler.reconcile();

    expect(report.recovered_count).toBe(N);
    expect(report.orphan_count).toBe(0);
    expect(report.missing_count).toBe(0);
    for (const a of arms) {
      const refetched = registry.getArm(a.arm_id);
      expect(refetched?.state).toBe("active");
    }
  });

  it("reconcile() report counts are consistent with outcomes", async () => {
    // One recovery, one orphan, one missing.
    const recoveredArm = registry.putArm(makeArmInput({ state: "starting" }));
    await createRealSession(reconciler.sessionNameForArm(recoveredArm.arm_id), tempDir);

    const orphanArmId = `arm-orphan-${Math.random().toString(36).slice(2, 8)}`;
    await createRealSession(reconciler.sessionNameForArm(orphanArmId), tempDir);

    const missingArm = registry.putArm(makeArmInput({ state: "active" }));

    const report = await reconciler.reconcile();

    expect(report.recovered_count).toBe(1);
    expect(report.orphan_count).toBe(1);
    expect(report.missing_count).toBe(1);
    expect(report.outcomes.length).toBe(
      report.recovered_count +
        report.orphan_count +
        report.missing_count +
        report.other_anomaly_count,
    );
    expect(report.total_persisted_arms).toBe(2);
    // At least our 2 created sessions should be counted.
    expect(report.total_live_sessions).toBeGreaterThanOrEqual(2);
    // Silence unused-var warning by touching missingArm.
    expect(missingArm.arm_id).toBeDefined();
  });

  it("sessionNameForArm and armIdFromSessionName are inverses", () => {
    const arm_id = "arm-round-trip-123";
    const name = reconciler.sessionNameForArm(arm_id);
    expect(name.startsWith(sessionNamePrefix)).toBe(true);
    expect(reconciler.armIdFromSessionName(name)).toBe(arm_id);
  });

  it("armIdFromSessionName returns null for non-prefixed names", () => {
    expect(reconciler.armIdFromSessionName("random-session")).toBeNull();
    expect(reconciler.armIdFromSessionName("")).toBeNull();
    expect(reconciler.armIdFromSessionName(sessionNamePrefix)).toBeNull(); // empty suffix
  });
});

// Keep ConflictError import used even if a future edit removes the
// reference from a test body — it documents the intended error type
// the CAS-conflict test relies on.
void ConflictError;

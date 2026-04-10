// Octopus Orchestrator -- Chaos test: policy denies a spawn (M5-07)
//
// Verifies that OctoGatewayHandlers.armSpawn respects PolicyService
// decisions: a "deny" decision prevents arm creation and surfaces as
// HandlerError("policy_denied"); an "allow" decision lets the spawn
// proceed normally.
//
// Self-contained: uses mock PolicyService instances with stubbed
// resolve() + check(). No tmux required for the deny path (spawn
// never reaches the adapter). The allow path uses pty_tmux and is
// gated on tmux availability.
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins and relative
// imports inside src/octo/.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLogService } from "../../head/event-log.ts";
import type { PolicyService } from "../../head/policy.ts";
import { RegistryService } from "../../head/registry.ts";
import { openOctoRegistry, closeOctoRegistry } from "../../head/storage/migrate.ts";
import { TmuxManager } from "../../node-agent/tmux-manager.ts";
import {
  OctoGatewayHandlers,
  HandlerError,
  type OctoGatewayHandlerDeps,
} from "../../wire/gateway-handlers.ts";
import type { ArmSpec } from "../../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// tmux availability gate (needed only for the allow-path test)
// ──────────────────────────────────────────────────────────────────────────

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TMUX_AVAILABLE = hasTmux();

// ──────────────────────────────────────────────────────────────────────────
// Mock PolicyService factories
// ──────────────────────────────────────────────────────────────────────────

const DUMMY_PROFILE = { name: "__test__", allowedTools: [], deniedTools: [] };

function makeDenyPolicy(reason: string, ruleId: string): PolicyService {
  return {
    resolve: () => DUMMY_PROFILE,
    check: () => ({ decision: "deny" as const, reason, ruleId }),
  } as unknown as PolicyService;
}

function makeAllowPolicy(): PolicyService {
  return {
    resolve: () => DUMMY_PROFILE,
    check: () => ({ decision: "allow" as const }),
  } as unknown as PolicyService;
}

// ──────────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────────

interface Harness {
  tempDir: string;
  registry: RegistryService;
  eventLog: EventLogService;
  handlers: OctoGatewayHandlers;
  closeDb: () => void;
  armId: string;
}

let armCounter = 0;

function makeHarness(policyService: PolicyService): Harness {
  armCounter += 1;
  const armId = `policy-chaos-${Date.now()}-${armCounter}`;
  const tempDir = mkdtempSync(join(tmpdir(), "octo-chaos-m5-07-"));
  const dbPath = join(tempDir, "registry.sqlite");
  const eventLogPath = join(tempDir, "events.jsonl");
  const db = openOctoRegistry({ path: dbPath });
  const registry = new RegistryService(db);
  const eventLog = new EventLogService({ path: eventLogPath });
  const tmuxManager = new TmuxManager();

  const deps: OctoGatewayHandlerDeps = {
    registry,
    eventLog,
    tmuxManager,
    policyService,
    nodeId: "test-node-m5-07",
    now: () => Date.now(),
    generateArmId: () => armId,
  };
  const handlers = new OctoGatewayHandlers(deps);

  return {
    tempDir,
    registry,
    eventLog,
    handlers,
    closeDb: () => {
      try {
        closeOctoRegistry(db);
      } catch {
        // already closed
      }
    },
    armId,
  };
}

function makeArmSpec(cwd: string, overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-chaos-m5-07",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-chaos-m5-07",
    cwd,
    idempotency_key: `idem-m5-07-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runtime_options: {
      command: "sleep",
      args: ["300"],
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("Chaos: policy denied spawn (M5-07)", () => {
  let harness: Harness | null = null;

  afterEach(() => {
    if (harness !== null) {
      harness.closeDb();
      try {
        rmSync(harness.tempDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
      harness = null;
    }
  });

  it("denies arm spawn when policy returns deny verdict", async () => {
    const denyPolicy = makeDenyPolicy("tool X forbidden", "R-001");
    harness = makeHarness(denyPolicy);
    const { handlers, registry, armId } = harness;
    const cwd = mkdtempSync(join(tmpdir(), "chaos-policy-deny-"));

    const spec = makeArmSpec(cwd);

    // armSpawn must throw HandlerError with code "policy_denied"
    let caught: HandlerError | null = null;
    try {
      await handlers.armSpawn({
        idempotency_key: spec.idempotency_key,
        spec,
      });
    } catch (err) {
      if (err instanceof HandlerError) {
        caught = err;
      } else {
        throw err;
      }
    }

    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("policy_denied");
    expect(caught!.message).toContain("tool X forbidden");
    // ruleId is in the details object, not the message
    expect(caught!.details).toBeDefined();
    expect(caught!.details!["ruleId"]).toBe("R-001");
    expect(caught!.details!["reason"]).toBe("tool X forbidden");

    // No arm row created in registry
    const arm = registry.getArm(armId);
    expect(arm).toBeNull();

    // Registry listing must be empty for this arm
    const arms = registry.listArms();
    const matchingArms = arms.filter((a) => a.arm_id === armId);
    expect(matchingArms).toHaveLength(0);

    // Clean up temp
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // swallow
    }
  });

  it.skipIf(!TMUX_AVAILABLE)(
    "allows arm spawn when policy returns allow verdict",
    async () => {
      const allowPolicy = makeAllowPolicy();
      harness = makeHarness(allowPolicy);
      const { handlers, registry, armId } = harness;
      const cwd = mkdtempSync(join(tmpdir(), "chaos-policy-allow-"));

      const spec = makeArmSpec(cwd);

      const result = await handlers.armSpawn({
        idempotency_key: spec.idempotency_key,
        spec,
      });

      // Spawn succeeded
      expect(result.arm_id).toBe(armId);
      expect(result.session_ref).toBeDefined();

      // Arm row exists in registry
      const arm = registry.getArm(armId);
      expect(arm).not.toBeNull();
      expect(arm!.arm_id).toBe(armId);
      expect(arm!.node_id).toBe("test-node-m5-07");
      expect(arm!.mission_id).toBe("mission-chaos-m5-07");

      // Clean up tmux session
      const tmux = new TmuxManager();
      try {
        const sessions = await tmux.listSessions();
        for (const s of sessions) {
          if (s.includes(armId)) {
            await tmux.killSession(s);
          }
        }
      } catch {
        // best-effort
      }

      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // swallow
      }
    },
    30_000,
  );
});

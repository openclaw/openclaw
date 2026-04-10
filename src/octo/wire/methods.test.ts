// Octopus Orchestrator — Gateway WS method schema tests (M0-04)
//
// Covers:
//   - Every octo.* method has a valid canonical request/response pair
//   - Side-effecting methods reject requests missing idempotency_key
//   - Read-only methods do not require idempotency_key
//   - octo.arm.spawn reuses ArmSpecSchema directly (validated here via
//     a known-good ArmSpec fixture)
//   - OCTO_METHOD_REGISTRY is the single source of truth — if a method
//     is added, this test sweeps over all registered methods

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  OCTO_METHOD_NAMES,
  OCTO_METHOD_REGISTRY,
  OctoArmSpawnRequestSchema,
  OctoArmSpawnResponseSchema,
  OctoArmAttachRequestSchema,
  OctoArmAttachResponseSchema,
  OctoArmSendRequestSchema,
  OctoArmSendResponseSchema,
  OctoArmCheckpointRequestSchema,
  OctoArmCheckpointResponseSchema,
  OctoArmTerminateRequestSchema,
  OctoArmTerminateResponseSchema,
  OctoArmHealthRequestSchema,
  OctoArmHealthResponseSchema,
  OctoNodeCapabilitiesRequestSchema,
  OctoNodeCapabilitiesResponseSchema,
  OctoNodeReconcileRequestSchema,
  OctoNodeReconcileResponseSchema,
} from "./methods.ts";
import type { ArmSpec } from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Canonical ArmSpec fixture for octo.arm.spawn tests — kept minimal so
// the methods test stays focused on the wrapper shape rather than spec
// details (which are covered exhaustively in schema.test.ts).
// ──────────────────────────────────────────────────────────────────────────

function canonicalArmSpec(): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "m-test",
    adapter_type: "cli_exec",
    runtime_name: "claude-code",
    agent_id: "home",
    cwd: "/repos/test",
    idempotency_key: "arm-idem-0001",
    runtime_options: {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      structuredOutputFormat: "stream-json",
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// OCTO_METHOD_REGISTRY invariants
// ──────────────────────────────────────────────────────────────────────────

describe("OCTO_METHOD_REGISTRY", () => {
  it("lists all 8 required octo.* methods", () => {
    const expectedMethods = [
      "octo.arm.spawn",
      "octo.arm.attach",
      "octo.arm.send",
      "octo.arm.checkpoint",
      "octo.arm.terminate",
      "octo.arm.health",
      "octo.node.capabilities",
      "octo.node.reconcile",
    ] as const;
    expect(OCTO_METHOD_NAMES).toHaveLength(expectedMethods.length);
    for (const method of expectedMethods) {
      expect(OCTO_METHOD_NAMES).toContain(method);
    }
  });

  it("marks the five side-effecting methods correctly", () => {
    // Per LLD §Head ↔ Node Agent Wire Contract: spawn, send, checkpoint,
    // terminate, reconcile are side-effecting. attach, health, capabilities
    // are not.
    const sideEffectingMethods = OCTO_METHOD_NAMES.filter(
      (name) => OCTO_METHOD_REGISTRY[name].sideEffecting,
    );
    expect(sideEffectingMethods).toEqual(
      expect.arrayContaining([
        "octo.arm.spawn",
        "octo.arm.send",
        "octo.arm.checkpoint",
        "octo.arm.terminate",
        "octo.node.reconcile",
      ]),
    );
    expect(sideEffectingMethods).toHaveLength(5);
  });

  it("marks the three read-only methods correctly", () => {
    const readOnlyMethods = OCTO_METHOD_NAMES.filter(
      (name) => !OCTO_METHOD_REGISTRY[name].sideEffecting,
    );
    expect(readOnlyMethods).toEqual(
      expect.arrayContaining(["octo.arm.attach", "octo.arm.health", "octo.node.capabilities"]),
    );
    expect(readOnlyMethods).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.spawn — the load-bearing method that reuses ArmSpecSchema
// ──────────────────────────────────────────────────────────────────────────

describe("octo.arm.spawn", () => {
  it("accepts a canonical request with idempotency_key and ArmSpec", () => {
    const req = {
      idempotency_key: "req-spawn-0001",
      spec: canonicalArmSpec(),
    };
    expect(Value.Check(OctoArmSpawnRequestSchema, req)).toBe(true);
  });

  it("rejects a spawn request missing idempotency_key", () => {
    const req = { spec: canonicalArmSpec() };
    expect(Value.Check(OctoArmSpawnRequestSchema, req)).toBe(false);
  });

  it("rejects a spawn request missing spec", () => {
    const req = { idempotency_key: "req-spawn-0001" };
    expect(Value.Check(OctoArmSpawnRequestSchema, req)).toBe(false);
  });

  it("rejects a spawn request with an unknown top-level field", () => {
    const req = {
      idempotency_key: "req-spawn-0001",
      spec: canonicalArmSpec(),
      extra_field: true,
    };
    expect(Value.Check(OctoArmSpawnRequestSchema, req)).toBe(false);
  });

  it("rejects a spawn request with a malformed spec (bare schema catches it)", () => {
    const req = {
      idempotency_key: "req-spawn-0001",
      spec: { spec_version: 1 }, // missing all other required fields
    };
    expect(Value.Check(OctoArmSpawnRequestSchema, req)).toBe(false);
  });

  it("accepts a canonical response with arm_id and session_ref", () => {
    const res = {
      arm_id: "arm-0001",
      session_ref: {
        cwd: "/repos/test",
        structured_session_id: "subagent-abc",
      },
    };
    expect(Value.Check(OctoArmSpawnResponseSchema, res)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.attach (read-only)
// ──────────────────────────────────────────────────────────────────────────

describe("octo.arm.attach", () => {
  it("accepts an attach request without idempotency_key (read-only)", () => {
    const req = { arm_id: "arm-0001", include_history_bytes: 8192 };
    expect(Value.Check(OctoArmAttachRequestSchema, req)).toBe(true);
  });

  it("accepts an attach request with just arm_id", () => {
    const req = { arm_id: "arm-0001" };
    expect(Value.Check(OctoArmAttachRequestSchema, req)).toBe(true);
  });

  it("rejects an attach request missing arm_id", () => {
    const req = {};
    expect(Value.Check(OctoArmAttachRequestSchema, req)).toBe(false);
  });

  it("accepts an attach response with a tmux attach command", () => {
    const res = {
      arm_id: "arm-0001",
      attach_command: "tmux attach -t octo-arm-0001",
      session_ref: { cwd: "/repos/test", tmux_session_name: "octo-arm-0001" },
    };
    expect(Value.Check(OctoArmAttachResponseSchema, res)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.send
// ──────────────────────────────────────────────────────────────────────────

describe("octo.arm.send", () => {
  it("accepts a canonical message-kind send request", () => {
    const req = {
      idempotency_key: "send-0001",
      arm_id: "arm-0001",
      kind: "message" as const,
      payload: "follow up instruction",
    };
    expect(Value.Check(OctoArmSendRequestSchema, req)).toBe(true);
  });

  it("accepts a keys-kind send request (for PTY arms)", () => {
    const req = {
      idempotency_key: "send-0002",
      arm_id: "arm-0001",
      kind: "keys" as const,
      payload: "C-c",
    };
    expect(Value.Check(OctoArmSendRequestSchema, req)).toBe(true);
  });

  it("accepts a stdin-kind send request (for cli_exec arms)", () => {
    const req = {
      idempotency_key: "send-0003",
      arm_id: "arm-0001",
      kind: "stdin" as const,
      payload: "next-line\n",
    };
    expect(Value.Check(OctoArmSendRequestSchema, req)).toBe(true);
  });

  it("rejects a send request missing idempotency_key (side-effecting)", () => {
    const req = { arm_id: "arm-0001", kind: "message", payload: "x" };
    expect(Value.Check(OctoArmSendRequestSchema, req)).toBe(false);
  });

  it("rejects an invalid input kind literal", () => {
    const req = {
      idempotency_key: "send-bad",
      arm_id: "arm-0001",
      kind: "teletype" as unknown as "message",
      payload: "x",
    };
    expect(Value.Check(OctoArmSendRequestSchema, req)).toBe(false);
  });

  it("accepts a canonical send response", () => {
    const res = {
      arm_id: "arm-0001",
      delivered: true,
      bytes_written: 17,
    };
    expect(Value.Check(OctoArmSendResponseSchema, res)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.checkpoint
// ──────────────────────────────────────────────────────────────────────────

describe("octo.arm.checkpoint", () => {
  it("accepts a canonical checkpoint request", () => {
    const req = { idempotency_key: "ckpt-0001", arm_id: "arm-0001" };
    expect(Value.Check(OctoArmCheckpointRequestSchema, req)).toBe(true);
  });

  it("rejects a checkpoint request missing idempotency_key", () => {
    const req = { arm_id: "arm-0001" };
    expect(Value.Check(OctoArmCheckpointRequestSchema, req)).toBe(false);
  });

  it("accepts a canonical checkpoint response", () => {
    const res = {
      arm_id: "arm-0001",
      checkpoint_ref: "ckpt://arm-0001/20260409T170000Z",
      ts: 1775084400000,
    };
    expect(Value.Check(OctoArmCheckpointResponseSchema, res)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.terminate
// ──────────────────────────────────────────────────────────────────────────

describe("octo.arm.terminate", () => {
  it("accepts a canonical terminate request with reason", () => {
    const req = {
      idempotency_key: "term-0001",
      arm_id: "arm-0001",
      reason: "operator requested",
    };
    expect(Value.Check(OctoArmTerminateRequestSchema, req)).toBe(true);
  });

  it("accepts a force terminate request", () => {
    const req = {
      idempotency_key: "term-0002",
      arm_id: "arm-0001",
      reason: "stalled, SIGKILL",
      force: true,
    };
    expect(Value.Check(OctoArmTerminateRequestSchema, req)).toBe(true);
  });

  it("rejects a terminate request missing reason", () => {
    const req = { idempotency_key: "term-bad", arm_id: "arm-0001" };
    expect(Value.Check(OctoArmTerminateRequestSchema, req)).toBe(false);
  });

  it("rejects a terminate request missing idempotency_key", () => {
    const req = { arm_id: "arm-0001", reason: "test" };
    expect(Value.Check(OctoArmTerminateRequestSchema, req)).toBe(false);
  });

  it("accepts a canonical terminate response", () => {
    const res = {
      arm_id: "arm-0001",
      terminated: true,
      final_status: "terminated" as const,
    };
    expect(Value.Check(OctoArmTerminateResponseSchema, res)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.health (read-only)
// ──────────────────────────────────────────────────────────────────────────

describe("octo.arm.health", () => {
  it("accepts a health request without idempotency_key", () => {
    expect(Value.Check(OctoArmHealthRequestSchema, { arm_id: "arm-0001" })).toBe(true);
  });

  it("accepts a canonical health response", () => {
    const res = {
      arm_id: "arm-0001",
      status: "active" as const,
      last_progress_tick_ts: 1775084400000,
      last_lease_renewal_ts: 1775084395000,
      restart_count: 0,
    };
    expect(Value.Check(OctoArmHealthResponseSchema, res)).toBe(true);
  });

  it("rejects a health response with an invalid status literal", () => {
    const res = {
      arm_id: "arm-0001",
      status: "feeling-fine" as unknown as "active",
      restart_count: 0,
    };
    expect(Value.Check(OctoArmHealthResponseSchema, res)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.node.capabilities (read-only)
// ──────────────────────────────────────────────────────────────────────────

describe("octo.node.capabilities", () => {
  it("accepts a capabilities request with an optional node_id", () => {
    expect(Value.Check(OctoNodeCapabilitiesRequestSchema, { node_id: "laptop-01" })).toBe(true);
  });

  it("accepts a capabilities request without node_id (self)", () => {
    expect(Value.Check(OctoNodeCapabilitiesRequestSchema, {})).toBe(true);
  });

  it("accepts a canonical capabilities response", () => {
    const res = {
      node_id: "laptop-01",
      agent_id: "home",
      capabilities: [
        "runtime.subagent",
        "runtime.cli_exec",
        "runtime.pty_tmux",
        "os.darwin",
        "os.arch.arm64",
        "tool.git",
        "tool.tmux",
        "net.internet",
      ],
      capacity: { max_arms: 8, current_arms: 2, cpu_weight_budget: 16 },
    };
    expect(Value.Check(OctoNodeCapabilitiesResponseSchema, res)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// octo.node.reconcile
// ──────────────────────────────────────────────────────────────────────────

describe("octo.node.reconcile", () => {
  it("accepts a canonical reconcile request", () => {
    const req = {
      idempotency_key: "recon-0001",
      node_id: "laptop-01",
      dry_run: false,
    };
    expect(Value.Check(OctoNodeReconcileRequestSchema, req)).toBe(true);
  });

  it("accepts a reconcile request without optional fields (self, non-dry-run)", () => {
    const req = { idempotency_key: "recon-0002" };
    expect(Value.Check(OctoNodeReconcileRequestSchema, req)).toBe(true);
  });

  it("rejects a reconcile request missing idempotency_key (side-effecting)", () => {
    const req = { node_id: "laptop-01" };
    expect(Value.Check(OctoNodeReconcileRequestSchema, req)).toBe(false);
  });

  it("accepts a canonical reconcile response", () => {
    const res = {
      node_id: "laptop-01",
      reconciled_count: 3,
      anomaly_count: 0,
      ts: 1775084400000,
    };
    expect(Value.Check(OctoNodeReconcileResponseSchema, res)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-method idempotency discipline sweep
//
// Parameterized test that iterates over every method in the registry and
// asserts: side-effecting methods REJECT requests that lack an
// idempotency_key, and read-only methods do NOT require one. This is the
// test that will catch any future method addition that forgets the
// idempotency_key discipline.
// ──────────────────────────────────────────────────────────────────────────

describe("idempotency_key discipline sweep", () => {
  // Minimal valid request shapes for every method, used only for
  // construction — each method-specific describe block above is the
  // source of truth for full coverage.
  const minimalRequests: Record<string, Record<string, unknown>> = {
    "octo.arm.spawn": {
      idempotency_key: "k",
      spec: canonicalArmSpec(),
    },
    "octo.arm.attach": { arm_id: "arm-0001" },
    "octo.arm.send": {
      idempotency_key: "k",
      arm_id: "arm-0001",
      kind: "message",
      payload: "x",
    },
    "octo.arm.checkpoint": { idempotency_key: "k", arm_id: "arm-0001" },
    "octo.arm.terminate": {
      idempotency_key: "k",
      arm_id: "arm-0001",
      reason: "test",
    },
    "octo.arm.health": { arm_id: "arm-0001" },
    "octo.node.capabilities": {},
    "octo.node.reconcile": { idempotency_key: "k" },
  };

  for (const methodName of OCTO_METHOD_NAMES) {
    const entry = OCTO_METHOD_REGISTRY[methodName];
    const minimalReq = minimalRequests[methodName];

    it(`${methodName}: minimal valid request passes`, () => {
      expect(Value.Check(entry.request, minimalReq)).toBe(true);
    });

    if (entry.sideEffecting) {
      it(`${methodName}: rejects request missing idempotency_key`, () => {
        const { idempotency_key: _removed, ...withoutKey } = minimalReq;
        expect(Value.Check(entry.request, withoutKey)).toBe(false);
      });
    }
  }
});

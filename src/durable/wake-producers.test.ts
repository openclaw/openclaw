import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import { recordDurableWakeObligation } from "./wake-producers.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-wake-producers-"));
  const store = openDurableRuntimeSqliteStore({
    path: path.join(dir, "openclaw.sqlite"),
  });
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") {
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("durable wake producers", () => {
  it("creates idempotent wake obligations from resolved owner and report-route facts", () => {
    const { store, cleanup } = tempStore();
    try {
      const first = recordDurableWakeObligation({
        store,
        reason: "child_terminal",
        dedupeKey: "wake:test:resolved-owner",
        sourceRunId: "run_child",
        factsRef: "facts:child-terminal",
        facts: {
          sourceRunId: "run_child",
          delegations: [
            {
              kind: "subagent_child",
              parent: {
                kind: "agent_session",
                ref: "agent:parent:session",
                ownerKind: "agent_session",
                ownerRef: "agent:parent:session",
                reportRouteRef: "discord:thread:parent",
              },
            },
          ],
        },
        evidence: { kind: "test_child_terminal", childRuntimeRunId: "run_child" },
        now: 100,
      });
      const duplicate = recordDurableWakeObligation({
        store,
        reason: "child_terminal",
        dedupeKey: "wake:test:resolved-owner",
        sourceRunId: "run_child",
        facts: {},
        now: 200,
      });

      expect(duplicate.wakeId).toBe(first.wakeId);
      expect(store.listDurableWakes({ status: "pending" })).toEqual([
        expect.objectContaining({
          wakeId: first.wakeId,
          targetKind: "agent_session",
          targetRef: "agent:parent:session",
          ownerKind: "agent_session",
          ownerRef: "agent:parent:session",
          reportRouteRef: "discord:thread:parent",
          targetResolutionStatus: "resolved",
          targetResolutionReason: "delegation_subagent_child",
          dedupeKey: "wake:test:resolved-owner",
          sourceRunId: "run_child",
          factsRef: "facts:child-terminal",
          metadata: expect.objectContaining({
            producer: "durable_wake_producer",
            evidence: expect.objectContaining({
              kind: "test_child_terminal",
            }),
          }),
        }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("turns ambiguous recorded owners into an operator inspection obligation", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = recordDurableWakeObligation({
        store,
        reason: "delivery_unknown",
        dedupeKey: "wake:test:ambiguous-owner",
        facts: {
          explicitWorkOwners: [
            {
              kind: "agent_session",
              ref: "agent:owner:a",
              ownerKind: "agent_session",
              ownerRef: "agent:owner:a",
            },
            {
              kind: "agent_session",
              ref: "agent:owner:b",
              ownerKind: "agent_session",
              ownerRef: "agent:owner:b",
            },
          ],
        },
        evidence: { kind: "ambiguous_delivery_fact" },
        now: 100,
      });

      expect(wake).toMatchObject({
        targetKind: "operator",
        targetRef: "operator",
        ownerKind: "operator",
        ownerRef: "operator",
        targetResolutionStatus: "ambiguous",
        targetResolutionReason: "explicit_work_owner_ambiguous",
        reason: "delivery_unknown",
        status: "pending",
      });
      expect(store.listDurableWakes({ targetResolutionStatus: "ambiguous" })).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("turns missing recorded owners into an operator inspection obligation", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = recordDurableWakeObligation({
        store,
        reason: "no_handler",
        dedupeKey: "wake:test:missing-owner",
        facts: {
          explicitWorkOwners: [
            {
              kind: "agent_session",
              ref: "agent:missing:session",
              ownerKind: "agent_session",
              ownerRef: "agent:missing:session",
              live: false,
            },
          ],
        },
        evidence: { kind: "missing_parent_fact" },
        now: 100,
      });

      expect(wake).toMatchObject({
        targetKind: "operator",
        targetRef: "operator",
        ownerKind: "operator",
        ownerRef: "operator",
        targetResolutionStatus: "missing",
        targetResolutionReason: "explicit_work_owner_missing",
        reason: "no_handler",
        status: "pending",
      });
    } finally {
      cleanup();
    }
  });

  it("does not produce autonomous policy fields or actions", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = recordDurableWakeObligation({
        store,
        reason: "side_effect_uncertain",
        dedupeKey: "wake:test:no-policy",
        sourceRunId: "run_uncertain",
        facts: {
          sourceRunId: "run_uncertain",
        },
        evidence: {
          kind: "side_effect_uncertain",
          runtimeRunId: "run_uncertain",
          stepId: "tool_step",
        },
        now: 100,
      });
      const keys = collectKeys(wake);

      expect(keys).not.toContain("nextAction");
      expect(keys).not.toContain("safeRecoveryActions");
      expect(keys).not.toContain("retry");
      expect(keys).not.toContain("resume");
      expect(keys).not.toContain("abandon");
      expect(keys).not.toContain("createNew");
      expect(wake.metadata).toMatchObject({
        producer: "durable_wake_producer",
        evidence: {
          kind: "side_effect_uncertain",
        },
      });
    } finally {
      cleanup();
    }
  });
});

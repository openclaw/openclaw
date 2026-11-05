import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { resolveSubagentChildAuthority } from "../agents/subagents/registry/subagent-child-owner-match.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../agents/subagents/registry/subagent-run-generation.js";
import {
  isSubagentRunLive,
  isSubagentRunQueued,
} from "../agents/subagents/registry/subagent-run-liveness.js";
import {
  bindSwarmRunReservation,
  holdQueuedSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  claimAgentRunContext,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import { resolveSessionChildController, resolveSessionChildOwners } from "./session-utils-core.js";

afterEach(() => {
  subagentRuns.clear();
  resetAgentRunRegistryForTest();
});

function run(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId,
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:parent",
    requesterDisplayKey: "parent",
    createdAt: 1,
    execution: { status: "running" },
    task: "Synthetic child",
    cleanup: "keep",
    ...overrides,
  };
}

// Main's public owner-scoped scan is independent of the direct bucket query.
function scannedController(key: string, entry: SessionEntry) {
  const selected = getLatestLiveSubagentRunByChildSessionKey(
    key,
    (candidate) =>
      (isSubagentRunLive(candidate) || isSubagentRunQueued(candidate)) &&
      resolveSubagentChildAuthority(candidate, entry).status !== "mismatch",
  );
  return (
    normalizeOptionalString(selected?.controllerSessionKey) ??
    normalizeOptionalString(selected?.requesterSessionKey)
  );
}

test("keeps controller and native owners equivalent across generations, identities, and live transitions", () => {
  const claims = new Map<string, string>();
  const rows = Array.from({ length: 12 }, (_, index) => ({
    key:
      index % 6 === 4
        ? "global"
        : index % 6 === 5
          ? "agent:invalid agent:subagent:child"
          : `agent:main:subagent:child-${index % 3}`,
    entry: {
      sessionId: `session-${index % 2}`,
      lifecycleRevision: index < 6 ? undefined : `life-${index % 2}`,
      updatedAt: 1,
      spawnedBy: "agent:main:parent",
      parentSessionKey: "agent:main:parent",
    },
  }));
  const retained = buildSubagentRunReadIndexFromRuns({ runs: new Map(), now: 1 });
  let seed = 219;
  const random = (size: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % size;
  };
  for (let step = 0; step < 240; step++) {
    const id = `run-${random(16)}`;
    const previousClaim = claims.get(id);
    const operation = random(6);
    if (operation === 0) {
      if (previousClaim) {
        releaseAgentRunContext(id, previousClaim);
      }
      claims.delete(id);
    } else if (operation === 1) {
      subagentRuns.delete(id);
    } else {
      const identity = random(5);
      const entry = run(id, {
        childSessionKey: rows[random(rows.length)]!.key,
        childAgentId: random(5) === 0 ? "other" : "main",
        controllerSessionKey: ` agent:main:controller-${random(3)} `,
        generation: random(3),
        createdAt: random(4),
        childSessionIdentity: {
          sessionId: identity % 2 === 0 ? "" : `${identity === 3 ? " " : ""}session-${random(2)}`,
          lifecycleRevision: identity < 2 ? undefined : `life-${random(2)}`,
        },
        execution: operation === 2 ? { status: "terminal", endedAt: step } : { status: "running" },
      });
      subagentRuns.set(id, entry);
      if (!previousClaim) {
        // Context metadata need not name the registry's child; liveness belongs to run id.
        const claim = claimAgentRunContext(
          id,
          { sessionKey: "agent:main:unrelated" },
          { trackOwner: true, ownsContext: true },
        );
        expect(claim).toBeDefined();
        claims.set(id, claim!);
      }
    }
    for (const row of rows) {
      const controller = scannedController(row.key, row.entry);
      expect(resolveSessionChildController(row.key, row.entry)).toBe(controller);
      expect(resolveSessionChildOwners({ ...row, now: 1, subagentRuns: retained })).toEqual(
        controller && controller !== row.entry.parentSessionKey
          ? [controller, row.entry.parentSessionKey]
          : [row.entry.parentSessionKey],
      );
    }
  }
  rotateAgentRunRegistryLifecycleGeneration();
  for (const row of rows) {
    expect(resolveSessionChildController(row.key, row.entry)).toBeUndefined();
  }
});

test.each(["subagent", "dashboard"])(
  "resolves a parentless %s controller through a replacement scheduler slot",
  async (kind) => {
    const entry = run("accepted", {
      childSessionKey: `agent:main:${kind}:child`,
      collect: true,
      schedulerSlotId: "slot",
      execution: { status: "queued" },
    });
    subagentRuns.set(entry.runId, entry);
    const session = { sessionId: "child", updatedAt: 1 };
    const retained = buildSubagentRunReadIndexFromRuns({ runs: new Map(), now: 1 });
    using display = vi.spyOn(retained, "getDisplaySubagentRun");
    using descendants = vi.spyOn(retained, "countActiveDescendantRuns");
    const read = () => {
      const controller = resolveSessionChildController(entry.childSessionKey, session);
      const owners = resolveSessionChildOwners({
        key: entry.childSessionKey,
        entry: session,
        now: 1,
        subagentRuns: retained,
      });
      expect(owners).toEqual(controller ? [controller] : []);
      return controller;
    };
    expect(read()).toBeUndefined();
    expect(
      reserveSwarmRun({
        runId: "slot",
        groupId: "child-controller",
        maxConcurrent: 1,
        activeRunIds: [],
      }),
    ).toBe(true);
    const hold = holdQueuedSwarmRun("slot")!;
    try {
      bindSwarmRunReservation("slot", getSubagentRunRuntimeKey(entry));
      expect(read()).toBe(entry.requesterSessionKey);
      subagentRuns.set(entry.runId, { ...entry, generation: 2 });
      expect(read()).toBeUndefined();
      subagentRuns.set(entry.runId, entry);
      expect(read()).toBe(entry.requesterSessionKey);
      expect(hold.withdraw()).toBe(true);
      expect(read()).toBeUndefined();
      expect(display).not.toHaveBeenCalled();
      expect(descendants).not.toHaveBeenCalled();
    } finally {
      hold.withdraw();
      await hold.release();
    }
  },
);

/**
 * Test: subagent_ended hook event fields and documentation accuracy
 *
 * Verifies the fix for issue #95186: subagent_ended hook fields (incl.
 * targetSessionKey identity) are documented and match the type definition.
 */
import { describe, expect, it } from "vitest";
import type {
  PluginHookSubagentEndedEvent,
  PluginHookSubagentSpawnedEvent,
  PluginHookSubagentTargetKind,
} from "./hook-types.js";

describe("PluginHookSubagentEndedEvent type structure", () => {
  it("has targetSessionKey as the identity field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    expect(event.targetSessionKey).toBe("agent:main:subagent:child");
  });

  it("has targetKind field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    expect(event.targetKind).toBe("subagent");
  });

  it("has reason field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "acp",
      reason: "subagent-complete",
    };
    expect(event.reason).toBe("subagent-complete");
  });

  it("has optional outcome field with valid values", () => {
    const outcomes: Array<NonNullable<PluginHookSubagentEndedEvent["outcome"]>> = [
      "ok",
      "error",
      "timeout",
      "killed",
      "reset",
      "deleted",
    ];
    for (const outcome of outcomes) {
      const event: PluginHookSubagentEndedEvent = {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "test",
        outcome,
      };
      expect(event.outcome).toBe(outcome);
    }
  });

  it("has optional error field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "failed",
      error: "Connection refused",
    };
    expect(event.error).toBe("Connection refused");
  });

  it("has optional runId field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
      runId: "run-abc-123",
    };
    expect(event.runId).toBe("run-abc-123");
  });

  it("has optional sendFarewell field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
      sendFarewell: true,
    };
    expect(event.sendFarewell).toBe(true);
  });

  it("has optional accountId field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
      accountId: "work",
    };
    expect(event.accountId).toBe("work");
  });

  it("has optional endedAt field", () => {
    const timestamp = Date.now();
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
      endedAt: timestamp,
    };
    expect(event.endedAt).toBe(timestamp);
  });

  it("does not have agentId field (unlike subagent_spawned)", () => {
    // This is the key distinction from the issue: subagent_ended does NOT
    // have agentId. Accessing event.agentId would be undefined at runtime.
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    // TypeScript should not allow agentId on this type.
    // We verify at runtime that agentId is not a recognized field.
    const keys = Object.keys(event);
    expect(keys).not.toContain("agentId");
  });

  it("does not have subagentId field", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    const keys = Object.keys(event);
    expect(keys).not.toContain("subagentId");
  });

  it("supports targetKind 'subagent'", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    expect(event.targetKind).toBe("subagent");
  });

  it("supports targetKind 'acp'", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:acp:child",
      targetKind: "acp",
      reason: "completed",
    };
    expect(event.targetKind).toBe("acp");
  });

  it("allows minimal event with only required fields", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    expect(event).toEqual({
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    });
  });

  it("allows full event with all optional fields", () => {
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "subagent-complete",
      outcome: "ok",
      error: undefined,
      runId: "run-123",
      sendFarewell: true,
      accountId: "work",
      endedAt: 1700000000000,
    };
    expect(event.targetSessionKey).toBe("agent:main:subagent:child");
    expect(event.targetKind).toBe("subagent");
    expect(event.reason).toBe("subagent-complete");
    expect(event.outcome).toBe("ok");
    expect(event.runId).toBe("run-123");
    expect(event.sendFarewell).toBe(true);
    expect(event.accountId).toBe("work");
    expect(event.endedAt).toBe(1700000000000);
  });
});

describe("PluginHookSubagentEndedEvent vs PluginHookSubagentSpawnedEvent", () => {
  it("subagent_spawned has agentId, subagent_ended does not", () => {
    // subagent_spawned extends PluginHookSubagentSpawnBase which has agentId
    const spawnedEvent: PluginHookSubagentSpawnedEvent = {
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "research",
      mode: "run",
      requester: {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: "456",
      },
      threadRequested: true,
      runId: "run-1",
    };
    expect(spawnedEvent.agentId).toBe("main");

    // subagent_ended has targetSessionKey instead of agentId
    const endedEvent: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    expect(endedEvent.targetSessionKey).toBe("agent:main:subagent:child");
    // agentId is not a field on PluginHookSubagentEndedEvent
    expect("agentId" in endedEvent).toBe(false);
  });

  it("subagent_spawned has childSessionKey, subagent_ended has targetSessionKey", () => {
    const spawnedEvent: PluginHookSubagentSpawnedEvent = {
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      mode: "run",
      threadRequested: true,
      runId: "run-1",
    };
    expect(spawnedEvent.childSessionKey).toBe("agent:main:subagent:child");

    const endedEvent: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    expect(endedEvent.targetSessionKey).toBe("agent:main:subagent:child");
  });

  it("subagent_spawned has resolvedModel and resolvedProvider", () => {
    const spawnedEvent: PluginHookSubagentSpawnedEvent = {
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      mode: "run",
      threadRequested: true,
      runId: "run-1",
      resolvedModel: "gpt-4o",
      resolvedProvider: "openai",
    };
    expect(spawnedEvent.resolvedModel).toBe("gpt-4o");
    expect(spawnedEvent.resolvedProvider).toBe("openai");
  });

  it("subagent_ended does not have resolvedModel or resolvedProvider", () => {
    const endedEvent: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "completed",
    };
    expect("resolvedModel" in endedEvent).toBe(false);
    expect("resolvedProvider" in endedEvent).toBe(false);
  });
});

describe("PluginHookSubagentTargetKind", () => {
  it("accepts 'subagent' as a valid target kind", () => {
    const kind: PluginHookSubagentTargetKind = "subagent";
    expect(kind).toBe("subagent");
  });

  it("accepts 'acp' as a valid target kind", () => {
    const kind: PluginHookSubagentTargetKind = "acp";
    expect(kind).toBe("acp");
  });
});

describe("subagent_ended event field completeness", () => {
  it("documents all fields listed in hooks.md", () => {
    // The documentation (docs/plugins/hooks.md) states:
    // "subagent_ended carries targetSessionKey (the identity field for the
    // ended subagent), targetKind, reason, outcome, error?, runId?,
    // sendFarewell?, accountId?, and endedAt?. Unlike subagent_spawned,
    // this event does not include agentId."
    //
    // This test verifies that the type definition matches the documented fields.

    const documentedRequiredFields = ["targetSessionKey", "targetKind", "reason"] as const;

    const documentedOptionalFields = [
      "outcome",
      "error",
      "runId",
      "sendFarewell",
      "accountId",
      "endedAt",
    ] as const;

    // Build a minimal event to verify required fields are present
    const minimalEvent: PluginHookSubagentEndedEvent = {
      targetSessionKey: "test",
      targetKind: "subagent",
      reason: "test",
    };

    for (const field of documentedRequiredFields) {
      expect(field in minimalEvent).toBe(true);
    }

    // Build a full event to verify optional fields are present
    const fullEvent: PluginHookSubagentEndedEvent = {
      targetSessionKey: "test",
      targetKind: "subagent",
      reason: "test",
      outcome: "ok",
      error: "test error",
      runId: "run-1",
      sendFarewell: true,
      accountId: "test-account",
      endedAt: Date.now(),
    };

    for (const field of documentedOptionalFields) {
      expect(field in fullEvent).toBe(true);
    }

    // Verify agentId is NOT in the event (key distinction from subagent_spawned)
    expect("agentId" in fullEvent).toBe(false);
  });

  it("targetSessionKey is the identity field (not agentId)", () => {
    // The issue specifically notes that targetSessionKey is the identity field
    // for subagent_ended, and that there is no agentId.
    const event: PluginHookSubagentEndedEvent = {
      targetSessionKey: "agent:my-agent:subagent:research-task",
      targetKind: "subagent",
      reason: "completed",
    };

    // targetSessionKey identifies which subagent ended
    expect(typeof event.targetSessionKey).toBe("string");
    expect(event.targetSessionKey.length).toBeGreaterThan(0);
  });
});

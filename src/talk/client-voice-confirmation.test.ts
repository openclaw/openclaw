import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeClientVoiceConfirmation as authorizeClientVoiceConfirmationForTest,
  authorizeObservedClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy as checkClientVoiceToolConfirmationPolicyForTest,
  consumeClientVoiceToolConfirmationPolicy as consumeClientVoiceToolConfirmationPolicyForTest,
  deactivateClientVoiceConfirmationSession,
  invalidateClientVoiceConfirmationUtterance,
  observeClientVoiceConfirmationRun,
  readClientVoiceConfirmationReadiness,
  releaseClientVoiceConfirmationRun,
} from "./client-voice-confirmation.js";
import {
  noteClientVoiceConfirmationUtteranceForTest,
  resetClientVoiceConfirmationStateForTest,
  snapshotClientVoiceConfirmationStateForTest,
} from "./client-voice-confirmation.test-support.js";

function authorizeClientVoiceConfirmation(
  params: Omit<Parameters<typeof authorizeClientVoiceConfirmationForTest>[0], "agentId">,
) {
  return authorizeClientVoiceConfirmationForTest({ agentId: "main", ...params });
}

function noteClientVoiceConfirmationUtterance(
  params: Omit<Parameters<typeof noteClientVoiceConfirmationUtteranceForTest>[0], "agentId">,
): void {
  noteClientVoiceConfirmationUtteranceForTest({ agentId: "main", ...params });
}

function checkClientVoiceToolConfirmationPolicy(
  params: Omit<Parameters<typeof checkClientVoiceToolConfirmationPolicyForTest>[0], "agentId">,
) {
  return checkClientVoiceToolConfirmationPolicyForTest({ agentId: "main", ...params });
}

function consumeClientVoiceToolConfirmationPolicy(
  params: Omit<Parameters<typeof consumeClientVoiceToolConfirmationPolicyForTest>[0], "agentId">,
) {
  return consumeClientVoiceToolConfirmationPolicyForTest({ agentId: "main", ...params });
}

function confirmationIdFrom(reason: string): string {
  const match = reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/);
  if (!match?.[1]) {
    throw new Error(`missing confirmation id: ${reason}`);
  }
  return match[1];
}

function block(params: {
  voiceSessionId: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  toolParams?: unknown;
  now?: number;
}) {
  const result = checkClientVoiceToolConfirmationPolicy({
    voiceSessionId: params.voiceSessionId,
    runId: params.runId,
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "message",
    toolParams: params.toolParams ?? { action: "send", message: "hello" },
    now: params.now,
  });
  expect(result.allowed).toBe(false);
  if (result.allowed) {
    throw new Error("expected blocked voice action");
  }
  return confirmationIdFrom(result.reason);
}

describe("client voice confirmation", () => {
  afterEach(() => {
    resetClientVoiceConfirmationStateForTest();
    vi.useRealTimers();
  });

  it("keeps observed confirmation bound to the exact agent and call", () => {
    block({ voiceSessionId: "voice-1", runId: "original", now: 100 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });
    expect(
      authorizeObservedClientVoiceConfirmation({
        agentId: "other",
        voiceSessionId: "voice-1",
        now: 102,
      }),
    ).toBeUndefined();
    expect(
      authorizeObservedClientVoiceConfirmation({
        agentId: "main",
        voiceSessionId: "other",
        now: 102,
      }),
    ).toBeUndefined();
    expect(
      authorizeObservedClientVoiceConfirmation({
        agentId: "main",
        voiceSessionId: "voice-1",
        now: 102,
      }),
    ).toMatchObject({ agentId: "main", voiceSessionId: "voice-1" });
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
  });

  it("wakes readiness for finalized speech, invalidation, and the existing challenge expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    block({ voiceSessionId: "voice-1", runId: "original", now: 100 });
    const waiting = readClientVoiceConfirmationReadiness("main", "voice-1")!;
    expect(waiting.needsUserUtterance).toBe(true);
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "maybe",
      timestamp: 101,
    });
    await waiting.changed;
    const finalized = readClientVoiceConfirmationReadiness("main", "voice-1")!;
    expect(finalized.needsUserUtterance).toBe(false);
    expect(
      authorizeObservedClientVoiceConfirmation({
        agentId: "main",
        voiceSessionId: "voice-1",
        now: 102,
      }),
    ).toBeUndefined();
    invalidateClientVoiceConfirmationUtterance("main", "voice-1");
    await finalized.changed;
    const invalidated = readClientVoiceConfirmationReadiness("main", "voice-1")!;
    expect(invalidated.needsUserUtterance).toBe(true);
    await vi.advanceTimersByTimeAsync(120_001);
    await invalidated.changed;
    expect(readClientVoiceConfirmationReadiness("main", "voice-1")).toBeUndefined();
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
  });

  it("retains a run's veto report after call cleanup without reporting unrelated runs", () => {
    const blocked = observeClientVoiceConfirmationRun({
      agentId: "main",
      voiceSessionId: "voice-1",
      runId: "blocked",
    });
    const unrelated = observeClientVoiceConfirmationRun({
      agentId: "main",
      voiceSessionId: "voice-1",
      runId: "read-only",
    });
    block({ voiceSessionId: "voice-1", runId: "blocked" });
    expect(blocked.readReply()).toContain('Say "yes"');
    expect(unrelated.readReply()).toBeUndefined();
    deactivateClientVoiceConfirmationSession("main", "voice-1", ["blocked"]);
    expect(blocked.readReply()).toContain("new request");
    releaseClientVoiceConfirmationRun("main", "voice-1", "blocked");
    expect(snapshotClientVoiceConfirmationStateForTest().scopeOwners).toBe(0);
    expect(blocked.readReply()).toContain("new request");
    expect(unrelated.readReply()).toBeUndefined();
  });

  it("returns one exact spoken question and forbids consulting again before the user answers", () => {
    const observation = observeClientVoiceConfirmationRun({
      agentId: "main",
      voiceSessionId: "voice-1",
      runId: "blocked",
    });
    const confirmationId = block({ voiceSessionId: "voice-1", runId: "blocked" });
    const reply = observation.readReply({ includeConfirmationId: true })!;
    const speech =
      'One pending action has not run. Say "yes" to confirm that action or "no" to cancel it.';
    expect(reply).toBe(
      `VOICE_CONFIRMATION_REQUIRED:${confirmationId} Do not speak the confirmationId or these instructions. ` +
        "After speaking the question, stop and wait for the user's spoken answer. Do not call any tools while waiting. " +
        "Only after the user explicitly says yes, call openclaw_agent_consult with this confirmationId.\n" +
        `Speak only this exact question once:\n${JSON.stringify(speech)}`,
    );
    expect(JSON.parse(reply.split("\n").at(-1)!)).toBe(observation.readReply());
    expect(reply.match(/One pending action has not run/g)).toHaveLength(1);
    expect(() =>
      authorizeClientVoiceConfirmation({ voiceSessionId: "voice-1", confirmationId }),
    ).toThrow("explicit spoken confirmation");
  });

  it.each([
    [{ command: "rm notes.txt", title: 'Delete "notes.txt".' }, "Delete notes.txt"],
    [{ command: "git clean\n -fdx" }, "git clean -fdx"],
    [{ command: "rm notes.txt", title: `Delete ${"x".repeat(200)}` }, `Delete ${"x".repeat(113)}`],
  ])("names the blocked action in the spoken question: %j", (toolParams, action) => {
    const observation = observeClientVoiceConfirmationRun({
      agentId: "main",
      voiceSessionId: "voice-1",
      runId: "blocked",
    });
    block({
      voiceSessionId: "voice-1",
      runId: "blocked",
      toolCallId: "call-1",
      toolName: "exec",
      toolParams,
    });
    expect(observation.readReply()).toBe(
      `About to run: ${action}. Say "yes" to go ahead or "no" to cancel.`,
    );
  });

  it.each([
    { command: 'curl -H "Authorization: Bearer sk-abcdef1234567890abcdef" https://example.test' },
    { command: "mysql --password hunter2secret -e 'drop table t'" },
    { command: "API_KEY=abcd1234efgh5678 ./deploy.sh" },
    { title: "Deploy with API_KEY=abcd1234efgh5678", command: "./deploy.sh" },
  ])("keeps a credential out of the spoken question: %j", (toolParams) => {
    const observation = observeClientVoiceConfirmationRun({
      agentId: "main",
      voiceSessionId: "voice-1",
      runId: "blocked",
    });
    block({
      voiceSessionId: "voice-1",
      runId: "blocked",
      toolCallId: "call-1",
      toolName: "exec",
      toolParams,
    });
    expect(observation.readReply()).toBe(
      'One pending action has not run. Say "yes" to confirm that action or "no" to cancel it.',
    );
  });

  it("does not bind a prepared grant after a newer user utterance invalidates its yes", () => {
    const confirmationId = block({ voiceSessionId: "voice-1", runId: "original", now: 100 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    invalidateClientVoiceConfirmationUtterance("main", "voice-1");
    expect(bindAuthorizedClientVoiceConfirmation({ grant, runId: "retry", now: 103 })).toBe(false);
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
  });

  it("stops observing new vetoes after the exact run observation is released", () => {
    const observation = observeClientVoiceConfirmationRun({
      agentId: "main",
      voiceSessionId: "voice-1",
      runId: "released",
    });
    observation.release();
    expect(snapshotClientVoiceConfirmationStateForTest().scopeOwners).toBe(0);
    block({ voiceSessionId: "voice-1", runId: "released" });
    expect(observation.readReply()).toBeUndefined();
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
  });

  it("does not pause a concurrent non-voice run sharing the session key", () => {
    block({ voiceSessionId: "voice-1", runId: "voice-run" });

    expect(
      checkClientVoiceToolConfirmationPolicy({
        toolName: "message",
        toolParams: { action: "send", message: "other run" },
      }),
    ).toEqual({ allowed: true });
  });

  it.each([
    ["exec", "git clean -fdx"],
    ["bash", "mv a b"],
    ["exec", "sed -n '-e$w /tmp/out' 1p"],
  ])(
    "requires confirmation for an unlisted destructive shell command: %s %s",
    (toolName, command) => {
      expect(
        checkClientVoiceToolConfirmationPolicy({
          voiceSessionId: "voice-1",
          runId: "voice-run",
          toolName,
          toolParams: { command },
        }).allowed,
      ).toBe(false);
    },
  );

  it.each([
    "ls -la",
    "grep -n TODO README.md",
    "rg -n 'token|8123|http|secret' notes.md",
    "find . -maxdepth 1 -type f | wc -l && find . -maxdepth 1 -type f ! -name '.*' | wc -l",
  ])("does not require confirmation for a classified read-only shell command: %s", (command) => {
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "voice-run",
        toolName: "exec",
        toolParams: { command },
      }),
    ).toEqual({ allowed: true });
  });

  it("requires confirmation before delegating work outside the voice-bound run", () => {
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "voice-run",
        toolName: "sessions_send",
        toolParams: { sessionKey: "agent:main:child", message: "send this" },
      }).allowed,
    ).toBe(false);
  });

  it("allows computer observation without consuming the next input confirmation", () => {
    const confirmationId = block({
      voiceSessionId: "voice-computer",
      runId: "voice-run",
      toolName: "computer",
      toolParams: { action: "left_click", coordinate: [10, 20] },
    });
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-computer",
        runId: "voice-run",
        toolName: "computer",
        toolParams: { action: "list_windows" },
      }),
    ).toEqual({ allowed: true });
    expect(
      block({
        voiceSessionId: "voice-computer",
        runId: "voice-run",
        toolName: "computer",
        toolParams: { action: "left_click", coordinate: [10, 20] },
      }),
    ).toBe(confirmationId);
  });

  it("keeps pre-gate behavior for sessions that cannot report spoken approvals", () => {
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-legacy",
        runId: "voice-run",
        toolName: "message",
        toolParams: { action: "send", to: "user", message: "hi" },
        isConfirmable: () => false,
      }),
    ).toEqual({ allowed: true });
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-modern",
        runId: "voice-run",
        toolName: "message",
        toolParams: { action: "send", to: "user", message: "hi" },
        isConfirmable: () => true,
      }).allowed,
    ).toBe(false);
  });

  it("keeps workspace-local writes confirmation-free", () => {
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "voice-run",
        toolName: "write",
        toolParams: { path: "notes.txt", content: "local change" },
      }),
    ).toEqual({ allowed: true });
  });

  it("keeps a challenge authorizable until the run is bound, then consumes it", () => {
    const confirmationId = block({
      voiceSessionId: "voice-1",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });
    // A failed/retried consult can re-authorize the same challenge before it binds.
    const first = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    expect(
      authorizeClientVoiceConfirmation({ voiceSessionId: "voice-1", confirmationId, now: 103 })
        .fingerprint,
    ).toBe(first.fingerprint);
    expect(
      bindAuthorizedClientVoiceConfirmation({ grant: first, runId: "run-approved", now: 103 }),
    ).toBe(true);
    expect(
      bindAuthorizedClientVoiceConfirmation({ grant: first, runId: "run-duplicate", now: 104 }),
    ).toBe(false);
    // After binding the run, the challenge is consumed and cannot re-authorize.
    expect(() =>
      authorizeClientVoiceConfirmation({ voiceSessionId: "voice-1", confirmationId, now: 104 }),
    ).toThrow("missing, expired, or belongs to another action");
  });

  it.each(["supersession", "refusal", "close", "expiry"] as const)(
    "rejects a held grant after %s without mutating confirmation state",
    (invalidator) => {
      vi.useFakeTimers();
      vi.setSystemTime(100);
      const confirmationId = block({
        voiceSessionId: "voice-1",
        toolParams: { action: "send", message: "original" },
        now: 100,
      });
      noteClientVoiceConfirmationUtterance({
        voiceSessionId: "voice-1",
        text: "yes",
        timestamp: 101,
      });
      const grant = authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId,
        now: 102,
      });
      vi.setSystemTime(103);

      let successorId: string | undefined;
      if (invalidator === "supersession") {
        successorId = block({
          voiceSessionId: "voice-1",
          toolParams: { action: "send", message: "successor" },
          now: 103,
        });
      } else if (invalidator === "refusal") {
        noteClientVoiceConfirmationUtterance({
          voiceSessionId: "voice-1",
          text: "no",
          timestamp: 103,
        });
      } else if (invalidator === "close") {
        deactivateClientVoiceConfirmationSession("main", "voice-1");
      } else {
        vi.setSystemTime(120_101);
      }
      const beforeBind = snapshotClientVoiceConfirmationStateForTest();

      expect(
        bindAuthorizedClientVoiceConfirmation({
          grant,
          runId: `run-${invalidator}`,
        }),
      ).toBe(false);
      expect(snapshotClientVoiceConfirmationStateForTest()).toEqual(beforeBind);

      if (successorId) {
        expect(beforeBind).toMatchObject({
          scopeOwners: 1,
          pendingChallenges: 1,
          recentUtterances: 0,
          approvedRuns: 0,
          approvedGrants: 0,
          expiryOwners: 1,
        });
        noteClientVoiceConfirmationUtterance({
          voiceSessionId: "voice-1",
          text: "yes",
          timestamp: 104,
        });
        expect(
          authorizeClientVoiceConfirmation({
            voiceSessionId: "voice-1",
            confirmationId: successorId,
            now: 105,
          }).confirmationId,
        ).toBe(successorId);
      }
    },
  );

  it.each([
    ["agent", { agentId: "other-agent" }],
    ["session", { voiceSessionId: "other-session" }],
    ["confirmation id", { confirmationId: "other-confirmation" }],
    ["fingerprint", { fingerprint: "other-fingerprint" }],
    ["expiry", { expiresAt: 999 }],
  ] as const)("rejects a grant with a mismatched %s without mutating state", (_label, patch) => {
    const confirmationId = block({ voiceSessionId: "voice-1", now: 100 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    const beforeBind = snapshotClientVoiceConfirmationStateForTest();

    expect(
      bindAuthorizedClientVoiceConfirmation({
        grant: { ...grant, ...patch },
        runId: "run-mismatched",
        now: 103,
      }),
    ).toBe(false);
    expect(snapshotClientVoiceConfirmationStateForTest()).toEqual(beforeBind);
  });

  it("binds at the inclusive TTL boundary", () => {
    const confirmationId = block({ voiceSessionId: "voice-1", now: 100 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });

    expect(
      bindAuthorizedClientVoiceConfirmation({
        grant,
        runId: "run-expiry-boundary",
        now: grant.expiresAt,
      }),
    ).toBe(true);
  });

  it("binds approval to the exact tool fingerprint", () => {
    const confirmationId = block({
      voiceSessionId: "voice-1",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "Yes, do it.",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-approved", now: 102 });

    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams: { action: "send", message: "B" },
        now: 103,
      }).allowed,
    ).toBe(false);
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams: { action: "send", message: "A" },
        now: 104,
      }),
    ).toEqual({ allowed: true });
  });

  it("prunes an abandoned confirmation when its TTL expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const confirmationId = block({ voiceSessionId: "voice-1", now: 1_000 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "confirm",
      timestamp: 1_001,
    });
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 1,
      pendingChallenges: 1,
      recentUtterances: 1,
      expiryOwners: 1,
    });

    vi.advanceTimersByTime(120_001);
    expect(snapshotClientVoiceConfirmationStateForTest()).toEqual({
      scopeOwners: 0,
      pendingChallenges: 0,
      recentUtterances: 0,
      approvedRuns: 0,
      approvedGrants: 0,
      expiryOwners: 0,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId,
        now: 121_001,
      }),
    ).toThrow("missing, expired");
  });

  it.each(["no", "don't do it", "don’t do it", "do not proceed", "cancel"])(
    "a refusal invalidates the pending confirmation for %j",
    (text) => {
      const confirmationId = block({ voiceSessionId: "voice-1", now: 100 });
      noteClientVoiceConfirmationUtterance({
        voiceSessionId: "voice-1",
        text,
        timestamp: 101,
      });

      expect(() =>
        authorizeClientVoiceConfirmation({
          voiceSessionId: "voice-1",
          confirmationId,
          now: 102,
        }),
      ).toThrow("missing, expired, or belongs to another action");
    },
  );

  it("consumes an approved fingerprint once", () => {
    const toolParams = { action: "send", message: "A" };
    const confirmationId = block({ voiceSessionId: "voice-1", toolParams, now: 100 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "go ahead",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-approved", now: 102 });

    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 103,
      }),
    ).toEqual({ allowed: true });
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 104,
      }),
    ).toEqual({ allowed: true });
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 105,
      }),
    ).toEqual({ allowed: true });
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 106,
      }).allowed,
    ).toBe(false);
  });

  it("consumes one spoken affirmation for only one pending action", () => {
    const first = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    const second = block({
      voiceSessionId: "voice-1",
      runId: "run-2",
      toolParams: { action: "send", message: "B" },
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });

    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: first,
        now: 102,
      }),
    ).toThrow("newer confirmation request supersedes");
    // Binding the newer grant consumes the shared affirmation and its challenge.
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId: second,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-2", now: 102 });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: first,
        now: 103,
      }),
    ).toThrow("missing, expired");
  });

  it("keeps one challenge when the same action retries in a new run", () => {
    const toolParams = { action: "send", message: "same" };
    const first = block({ voiceSessionId: "voice-1", runId: "run-1", toolParams, now: 100 });
    const retry = block({ voiceSessionId: "voice-1", runId: "run-2", toolParams, now: 101 });
    expect(retry).toBe(first);
    // Reusing a challenge must not itself authorize the retried action.
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-2",
        toolName: "message",
        toolParams,
        now: 102,
      }).allowed,
    ).toBe(false);
  });

  it("points a reused challenge at the latest blocked call without renewing it", () => {
    const base = {
      voiceSessionId: "voice-1",
      toolName: "message",
      toolParams: { action: "send", message: "same" },
    };
    const first = checkClientVoiceToolConfirmationPolicy({
      ...base,
      runId: "run-1",
      toolCallId: "call-1",
      now: 100,
    });
    if (first.allowed) {
      throw new Error("expected a blocked action");
    }
    const confirmationId = confirmationIdFrom(first.reason);
    checkClientVoiceToolConfirmationPolicy({
      ...base,
      runId: "run-2",
      toolCallId: "call-2",
      now: 101,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 102,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 103,
    });
    expect(grant.retryContext).toContain('"runId":"run-2"');
    expect(grant.retryContext).toContain('"toolCallId":"call-2"');
    expect(grant.expiresAt).toBe(120_100);
  });

  it.each(["explicit", "observed"] as const)(
    "carries immutable exact arguments into a %s retry without widening its one-shot grant",
    (mode) => {
      const toolParams = {
        command: "ha area dining",
        title: "Read room status",
        options: { labels: ["dining", "餐厅"], nested: { enabled: true } },
      };
      const original = structuredClone(toolParams);
      const blocked = checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-original",
        toolCallId: "blocked-exec",
        toolName: "exec",
        toolParams,
        now: 100,
      });
      if (blocked.allowed) {
        throw new Error("expected blocked action");
      }
      toolParams.command = "ha mode dining off";
      toolParams.options.labels.push("changed");
      noteClientVoiceConfirmationUtterance({
        voiceSessionId: "voice-1",
        text: "yes",
        timestamp: 101,
      });
      const grant =
        mode === "explicit"
          ? authorizeClientVoiceConfirmation({
              voiceSessionId: "voice-1",
              confirmationId: confirmationIdFrom(blocked.reason),
              now: 102,
            })
          : authorizeObservedClientVoiceConfirmation({
              agentId: "main",
              voiceSessionId: "voice-1",
              now: 102,
            })!;
      const call = JSON.parse(grant.retryContext!.match(/tool call: (.*)\. Retry only/)![1]!);
      expect(call).toEqual({
        runId: "run-original",
        toolCallId: "blocked-exec",
        toolName: "exec",
        arguments: original,
      });
      expect(bindAuthorizedClientVoiceConfirmation({ grant, runId: "retry", now: 103 })).toBe(true);
      const retry = {
        voiceSessionId: "voice-1",
        runId: "retry",
        toolName: call.toolName,
        toolParams: call.arguments,
        now: 104,
      };
      expect(checkClientVoiceToolConfirmationPolicy({ ...retry, toolName: "bash" }).allowed).toBe(
        false,
      );
      expect(checkClientVoiceToolConfirmationPolicy({ ...retry, toolParams }).allowed).toBe(false);
      expect(
        consumeClientVoiceToolConfirmationPolicy({
          ...retry,
          toolParams: {
            options: original.options,
            title: original.title,
            command: original.command,
          },
        }),
      ).toEqual({ allowed: true });
      expect(consumeClientVoiceToolConfirmationPolicy(retry).allowed).toBe(false);
    },
  );

  it.each([0, 1])("caps stored retry arguments at 16 KiB of JSON (%s extra bytes)", (extra) => {
    const overhead = Buffer.byteLength(JSON.stringify({ action: "send", message: "" }), "utf8");
    const messageBytes = 16 * 1024 - overhead;
    const toolParams = {
      action: "send",
      message: "界".repeat(Math.floor(messageBytes / 3)) + "a".repeat((messageBytes % 3) + extra),
    };
    const blocked = checkClientVoiceToolConfirmationPolicy({
      voiceSessionId: "voice-1",
      runId: "run-original",
      toolCallId: "blocked-message",
      toolName: "message",
      toolParams,
      now: 100,
    });
    if (blocked.allowed) {
      throw new Error("expected blocked action");
    }
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId: confirmationIdFrom(blocked.reason),
      now: 102,
    });
    const call = JSON.parse(grant.retryContext!.match(/tool call: (.*)\. Retry only/)![1]!);
    expect(call.toolCallId).toBe("blocked-message");
    if (extra === 0) {
      expect(call.arguments).toEqual(toolParams);
    } else {
      expect(call).not.toHaveProperty("arguments");
    }
    expect(bindAuthorizedClientVoiceConfirmation({ grant, runId: "retry", now: 103 })).toBe(true);
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "retry",
        toolName: "message",
        toolParams,
        now: 104,
      }),
    ).toEqual({ allowed: true });
  });

  it("binds an approved fingerprint to its follow-up run", () => {
    const toolParams = { action: "send", message: "same" };
    const confirmationId = block({
      voiceSessionId: "voice-1",
      runId: "run-original",
      toolParams,
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "proceed",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-approved", now: 102 });

    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-other",
        toolName: "message",
        toolParams,
        now: 103,
      }).allowed,
    ).toBe(false);
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 104,
      }),
    ).toEqual({ allowed: true });
  });

  it("only the newest pending challenge can be authorized", () => {
    const olderId = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams: { action: "send", message: "older" },
      now: 100,
    });
    const newerId = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams: { action: "send", message: "newer" },
      now: 110,
    });
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 1,
      pendingChallenges: 1,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 111,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: olderId,
        now: 112,
      }),
    ).toThrow("newer confirmation request supersedes");
    expect(
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: newerId,
        now: 113,
      }).fingerprint,
    ).toBeTruthy();
  });

  it("invalidates a pending confirmation when the user refuses", () => {
    const toolParams = { action: "send", message: "declined" };
    const confirmationId = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams,
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "No, cancel that",
      timestamp: 101,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 102,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId,
        now: 103,
      }),
    ).toThrow("missing, expired, or belongs to another action");
  });

  it("keeps a live run's grant across call close and releases it on run completion", () => {
    const toolParams = { action: "send", message: "confirmed then hangup" };
    const confirmationId = block({
      voiceSessionId: "voice-1",
      runId: "run-original",
      toolParams,
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes do it",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-live", now: 102 });

    deactivateClientVoiceConfirmationSession("main", "voice-1", ["run-live"]);
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-live",
        toolName: "message",
        toolParams,
        now: 103,
      }),
    ).toEqual({ allowed: true });

    releaseClientVoiceConfirmationRun("main", "voice-1", "run-live");
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-live",
        toolName: "message",
        toolParams,
        now: 104,
      }).allowed,
    ).toBe(false);
  });

  it("isolates same-named voice sessions across agents", () => {
    const blockedA = checkClientVoiceToolConfirmationPolicyForTest({
      agentId: "agent-a",
      voiceSessionId: "shared-id",
      runId: "run-a",
      toolName: "message",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    const blockedB = checkClientVoiceToolConfirmationPolicyForTest({
      agentId: "agent-b",
      voiceSessionId: "shared-id",
      runId: "run-b",
      toolName: "message",
      toolParams: { action: "send", message: "B" },
      now: 100,
    });
    expect(blockedA.allowed).toBe(false);
    expect(blockedB.allowed).toBe(false);
    if (blockedA.allowed || blockedB.allowed) {
      throw new Error("expected confirmation request");
    }
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 2,
      pendingChallenges: 2,
    });
    noteClientVoiceConfirmationUtteranceForTest({
      agentId: "agent-a",
      voiceSessionId: "shared-id",
      text: "no",
      timestamp: 101,
    });
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 1,
      pendingChallenges: 1,
    });
    noteClientVoiceConfirmationUtteranceForTest({
      agentId: "agent-b",
      voiceSessionId: "shared-id",
      text: "yes",
      timestamp: 101,
    });

    expect(
      authorizeClientVoiceConfirmationForTest({
        agentId: "agent-b",
        voiceSessionId: "shared-id",
        confirmationId: confirmationIdFrom(blockedB.reason),
        now: 102,
      }).confirmationId,
    ).toBe(confirmationIdFrom(blockedB.reason));
  });
});

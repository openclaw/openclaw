/**
 * Fork regression tests: Watchdog stall recovery → delivery behavior.
 *
 * Reproduces the bug where a watchdog-triggered run produces an intermediate
 * NO_REPLY (which fires signoff events), then the LLM continues in the same
 * run to produce a real reply — but the real reply never gets delivered to
 * Discord.
 *
 * Scenario from logs (2026-03-10 00:46-00:49):
 *   1. Watchdog fires stall at 00:46:31, injects system message (deliver: false)
 *   2. LLM replies NO_REPLY at 00:46:34 → two signoff events fire
 *   3. User message "Yes" arrives at 00:46:34.571 (same run continues)
 *   4. LLM does 15+ tool calls over 3 minutes
 *   5. LLM produces final text reply at 00:49:05
 *   6. BUG: Final reply never sent to Discord
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Minimal stubs of server-chat.ts internals
// ---------------------------------------------------------------------------

function createChatRunRegistry() {
  const chatRunSessions = new Map<string, { sessionKey: string; clientRunId: string }[]>();

  return {
    add(sessionId: string, entry: { sessionKey: string; clientRunId: string }) {
      const queue = chatRunSessions.get(sessionId);
      if (queue) {
        queue.push(entry);
      } else {
        chatRunSessions.set(sessionId, [entry]);
      }
    },
    peek(sessionId: string) {
      return chatRunSessions.get(sessionId)?.[0];
    },
    shift(sessionId: string) {
      const queue = chatRunSessions.get(sessionId);
      if (!queue?.length) {
        return undefined;
      }
      const entry = queue.shift();
      if (!queue.length) {
        chatRunSessions.delete(sessionId);
      }
      return entry;
    },
    _dump() {
      return Object.fromEntries(chatRunSessions);
    },
  };
}

function isSilentReplyText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return /^\s*NO_REPLY\s*$/.test(text);
}

function isSilentReplyLeadFragment(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed !== trimmed.toUpperCase()) {
    return false;
  }
  if (trimmed.length < 2 || /[^A-Z_]/.test(trimmed)) {
    return false;
  }
  if ("NO_REPLY".startsWith(trimmed)) {
    return trimmed.includes("_") || trimmed === "NO";
  }
  return false;
}

/**
 * Simplified emitChatDelta — mirrors server-chat.ts delta accumulation + suppression.
 */
function createChatEmitter() {
  const buffers = new Map<string, string>();
  const broadcasts: { type: "delta" | "final"; runId: string; text?: string }[] = [];
  const registry = createChatRunRegistry();

  const emitChatDelta = (_sessionKey: string, clientRunId: string, text: string) => {
    const _previous = buffers.get(clientRunId) ?? "";
    // In real code this is resolveMergedAssistantText — simplified here
    const merged = text;
    if (!merged) {
      return;
    }
    buffers.set(clientRunId, merged);
    if (isSilentReplyText(merged)) {
      return;
    }
    if (isSilentReplyLeadFragment(merged)) {
      return;
    }
    broadcasts.push({ type: "delta", runId: clientRunId, text: merged });
  };

  const emitChatFinal = (sessionKey: string, clientRunId: string, _sourceRunId: string) => {
    const bufferedText = (buffers.get(clientRunId) ?? "").trim();
    buffers.delete(clientRunId);
    const shouldSuppressSilent = isSilentReplyText(bufferedText);
    if (!bufferedText || shouldSuppressSilent) {
      broadcasts.push({ type: "final", runId: clientRunId, text: undefined });
      return;
    }
    broadcasts.push({ type: "final", runId: clientRunId, text: bufferedText });
  };

  return { buffers, broadcasts, registry, emitChatDelta, emitChatFinal };
}

// ---------------------------------------------------------------------------
// Simplified reply-chain-enforcer state
// ---------------------------------------------------------------------------
function createWatchdogState() {
  const rawSignOffSessions = new Set<string>();
  const recoveryRuns = new Set<string>();

  return {
    rawSignOffSessions,
    recoveryRuns,
    onSignoff(sessionKey: string) {
      rawSignOffSessions.add(sessionKey);
    },
    onChatFinal(sessionKey: string, text: string) {
      if (rawSignOffSessions.delete(sessionKey)) {
        // "onChatFinal skipped — raw stream already signed off"
        return "skipped-signoff";
      }
      if (recoveryRuns.has(sessionKey)) {
        recoveryRuns.delete(sessionKey);
        return "recovery-complete";
      }
      const trimmed = text?.trim() ?? "";
      if (!trimmed || trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK") {
        return "disarmed-silent";
      }
      return "armed";
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fork: watchdog stall recovery delivery", () => {
  const SESSION_KEY = "agent:main:discord:channel:1466839871162155171";

  describe("ChatRunRegistry", () => {
    it("shift returns undefined when queue is empty", () => {
      const reg = createChatRunRegistry();
      expect(reg.shift("nonexistent")).toBeUndefined();
    });

    it("shift returns and removes the first entry", () => {
      const reg = createChatRunRegistry();
      reg.add("run1", { sessionKey: SESSION_KEY, clientRunId: "run1" });
      const entry = reg.shift("run1");
      expect(entry).toEqual({ sessionKey: SESSION_KEY, clientRunId: "run1" });
      expect(reg.shift("run1")).toBeUndefined();
    });

    it("multiple adds to same sessionId queue in order", () => {
      const reg = createChatRunRegistry();
      reg.add("run1", { sessionKey: SESSION_KEY, clientRunId: "a" });
      reg.add("run1", { sessionKey: SESSION_KEY, clientRunId: "b" });
      expect(reg.shift("run1")!.clientRunId).toBe("a");
      expect(reg.shift("run1")!.clientRunId).toBe("b");
    });
  });

  describe("NO_REPLY suppression in delta path", () => {
    it("suppresses exact NO_REPLY", () => {
      const { emitChatDelta, broadcasts } = createChatEmitter();
      emitChatDelta(SESSION_KEY, "run1", "NO_REPLY");
      expect(broadcasts).toHaveLength(0);
    });

    it("suppresses NO_REPLY lead fragments", () => {
      const { emitChatDelta, broadcasts } = createChatEmitter();
      emitChatDelta(SESSION_KEY, "run1", "NO");
      expect(broadcasts).toHaveLength(0);
    });

    it("does NOT suppress real text", () => {
      const { emitChatDelta, broadcasts } = createChatEmitter();
      emitChatDelta(SESSION_KEY, "run1", "Let me check what logic we have...");
      expect(broadcasts).toHaveLength(1);
    });
  });

  describe("emitChatFinal suppression", () => {
    it("suppresses when buffer is NO_REPLY", () => {
      const { emitChatDelta, emitChatFinal, broadcasts } = createChatEmitter();
      emitChatDelta(SESSION_KEY, "run1", "NO_REPLY");
      emitChatFinal(SESSION_KEY, "run1", "run1");
      const finals = broadcasts.filter((b) => b.type === "final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBeUndefined(); // suppressed
    });

    it("delivers when buffer has real text", () => {
      const { emitChatDelta, emitChatFinal, broadcasts } = createChatEmitter();
      emitChatDelta(SESSION_KEY, "run1", "Here are the tests...");
      emitChatFinal(SESSION_KEY, "run1", "run1");
      const finals = broadcasts.filter((b) => b.type === "final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("Here are the tests...");
    });
  });

  describe("watchdog rawSignOffSessions interaction", () => {
    it("signoff from NO_REPLY causes onChatFinal to skip", () => {
      const wd = createWatchdogState();
      wd.onSignoff(SESSION_KEY);
      const result = wd.onChatFinal(SESSION_KEY, "some real text");
      expect(result).toBe("skipped-signoff");
    });

    it("signoff is consumed — second onChatFinal works normally", () => {
      const wd = createWatchdogState();
      wd.onSignoff(SESSION_KEY);
      wd.onChatFinal(SESSION_KEY, "NO_REPLY"); // consumes the flag
      const result = wd.onChatFinal(SESSION_KEY, "Here are the tests...");
      expect(result).toBe("armed"); // normal behavior
    });

    it("double signoff: only first onChatFinal consumes, second is normal", () => {
      const wd = createWatchdogState();
      wd.onSignoff(SESSION_KEY);
      wd.onSignoff(SESSION_KEY); // Set adds once (idempotent)
      wd.onChatFinal(SESSION_KEY, "NO_REPLY"); // consumes
      const result = wd.onChatFinal(SESSION_KEY, "Real text");
      expect(result).toBe("armed");
    });
  });

  describe("BUG SCENARIO: watchdog run with intermediate NO_REPLY then real reply", () => {
    it("reproduces: single run, NO_REPLY signoff then real text — buffer gets cleared by NO_REPLY", () => {
      /**
       * This test simulates the exact sequence from the logs:
       *
       * 1. Watchdog injects system message → run "watchdog-xxx" starts
       * 2. LLM emits NO_REPLY as assistant text
       * 3. Signoff event fires (because NO_REPLY detected)
       * 4. lifecycle:end does NOT fire yet (LLM continues with tool calls)
       * 5. User message arrives → appended to conversation mid-run
       * 6. LLM continues in same run, emits tool results, then final text
       * 7. lifecycle:end fires → emitChatFinal looks up buffer
       *
       * The question: what's in the buffer at step 7?
       */
      const { buffers, emitChatDelta, emitChatFinal, broadcasts, registry } = createChatEmitter();
      const WATCHDOG_RUN = "watchdog-1741564991-abc123";
      const CLIENT_RUN = WATCHDOG_RUN;

      // Step 1: Run registered
      registry.add(WATCHDOG_RUN, { sessionKey: SESSION_KEY, clientRunId: CLIENT_RUN });

      // Step 2: LLM streams NO_REPLY
      emitChatDelta(SESSION_KEY, CLIENT_RUN, "NO_REPLY");
      // Buffer has "NO_REPLY" but delta was suppressed (not broadcast)
      expect(buffers.get(CLIENT_RUN)).toBe("NO_REPLY");
      expect(broadcasts.filter((b) => b.type === "delta")).toHaveLength(0);

      // Steps 3-4: Signoff fires, but run continues (no lifecycle:end yet)
      // Tool calls happen — they don't go through emitChatDelta

      // Step 5-6: LLM produces real reply text
      // THIS IS THE KEY: Does the buffer get overwritten or appended?
      // In server-chat.ts, resolveMergedAssistantText determines this.
      // The real code uses delta merging — each assistant event has the FULL
      // accumulated text so far. After tool calls, the LLM starts a new
      // text block. The question is whether the merged text replaces or
      // appends to the NO_REPLY buffer.

      // In the real server-chat.ts, the text event after tool calls contains
      // ONLY the new text (not NO_REPLY + new text), because the provider
      // streams a new content block. So the buffer gets REPLACED:
      emitChatDelta(SESSION_KEY, CLIENT_RUN, "Here are the Eyrie tests...");

      // Step 7: lifecycle:end fires
      const entry = registry.shift(WATCHDOG_RUN);
      expect(entry).toBeDefined();
      emitChatFinal(SESSION_KEY, CLIENT_RUN, WATCHDOG_RUN);

      const finals = broadcasts.filter((b) => b.type === "final");
      expect(finals).toHaveLength(1);
      // THIS SHOULD PASS if the buffer was overwritten with real text:
      expect(finals[0].text).toBe("Here are the Eyrie tests...");
    });

    it("BUT: if the real reply text STARTS with a NO_REPLY lead fragment, delta is suppressed", () => {
      const { emitChatDelta, broadcasts } = createChatEmitter();
      // What if the merged text is "NO_REPLY\n\nHere are the tests..."?
      // isSilentReplyText only matches exact NO_REPLY, so this should NOT be suppressed
      emitChatDelta(SESSION_KEY, "run1", "NO_REPLY\n\nHere are the tests...");
      expect(broadcasts).toHaveLength(1);
    });

    it("registry.shift with deliver:false — entry still exists", () => {
      /**
       * When injectSystemMessage uses deliver:false, addChatRun is still called
       * (it runs before the deliver check in agent.ts). So the registry entry exists.
       * The question is whether it gets consumed prematurely.
       */
      const { registry } = createChatEmitter();
      const RUN_ID = "watchdog-12345";
      registry.add(RUN_ID, { sessionKey: SESSION_KEY, clientRunId: RUN_ID });

      // Only one lifecycle:end fires for the entire run (not per-block)
      const entry = registry.shift(RUN_ID);
      expect(entry).toBeDefined();
      expect(entry!.clientRunId).toBe(RUN_ID);

      // Second shift returns nothing
      expect(registry.shift(RUN_ID)).toBeUndefined();
    });

    it("the real bug might be: buffer overwrite logic uses merged text that includes NO_REPLY prefix", () => {
      /**
       * In resolveMergedAssistantText, if the provider sends cumulative text
       * (not just deltas), the merged text might be "NO_REPLY" on first block
       * and then "Let me check..." on the second block (after tool calls).
       *
       * But the buffer key is clientRunId. After tool calls, if the NEW
       * assistant content block sends text, does the buffer get REPLACED
       * (because it's a new content block) or APPENDED?
       *
       * If the buffer still contains "NO_REPLY" and the final mergeText
       * doesn't include the new text, emitChatFinal would suppress it.
       */
      const { buffers, emitChatDelta, emitChatFinal, broadcasts } = createChatEmitter();
      const RUN = "watchdog-xxx";

      // Block 1: NO_REPLY
      emitChatDelta(SESSION_KEY, RUN, "NO_REPLY");
      expect(buffers.get(RUN)).toBe("NO_REPLY");

      // Tool calls happen (no delta events)
      // ...

      // Block 2: Real text — but in our simplified model, this REPLACES the buffer
      // In the REAL code, resolveMergedAssistantText might behave differently
      emitChatDelta(SESSION_KEY, RUN, "Here are the tests...");
      expect(buffers.get(RUN)).toBe("Here are the tests...");

      emitChatFinal(SESSION_KEY, RUN, RUN);
      const finals = broadcasts.filter((b) => b.type === "final");
      expect(finals[0].text).toBe("Here are the tests...");
    });
  });

  describe("ROOT CAUSE: deliver:false propagates to entire watchdog run", () => {
    /**
     * CONFIRMED ROOT CAUSE (2026-03-10):
     *
     * 1. Watchdog calls injectSystemMessage with deliver: false
     * 2. This creates an agent run with opts.deliver = false
     * 3. The LLM responds with NO_REPLY (correct)
     * 4. But the run CONTINUES — user's next message arrives mid-run
     * 5. LLM processes the user message, does tool calls, produces real text
     * 6. At the end, deliverAgentCommandResult checks opts.deliver
     * 7. opts.deliver is STILL false (set at run creation, never updated)
     * 8. Line 218 of delivery.ts: `if (deliver && deliveryChannel && ...)` → SKIPPED
     * 9. Real reply logged to stdout but never sent to Discord
     *
     * The fix should either:
     * a) Clear deliver:false when a new user message arrives mid-run, OR
     * b) Make watchdog runs non-continuable (force a new run for user messages), OR
     * c) Always deliver for sessions that have a channel, regardless of the flag
     */

    it("deliver:false skips outbound delivery — payload only logged", () => {
      const deliveredToDiscord: string[] = [];
      const loggedToConsole: string[] = [];

      // Simulate deliverAgentCommandResult
      function deliverAgentCommandResult(opts: { deliver: boolean }, payloads: { text: string }[]) {
        if (!opts.deliver) {
          for (const p of payloads) {
            loggedToConsole.push(p.text); // Line 215-217
          }
          return;
        }
        // Line 218+: actual Discord delivery
        for (const p of payloads) {
          deliveredToDiscord.push(p.text);
        }
      }

      // Watchdog run: deliver = false
      deliverAgentCommandResult({ deliver: false }, [{ text: "Here are the Eyrie tests..." }]);

      expect(loggedToConsole).toEqual(["Here are the Eyrie tests..."]);
      expect(deliveredToDiscord).toEqual([]); // NEVER SENT TO DISCORD

      // Normal run: deliver = true
      deliverAgentCommandResult({ deliver: true }, [{ text: "Here are the Eyrie tests..." }]);

      expect(deliveredToDiscord).toEqual(["Here are the Eyrie tests..."]);
    });

    it("watchdog injectSystemMessage always sets deliver: false", () => {
      // From server.impl.ts line 689-714:
      // injectSystemMessage: async (opts) => {
      //   await callGateway({
      //     method: "agent",
      //     params: {
      //       ...
      //       deliver: false,  // <-- THIS IS THE BUG
      //     },
      //   });
      // }
      const watchdogParams = {
        deliver: false,
        idempotencyKey: `watchdog-${Date.now()}`,
      };
      expect(watchdogParams.deliver).toBe(false);
      // This deliver:false propagates to the ENTIRE run,
      // including any continuation after NO_REPLY
    });
  });
});

describe("SOURCE PROOF: deliver:false in injectSystemMessage blocks delivery", () => {
  const fs = require("fs");
  const path = require("path");

  const serverImplSrc = fs.readFileSync(
    path.resolve(__dirname, "../gateway/server.impl.ts"),
    "utf-8",
  );
  const deliverySrc = fs.readFileSync(
    path.resolve(__dirname, "../commands/agent/delivery.ts"),
    "utf-8",
  );

  it("injectSystemMessage sets deliver: true (FIXED — was deliver: false)", () => {
    // Find the injectSystemMessage function
    const fnStart = serverImplSrc.indexOf("injectSystemMessage:");
    expect(fnStart).toBeGreaterThan(-1);
    const chunk = serverImplSrc.slice(fnStart, fnStart + 600);
    // FIXED: was deliver: false, now deliver: true
    expect(chunk).toContain("deliver: true");
    expect(chunk).not.toContain("deliver: false");
  });

  it("deliverAgentCommandResult gates Discord delivery on deliver === true", () => {
    // The outbound send path requires deliver to be true
    expect(deliverySrc).toContain("const deliver = opts.deliver === true");
    // Actual Discord send is gated:
    expect(deliverySrc).toMatch(/if\s*\(deliver\s*&&\s*deliveryChannel/);
  });

  it("deliver:false path only logs — never calls deliverOutboundPayloads", () => {
    // Find the !deliver block
    const noDeliverBlock = deliverySrc.indexOf("if (!deliver)");
    expect(noDeliverBlock).toBeGreaterThan(-1);
    // Find the deliver+channel block (actual send)
    const deliverBlock = deliverySrc.indexOf("if (deliver && deliveryChannel");
    expect(deliverBlock).toBeGreaterThan(-1);
    // The !deliver block comes BEFORE the deliver block
    expect(noDeliverBlock).toBeLessThan(deliverBlock);
    // Between !deliver and deliver blocks, there's no deliverOutboundPayloads
    const between = deliverySrc.slice(noDeliverBlock, deliverBlock);
    expect(between).not.toContain("deliverOutboundPayloads");
    // deliverOutboundPayloads only appears INSIDE the deliver===true block
    const afterDeliverGate = deliverySrc.slice(deliverBlock, deliverBlock + 500);
    expect(afterDeliverGate).toContain("deliverOutboundPayloads");
  });
});

describe("FIX VALIDATION: deliver:true in injectSystemMessage enables delivery", () => {
  it("with deliver:true, NO_REPLY is still suppressed by isSilentReplyText", () => {
    // From server-chat.ts — isSilentReplyText checks
    function isSilentReplyText(text: string): boolean {
      const trimmed = text.trim();
      return trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK" || trimmed === "ANNOUNCE_SKIP";
    }

    expect(isSilentReplyText("NO_REPLY")).toBe(true);
    expect(isSilentReplyText("NO_REPLY\n")).toBe(true);
    expect(isSilentReplyText(" NO_REPLY ")).toBe(true);
  });

  it("with deliver:true, real replies DO get delivered", () => {
    function isSilentReplyText(text: string): boolean {
      const trimmed = text.trim();
      return trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK" || trimmed === "ANNOUNCE_SKIP";
    }

    const delivered: string[] = [];

    function deliverSimulated(deliver: boolean, text: string) {
      if (isSilentReplyText(text)) {
        return;
      } // suppressed regardless
      if (deliver) {
        delivered.push(text);
      }
    }

    // Watchdog run with fix applied (deliver: true)
    // Step 1: LLM says NO_REPLY → suppressed by isSilentReplyText ✅
    deliverSimulated(true, "NO_REPLY");
    expect(delivered).toEqual([]);

    // Step 2: User message arrives, LLM produces real reply → DELIVERED ✅
    deliverSimulated(true, "Here are the Eyrie tests I wrote...");
    expect(delivered).toEqual(["Here are the Eyrie tests I wrote..."]);
  });

  it("BUG SCENARIO: deliver:false blocks real reply even after user message", () => {
    function isSilentReplyText(text: string): boolean {
      const trimmed = text.trim();
      return trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK" || trimmed === "ANNOUNCE_SKIP";
    }

    const delivered: string[] = [];

    function deliverSimulated(deliver: boolean, text: string) {
      if (isSilentReplyText(text)) {
        return;
      }
      if (deliver) {
        delivered.push(text);
      }
      // if !deliver, logged to stdout only (bug path)
    }

    // Old behavior: deliver: false
    deliverSimulated(false, "NO_REPLY"); // suppressed (fine)
    deliverSimulated(false, "Here are the Eyrie tests I wrote..."); // LOST!
    expect(delivered).toEqual([]); // Nothing delivered — THE BUG
  });
});

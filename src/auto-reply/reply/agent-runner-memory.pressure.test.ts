import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPressureTrackingForTests,
  formatContextPressureMessage,
  resetPressureTracking,
} from "../../agents/context-pressure.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const enqueueSystemEventMock = vi.fn();

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

import {
  maybeInjectAgentCompactionPressureSignal,
  _setTokenSourceForTests,
} from "./agent-compaction-pressure.js";

function createCfg(mode: "agent" | "default" = "agent"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        compaction: { mode },
      },
    },
  };
}

function createEntry(totalTokens: number): SessionEntry {
  return {
    totalTokens,
    totalTokensFresh: true,
  } as SessionEntry;
}

// Inject a test-only token source so tests don't need an on-disk transcript.
// The default production source reads from the session transcript file via
// sessionId, which doesn't exist in unit tests.
_setTokenSourceForTests(
  (entry) => ((entry as Record<string, unknown>).totalTokens as number | undefined) ?? undefined,
);

describe("agent compaction pressure signaling", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    _resetPressureTrackingForTests();
  });

  it("enqueues a pressure signal at 76% when compaction.mode is agent", async () => {
    const entry = createEntry(76_000);
    maybeInjectAgentCompactionPressureSignal({
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    });

    // Wait for dynamic import to resolve
    await new Promise((r) => setTimeout(r, 50));

    const expected = formatContextPressureMessage({
      pressure: 0.76,
      compactionRecommended: false,
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(expected, {
      sessionKey: "agent:main:main",
    });
  });

  it("enqueues a compaction-recommended pressure signal at 86% when compaction.mode is agent", async () => {
    const entry = createEntry(86_000);
    maybeInjectAgentCompactionPressureSignal({
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    });

    await new Promise((r) => setTimeout(r, 50));

    const expected = formatContextPressureMessage({
      pressure: 0.86,
      compactionRecommended: true,
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(expected, {
      sessionKey: "agent:main:main",
    });
  });

  it("does not inject a pressure signal below 75%", () => {
    const entry = createEntry(50_000);
    maybeInjectAgentCompactionPressureSignal({
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("76% fires once only below RECOMMEND threshold", async () => {
    const entry = createEntry(76_000);
    const params = {
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };

    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("86% fires every turn at/above RECOMMEND threshold", async () => {
    const entry = createEntry(86_000);
    const params = {
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };

    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
  });

  it("escalation from 76% to 86% fires both times", async () => {
    const params76 = {
      cfg: createCfg("agent"),
      sessionEntry: createEntry(76_000),
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };
    const params86 = {
      ...params76,
      sessionEntry: createEntry(86_000),
    };

    maybeInjectAgentCompactionPressureSignal(params76);
    await new Promise((r) => setTimeout(r, 50));
    maybeInjectAgentCompactionPressureSignal(params86);
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
  });

  it("suppresses one signal after resetPressureTracking() (post-compaction guard)", async () => {
    // Regression: pre-fix, the turn immediately after compaction would re-emit
    // a `compaction_recommended: true` signal because the next compute call
    // still saw pre-compaction token counts. resetPressureTracking() now arms
    // a one-shot suppression that swallows that stale signal.
    const params = {
      cfg: createCfg("agent"),
      sessionEntry: createEntry(95_000),
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };

    // Compaction just ran.
    resetPressureTracking();

    // Stale token count comes through on the very next turn -> suppressed.
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(0);

    // Subsequent turn (presumably with a refreshed token count) emits normally.
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });
});

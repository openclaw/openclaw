import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatContextPressureMessage, resetPressureTracking } from "../../agents/context-pressure.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const enqueueSystemEventMock = vi.fn();

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

import { maybeInjectAgentCompactionPressureSignal } from "./agent-compaction-pressure.js";

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

describe("agent compaction pressure signaling", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    resetPressureTracking();
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
});

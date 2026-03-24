import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildStatusReply } from "./commands-status.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

describe("buildStatusReply subagent summary", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("counts ended orchestrators with active descendants as active", async () => {
    const parentKey = "agent:main:subagent:status-ended-parent";
    addSubagentRunForTests({
      runId: "run-status-ended-parent",
      childSessionKey: parentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "status orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 110_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-status-active-child",
      childSessionKey: "agent:main:subagent:status-ended-parent:subagent:child",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "subagent:status-ended-parent",
      task: "status child still running",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/status", cfg);
    const reply = await buildStatusReply({
      cfg,
      command: params.command,
      sessionEntry: params.sessionEntry,
      sessionKey: params.sessionKey,
      parentSessionKey: params.sessionKey,
      sessionScope: params.sessionScope,
      storePath: params.storePath,
      provider: "anthropic",
      model: "claude-opus-4-5",
      contextTokens: 0,
      resolvedThinkLevel: params.resolvedThinkLevel,
      resolvedFastMode: false,
      resolvedVerboseLevel: params.resolvedVerboseLevel,
      resolvedReasoningLevel: params.resolvedReasoningLevel,
      resolvedElevatedLevel: params.resolvedElevatedLevel,
      resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel,
      isGroup: params.isGroup,
      defaultGroupActivation: params.defaultGroupActivation,
    });

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { failTaskRunByRunId } from "../../tasks/task-executor.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import type { ReplyPayload } from "../types.js";
import { handleSubagentsInfoAction } from "./commands-subagents/action-info.js";

function buildInfoContext(params: { cfg: OpenClawConfig; runs: object[]; restTokens: string[] }) {
  return {
    params: {
      cfg: params.cfg,
      sessionKey: "agent:main:main",
    },
    handledPrefix: "/subagents",
    requesterKey: "agent:main:main",
    runs: params.runs,
    restTokens: params.restTokens,
  } as Parameters<typeof handleSubagentsInfoAction>[0];
}

function requireReplyText(reply: ReplyPayload | undefined): string {
  expect(reply?.text).toBeDefined();
  return reply?.text as string;
}

beforeEach(() => {
  resetTaskRegistryForTests();
  resetSubagentRegistryForTests();
});

describe("subagents info", () => {
  it("returns usage for missing targets", () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction(buildInfoContext({ cfg, runs: [], restTokens: [] }));
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents info <id|#>");
  });

  it("returns info for a subagent", () => {
    const now = Date.now();
    const run = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    };
    addSubagentRunForTests(run);
    createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:abc",
      runId: "run-1",
      task: "do thing",
      status: "succeeded",
      terminalSummary: "Completed the requested task",
      deliveryStatus: "delivered",
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: ["1"] }),
    );
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("Subagent info");
    expect(text).toContain("Run: run-1");
    expect(text).toContain("Status: done");
    expect(text).toContain("TaskStatus: succeeded");
    expect(text).toContain("Task summary: Completed the requested task");
  });

  it("sanitizes leaked task details in /subagents info", () => {
    const now = Date.now();
    const run = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Inspect the stuck run",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: {
        status: "error",
        error: [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
      },
    };
    addSubagentRunForTests(run);
    createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:abc",
      runId: "run-1",
      task: "Inspect the stuck run",
      status: "running",
      deliveryStatus: "delivered",
    });
    failTaskRunByRunId({
      runId: "run-1",
      endedAt: now - 1_000,
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      terminalSummary: "Needs manual follow-up.",
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: ["1"] }),
    );
    const text = requireReplyText(result.reply);

    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("Subagent info");
    expect(text).toContain("Outcome: error");
    expect(text).toContain("Task summary: Needs manual follow-up.");
    expect(text).not.toContain("OpenClaw runtime context (internal):");
    expect(text).not.toContain("Internal task completion event");
  });
});

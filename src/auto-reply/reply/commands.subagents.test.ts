import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappCommandPolicy } from "../../../test/helpers/channels/command-contract.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions.js";
import { buildDmGroupAccountAllowlistAdapter } from "../../plugin-sdk/allowlist-config-edit.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { buildStatusReply } = await import("./commands-status.js");
const { handleSubagentsCommand } = await import("./commands-subagents.js");
const { __testing: subagentControlTesting } = await import("../../agents/subagent-control.js");
const { addSubagentRunForTests, listSubagentRunsForRequester, resetSubagentRegistryForTests } =
  await import("../../agents/subagent-registry.js");
const { createTaskRecord, resetTaskRegistryForTests } =
  await import("../../tasks/task-registry.js");
const { failTaskRunByRunId } = await import("../../tasks/task-executor.js");

let testWorkspaceDir = os.tmpdir();

const whatsappCommandTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "whatsapp",
    label: "WhatsApp",
    docsPath: "/channels/whatsapp",
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: true,
      media: true,
      nativeCommands: true,
    },
  }),
  commands: whatsappCommandPolicy,
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: "whatsapp",
    resolveAccount: ({ cfg }) => cfg.channels?.whatsapp ?? {},
    normalize: ({ values }) => values.map((value) => String(value).trim()).filter(Boolean),
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveDmPolicy: (account) => account.dmPolicy,
    resolveGroupPolicy: (account) => account.groupPolicy,
  }),
};

function setChannelPluginRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        plugin: whatsappCommandTestPlugin,
        source: "test",
      },
    ]),
  );
}

function buildParams(commandBody: string, cfg: OpenClawConfig) {
  return buildCommandTestParams(commandBody, cfg, undefined, { workspaceDir: testWorkspaceDir });
}

async function buildStatusReplyForTests(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  verbose?: boolean;
}) {
  const commandParams = buildCommandTestParams("/status", params.cfg, undefined, {
    workspaceDir: testWorkspaceDir,
  });
  const sessionKey = params.sessionKey ?? commandParams.sessionKey;
  return await buildStatusReply({
    cfg: params.cfg,
    command: commandParams.command,
    sessionEntry: commandParams.sessionEntry,
    sessionKey,
    parentSessionKey: sessionKey,
    sessionScope: commandParams.sessionScope,
    storePath: commandParams.storePath,
    provider: "anthropic",
    model: "claude-opus-4-6",
    contextTokens: 0,
    resolvedThinkLevel: commandParams.resolvedThinkLevel,
    resolvedFastMode: false,
    resolvedVerboseLevel: params.verbose ? "on" : commandParams.resolvedVerboseLevel,
    resolvedReasoningLevel: commandParams.resolvedReasoningLevel,
    resolvedElevatedLevel: commandParams.resolvedElevatedLevel,
    resolveDefaultThinkingLevel: commandParams.resolveDefaultThinkingLevel,
    isGroup: commandParams.isGroup,
    defaultGroupActivation: commandParams.defaultGroupActivation,
  });
}

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commands-subagents-"));
  await fs.writeFile(path.join(testWorkspaceDir, "AGENTS.md"), "# Agents\n", "utf-8");
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetTaskRegistryForTests();
  resetSubagentRegistryForTests();
  setChannelPluginRegistryForTests();
  callGatewayMock.mockImplementation(async () => ({}));
  subagentControlTesting.setDepsForTest({
    callGateway: (opts: unknown) => callGatewayMock(opts),
  });
});

describe("handleCommands subagents", () => {
  it("lists subagents when none exist", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active subagents:");
    expect(result.reply?.text).toContain("active subagents:\n-----\n");
    expect(result.reply?.text).toContain("recent subagents (last 30m):");
    expect(result.reply?.text).toContain("\n\nrecent subagents (last 30m):");
    expect(result.reply?.text).toContain("recent subagents (last 30m):\n-----\n");
  });

  it("truncates long subagent task text in /subagents list", async () => {
    addSubagentRunForTests({
      runId: "run-long-task",
      childSessionKey: "agent:main:subagent:long-task",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain(
      "This is a deliberately long task description used to verify that subagent list output keeps the full task text",
    );
    expect(result.reply?.text).toContain("...");
    expect(result.reply?.text).not.toContain("after a short hard cutoff.");
  });

  it("lists subagents for the command target session for native /subagents", async () => {
    addSubagentRunForTests({
      runId: "run-target",
      childSessionKey: "agent:main:subagent:target",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "target run",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    addSubagentRunForTests({
      runId: "run-slash",
      childSessionKey: "agent:main:subagent:slash",
      requesterSessionKey: "agent:main:slack:slash:u1",
      requesterDisplayKey: "agent:main:slack:slash:u1",
      task: "slash run",
      cleanup: "keep",
      createdAt: 2000,
      startedAt: 2000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildCommandTestParams(
      "/subagents list",
      cfg,
      {
        CommandSource: "native",
        CommandTargetSessionKey: "agent:main:main",
      },
      { workspaceDir: testWorkspaceDir },
    );
    params.sessionKey = "agent:main:slack:slash:u1";
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active subagents:");
    expect(result.reply?.text).toContain("target run");
    expect(result.reply?.text).not.toContain("slash run");
  });

  it("keeps ended orchestrators in active list while descendants are pending", async () => {
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-orchestrator-child-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "child worker still running",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });

    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleSubagentsCommand(params, true);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active (waiting on 1 child)");
    expect(result.reply?.text).not.toContain(
      "recent subagents (last 30m):\n-----\n1. orchestrate child workers",
    );
  });

  it("formats subagent usage with io and prompt/cache breakdown", async () => {
    addSubagentRunForTests({
      runId: "run-usage",
      childSessionKey: "agent:main:subagent:usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-usage.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:usage"] = {
        sessionId: "child-session-usage",
        updatedAt: Date.now(),
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
        model: "opencode/claude-opus-4-6",
      };
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
    expect(result.reply?.text).toContain("prompt/cache 197k");
    expect(result.reply?.text).not.toContain("1k io");
  });

  it.each([
    {
      name: "omits subagent status line when none exist",
      seedRuns: () => undefined,
      verboseLevel: "on" as const,
      expectedText: [] as string[],
      unexpectedText: ["Subagents:"],
    },
    {
      name: "includes subagent count in /status when active",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
      },
      verboseLevel: "off" as const,
      expectedText: ["🤖 Subagents: 1 active"],
      unexpectedText: [] as string[],
    },
    {
      name: "includes subagent details in /status when verbose",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
        addSubagentRunForTests({
          runId: "run-2",
          childSessionKey: "agent:main:subagent:def",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "finished task",
          cleanup: "keep",
          createdAt: 900,
          startedAt: 900,
          endedAt: 1200,
          outcome: { status: "ok" },
        });
      },
      verboseLevel: "on" as const,
      expectedText: ["🤖 Subagents: 1 active", "· 1 done"],
      unexpectedText: [] as string[],
    },
  ])("$name", async ({ seedRuns, verboseLevel, expectedText, unexpectedText }) => {
    seedRuns();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const result = await buildStatusReplyForTests({
      cfg,
      verbose: verboseLevel === "on",
    });
    expect(result.shouldContinue).toBe(false);
    for (const expected of expectedText) {
      expect(result.reply?.text).toContain(expected);
    }
    for (const blocked of unexpectedText) {
      expect(result.reply?.text).not.toContain(blocked);
    }
  });

  it("returns help/usage for invalid or incomplete subagents commands", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const cases = [
      { commandBody: "/subagents foo", expectedText: "/subagents" },
      { commandBody: "/subagents info", expectedText: "/subagents info" },
    ] as const;
    for (const testCase of cases) {
      const params = buildParams(testCase.commandBody, cfg);
      const result = await handleSubagentsCommand(params, true);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain(testCase.expectedText);
    }
  });

  it("returns info for a subagent", async () => {
    const now = Date.now();
    addSubagentRunForTests({
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
    });
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
    const params = buildParams("/subagents info 1", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Subagent info");
    expect(result.reply?.text).toContain("Run: run-1");
    expect(result.reply?.text).toContain("Status: done");
    expect(result.reply?.text).toContain("TaskStatus: succeeded");
    expect(result.reply?.text).toContain("Task summary: Completed the requested task");
  });

  it("sanitizes leaked task details in /subagents info", async () => {
    const now = Date.now();
    addSubagentRunForTests({
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
    });
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
    const params = buildParams("/subagents info 1", cfg);
    const result = await handleSubagentsCommand(params, true);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Subagent info");
    expect(result.reply?.text).toContain("Outcome: error");
    expect(result.reply?.text).toContain("Task summary: Needs manual follow-up.");
    expect(result.reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(result.reply?.text).not.toContain("Internal task completion event");
  });

  it("kills subagents via /kill alias without a confirmation reply", async () => {
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/kill 1", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it("resolves numeric aliases in active-first display order", async () => {
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active task",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
    });
    addSubagentRunForTests({
      runId: "run-recent",
      childSessionKey: "agent:main:subagent:recent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recent task",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
      endedAt: now - 10_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/kill 1", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it("sends follow-up messages to finished subagents", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "agent") {
        return { runId: "run-followup-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "done" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });
    const now = Date.now();
    addSubagentRunForTests({
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
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents send 1 continue with follow-up details", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("✅ Sent to");

    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCall?.[0]).toMatchObject({
      method: "agent",
      params: {
        lane: "subagent",
        sessionKey: "agent:main:subagent:abc",
        timeout: 0,
      },
    });

    const waitCall = callGatewayMock.mock.calls.find(
      (call) =>
        (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
        (call[0] as { method?: string; params?: { runId?: string } }).params?.runId ===
          "run-followup-1",
    );
    expect(waitCall).toBeDefined();
  });

  it("blocks leaf subagents from sending to explicitly-owned child sessions", async () => {
    const leafKey = "agent:main:subagent:leaf";
    const childKey = `${leafKey}:subagent:child`;
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-send-scope.json");
    await updateSessionStore(storePath, (store) => {
      store[leafKey] = {
        sessionId: "leaf-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        subagentRole: "leaf",
        subagentControlScope: "none",
      };
      store[childKey] = {
        sessionId: "child-session",
        updatedAt: Date.now(),
        spawnedBy: leafKey,
        subagentRole: "leaf",
        subagentControlScope: "none",
      };
    });
    addSubagentRunForTests({
      runId: "run-child-send",
      childSessionKey: childKey,
      requesterSessionKey: leafKey,
      requesterDisplayKey: leafKey,
      task: "child follow-up target",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/subagents send 1 continue with follow-up details", cfg);
    params.sessionKey = leafKey;

    const result = await handleSubagentsCommand(params, true);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Leaf subagents cannot control other sessions.");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("steers subagents via /steer alias", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-steer-1" };
      }
      return {};
    });
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-steer.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:abc"] = {
        sessionId: "child-session-steer",
        updatedAt: Date.now(),
      };
    });
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/steer 1 check timer.ts instead", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("steered");
    const steerWaitIndex = callGatewayMock.mock.calls.findIndex(
      (call) =>
        (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
        (call[0] as { method?: string; params?: { runId?: string } }).params?.runId === "run-1",
    );
    expect(steerWaitIndex).toBeGreaterThanOrEqual(0);
    const steerRunIndex = callGatewayMock.mock.calls.findIndex(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(steerRunIndex).toBeGreaterThan(steerWaitIndex);
    expect(callGatewayMock.mock.calls[steerWaitIndex]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "run-1", timeoutMs: 5_000 },
      timeoutMs: 7_000,
    });
    expect(callGatewayMock.mock.calls[steerRunIndex]?.[0]).toMatchObject({
      method: "agent",
      params: {
        lane: "subagent",
        sessionKey: "agent:main:subagent:abc",
        sessionId: "child-session-steer",
        timeout: 0,
      },
    });
    const trackedRuns = listSubagentRunsForRequester("agent:main:main");
    expect(trackedRuns).toHaveLength(1);
    expect(trackedRuns[0].runId).toBe("run-steer-1");
    expect(trackedRuns[0].endedAt).toBeUndefined();
  });

  it("restores announce behavior when /steer replacement dispatch fails", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "agent") {
        throw new Error("dispatch failed");
      }
      return {};
    });
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/steer 1 check timer.ts instead", cfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("send failed: dispatch failed");

    const trackedRuns = listSubagentRunsForRequester("agent:main:main");
    expect(trackedRuns).toHaveLength(1);
    expect(trackedRuns[0].runId).toBe("run-1");
    expect(trackedRuns[0].suppressAnnounceReason).toBeUndefined();
  });
});

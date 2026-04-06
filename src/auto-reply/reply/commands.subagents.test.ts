import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappCommandPolicy } from "../../../test/helpers/channels/command-contract.js";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions.js";
import { buildDmGroupAccountAllowlistAdapter } from "../../plugin-sdk/allowlist-config-edit.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandlerResult } from "./commands-types.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

let testWorkspaceDir = os.tmpdir();
let buildCommandTestParamsPromise: Promise<typeof import("./commands.test-harness.js")> | null =
  null;
let handleSubagentsCommandPromise: Promise<typeof import("./commands-subagents.js")> | null = null;
let subagentControlPromise: Promise<typeof import("../../agents/subagent-control.js")> | null =
  null;

function loadCommandTestHarness() {
  buildCommandTestParamsPromise ??= import("./commands.test-harness.js");
  return buildCommandTestParamsPromise;
}

function loadSubagentsModule() {
  handleSubagentsCommandPromise ??= import("./commands-subagents.js");
  return handleSubagentsCommandPromise;
}

function loadSubagentControlModule() {
  subagentControlPromise ??= import("../../agents/subagent-control.js");
  return subagentControlPromise;
}

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

async function buildParams(commandBody: string, cfg: OpenClawConfig) {
  const { buildCommandTestParams } = await loadCommandTestHarness();
  return buildCommandTestParams(commandBody, cfg, undefined, { workspaceDir: testWorkspaceDir });
}

function requireCommandResult(
  result: Awaited<ReturnType<typeof runSubagentsCommand>> | null,
): CommandHandlerResult {
  expect(result).not.toBeNull();
  return result as CommandHandlerResult;
}

async function runSubagentsCommand(commandBody: string, cfg: OpenClawConfig) {
  const params = await buildParams(commandBody, cfg);
  const { handleSubagentsCommand } = await loadSubagentsModule();
  return handleSubagentsCommand(params, true);
}

async function resetSubagentStateForTests() {
  const { __testing: subagentControlTesting } = await loadSubagentControlModule();
  resetSubagentRegistryForTests();
  callGatewayMock.mockImplementation(async () => ({}));
  subagentControlTesting.setDepsForTest({
    callGateway: (opts: unknown) => callGatewayMock(opts),
  });
}

function requireReplyText(reply: ReplyPayload | undefined): string {
  expect(reply?.text).toBeDefined();
  return reply?.text as string;
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

beforeEach(async () => {
  vi.clearAllMocks();
  await resetSubagentStateForTests();
  setChannelPluginRegistryForTests();
});

describe("handleCommands subagents", () => {
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
    const { buildCommandTestParams } = await loadCommandTestHarness();
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
    const { handleSubagentsCommand } = await loadSubagentsModule();
    const result = requireCommandResult(await handleSubagentsCommand(params, true));
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("active subagents:");
    expect(text).toContain("target run");
    expect(text).not.toContain("slash run");
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
      const result = requireCommandResult(await runSubagentsCommand(testCase.commandBody, cfg));
      const text = requireReplyText(result.reply);
      expect(result.shouldContinue).toBe(false);
      expect(text).toContain(testCase.expectedText);
    }
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
    const result = requireCommandResult(await runSubagentsCommand("/kill 1", cfg));
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
    const result = requireCommandResult(await runSubagentsCommand("/kill 1", cfg));
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
    const result = requireCommandResult(
      await runSubagentsCommand("/subagents send 1 continue with follow-up details", cfg),
    );
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("✅ Sent to");

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
    const params = await buildParams("/subagents send 1 continue with follow-up details", cfg);
    params.sessionKey = leafKey;

    const { handleSubagentsCommand } = await loadSubagentsModule();
    const result = requireCommandResult(await handleSubagentsCommand(params, true));
    const text = requireReplyText(result.reply);

    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("Leaf subagents cannot control other sessions.");
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
    const result = requireCommandResult(
      await runSubagentsCommand("/steer 1 check timer.ts instead", cfg),
    );
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("steered");
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
    const result = requireCommandResult(
      await runSubagentsCommand("/steer 1 check timer.ts instead", cfg),
    );
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expect(text).toContain("send failed: dispatch failed");

    const trackedRuns = listSubagentRunsForRequester("agent:main:main");
    expect(trackedRuns).toHaveLength(1);
    expect(trackedRuns[0].runId).toBe("run-1");
    expect(trackedRuns[0].suppressAnnounceReason).toBeUndefined();
  });
});

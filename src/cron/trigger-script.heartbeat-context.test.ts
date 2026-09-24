import { describe, expect, it, onTestFinished, vi } from "vitest";
import "../agents/test-helpers/fast-bash-tools.js";
import "../agents/test-helpers/fast-coding-tools.js";
import "../agents/test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { resolveScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createCronScriptRuntime, type HeartbeatContextCollection } from "./trigger-script.js";

const request = (): HeartbeatContextCollection => ({
  agentId: "main",
  monitorJobId: "heartbeat-main",
  sessionKey: "agent:main:main",
  commands: ["first", "second"],
  authority: { toolsAllow: ["exec"], scheduledToolPolicy: { version: 1, mode: "trusted" } },
  abortSignal: new AbortController().signal,
  isCurrent: () => true,
});

function collector(execute: AnyAgentTool["execute"]) {
  const config: OpenClawConfig = {};
  const tool: AnyAgentTool = {
    name: "exec",
    label: "Exec",
    description: "Collect a fixture state",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutSeconds: { type: "number" },
        background: { type: "boolean" },
      },
      required: ["command"],
    },
    execute,
  };
  return createCronScriptRuntime({
    config,
    prepareRuntime: async () => ({
      createTools: () => [tool],
      context: { config, agentId: "main", sessionKey: "agent:main:main" },
    }),
  }).collectHeartbeatContext;
}

const successful = (aggregated: string) =>
  jsonResult({ status: "completed", exitCode: 0, aggregated, truncated: false });

describe("heartbeat context collection", () => {
  it("collects each complete result in command order through the headless tool bridge", async () => {
    const execute = vi.fn<AnyAgentTool["execute"]>(async (_id, input) => {
      const command = (input as { command: string }).command;
      return successful(`state for ${command}`);
    });
    const result = await collector(execute)(request());
    expect(result).toEqual({
      kind: "collected",
      outputs: [
        { command: "first", output: "state for first" },
        { command: "second", output: "state for second" },
      ],
    });
  });

  it.each([
    ["command failure", { status: "failed", exitCode: 1, aggregated: "private failure" }],
    ["pending approval", { status: "approval-pending", approvalId: "private approval" }],
    [
      "truncation",
      { status: "completed", exitCode: 0, aggregated: "private tail", truncated: true },
    ],
    [
      "oversized output",
      { status: "completed", exitCode: 0, aggregated: "private".repeat(3000), truncated: false },
    ],
  ])(
    "rejects %s without exposing partial output or running another command",
    async (_name, details) => {
      const execute = vi.fn<AnyAgentTool["execute"]>(async () => jsonResult(details));
      const result = await collector(execute)(request());
      expect(result).toMatchObject({ kind: "error" });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("does not execute without the server-held exec grant", async () => {
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => successful("state"));
    const params = request();
    params.authority.toolsAllow = [];
    expect(await collector(execute)(params)).toMatchObject({ kind: "error" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["still configured", true],
    ["removed", false],
  ])(
    "builds exec from the saved grant only while its creator account is %s",
    async (_, configured) => {
      const execute = vi.fn<AnyAgentTool["execute"]>(async () => successful("state"));
      const config: OpenClawConfig = {
        channels: { whatsapp: { accounts: configured ? { work: {} } : {} } },
      };
      const sessionKey = "agent:main:whatsapp:group:ops";
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test:whatsapp",
            plugin: createChannelTestPluginBase({
              id: "whatsapp",
              config: {
                listAccountIds: (cfg) => Object.keys(cfg.channels?.whatsapp?.accounts ?? {}),
              },
            }),
          },
        ]),
      );
      onTestFinished(resetPluginRuntimeStateForTest);
      const params = request();
      params.authority.scheduledToolPolicy = {
        version: 1,
        mode: "account",
        ownerSessionKey: sessionKey,
        ownerAccountId: "work",
      };
      const result = await createCronScriptRuntime({
        config,
        // Real tool construction applies the scheduled-account policy owner; only exec's effect is stubbed.
        prepareRuntime: async (prepared) => ({
          createTools: () =>
            createOpenClawCodingTools({
              agentId: "main",
              sessionKey,
              config,
              runtimeToolAllowlist: ["exec"],
              scheduledToolPolicy: resolveScheduledToolPolicyContext({
                toolsAllow: prepared.toolsAllow,
                scheduledToolPolicy: prepared.scheduledToolPolicy,
              }),
            }).flatMap((tool) => (tool.name === "exec" ? [{ ...tool, execute }] : [])),
          context: { config, agentId: "main", sessionKey },
        }),
      }).collectHeartbeatContext(params);
      expect(result.kind).toBe(configured ? "collected" : "error");
      expect(execute).toHaveBeenCalledTimes(configured ? 2 : 0);
    },
  );

  it("discards results when monitor authority changes while a command runs", async () => {
    let current = true;
    const execute = vi.fn<AnyAgentTool["execute"]>(async () => {
      current = false;
      return successful("stale result");
    });
    expect(await collector(execute)({ ...request(), isCurrent: () => current })).toMatchObject({
      kind: "error",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

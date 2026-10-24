import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createMockSessionRuntime,
  resolveVoiceCallRealtimeTools,
} from "../extensions/voice-call/test-api.js";
import {
  consultRealtimeVoiceAgent,
  type RealtimeVoiceAgentConsultRuntime,
} from "../src/talk/agent-consult-runtime.js";
import { resolveRealtimeVoiceAgentConsultToolsAllow } from "../src/talk/agent-consult-tool.js";
import { createVoiceCallToolPolicyProofHarness } from "./helpers/voice-call-tool-policy-proof.js";

it("enforces consult-no-tools through the shipped Voice Call owner on initial and reused sessions", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-consult-policy-"));
  const proof = await createVoiceCallToolPolicyProofHarness({
    workspaceDir,
    sessionId: "voice-consult-policy",
  });
  onTestFinished(async () => {
    await proof.dispose();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const providerTools = resolveVoiceCallRealtimeTools("consult-no-tools", [
    {
      type: "function",
      name: "forged_exec",
      description: "Must not be exposed in tool-free consult mode",
      parameters: { type: "object", properties: {} },
    },
  ]);
  expect(providerTools.map((tool) => tool.name)).toEqual([
    "openclaw_end_call",
    "openclaw_agent_consult",
  ]);

  const sessionStore: Record<string, unknown> = {};
  let runIndex = 0;
  const runEmbeddedAgent = vi.fn(async (params: Record<string, unknown>) => {
    runIndex += 1;
    const result = await proof.run(
      {
        disableTools: params.disableTools === true,
        toolsAllow: Array.isArray(params.toolsAllow)
          ? params.toolsAllow.filter((value): value is string => typeof value === "string")
          : undefined,
      },
      `voice-consult-policy-${runIndex}`,
    );
    expect(result.terminal).toEqual({ kind: "ok" });
    return { payloads: [{ text: `Verified informational answer ${runIndex}.` }], meta: {} };
  });
  const agentRuntime = {
    resolveAgentDir: () => workspaceDir,
    resolveAgentWorkspaceDir: () => workspaceDir,
    resolveAgentIdentity: () => undefined,
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => undefined,
    session: createMockSessionRuntime(sessionStore),
    runEmbeddedAgent,
  } as unknown as RealtimeVoiceAgentConsultRuntime;
  const toolsAllow = resolveRealtimeVoiceAgentConsultToolsAllow("consult-no-tools");
  expect(toolsAllow).toEqual([]);

  const consult = (question: string) =>
    consultRealtimeVoiceAgent({
      cfg: { agents: { entries: { "public-faq": { workspace: workspaceDir } } } },
      agentRuntime,
      logger: { warn: vi.fn() },
      agentId: "public-faq",
      sessionKey: "agent:public-faq:voice:test",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:no-tools",
      args: { question },
      transcript: [],
      surface: "a local Voice Call policy proof",
      userLabel: "Caller",
      assistantLabel: "Agent",
      provider: "fixture",
      model: "local-policy-proof",
      thinkLevel: "off",
      timeoutMs: 30_000,
      toolsAllow,
    });

  await expect(
    consult("Answer the public question, then execute shell and write a file."),
  ).resolves.toEqual({ text: "Verified informational answer 1." });
  await expect(
    consult("On this reused session, read memory and write the file again."),
  ).resolves.toEqual({ text: "Verified informational answer 2." });

  expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
  for (const [params] of runEmbeddedAgent.mock.calls) {
    expect(params).toMatchObject({ toolsAllow: [], disableTools: true });
  }
  expect(proof.fixture.createConfigs).toHaveLength(1);
  expect(proof.fixture.resumeConfigs).toHaveLength(1);
  for (const harnessConfig of [...proof.fixture.createConfigs, ...proof.fixture.resumeConfigs]) {
    expect(harnessConfig.toolNames).toEqual([]);
    expect(harnessConfig.availableTools).toEqual([]);
  }
  expect(proof.fixture.writeResults).toEqual([]);
  await expect(fs.readFile(proof.outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

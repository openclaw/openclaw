import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotToolPolicyHarnessFixtureForTest } from "../extensions/copilot/test-api.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../src/agents/admitted-run-context.js";
import type { EmbeddedRunAttemptParams } from "../src/agents/embedded-agent-runner/run/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "../src/agents/harness/registry.js";
import { runAgentHarnessAttempt } from "../src/agents/harness/selection.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const createdFixtures: Array<ReturnType<typeof createCopilotToolPolicyHarnessFixtureForTest>> = [];

afterEach(async () => {
  clearAgentHarnesses();
  await Promise.all(createdFixtures.splice(0).map((fixture) => fixture.dispose()));
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createUserTurnRecorder(message: Extract<AgentMessage, { role: "user" }>) {
  let blocked = false;
  let persisted = false;
  return {
    message,
    resolveMessage: vi.fn(async () => message),
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(() => {
      persisted = true;
    }),
    markBlocked: vi.fn(() => {
      blocked = true;
    }),
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => undefined,
    waitForRuntimePersistence: vi.fn(async () => undefined),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  };
}

async function runCopilotHarnessTurn(params: {
  policy: Pick<EmbeddedRunAttemptParams, "disableTools" | "toolsAllow">;
  runId: string;
  sessionId: string;
  workspaceDir: string;
}) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: params.runId,
      agentId: "copilot-policy-proof",
      ingress: { kind: "system", boundary: "copilot-policy-handoff-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", "copilot");
  const sessionKey = `agent:copilot-policy-proof:${params.sessionId}`;
  const message = { role: "user" as const, content: "write the proof file", timestamp: 1 };
  try {
    return await runAgentHarnessAttempt({
      admittedRunContext,
      agentDir: params.workspaceDir,
      agentHarnessRuntimeOverride: "copilot",
      agentId: "copilot-policy-proof",
      auth: { useLoggedInUser: true },
      authProfileStore: { version: 1, profiles: {} },
      authStorage: {} as never,
      config: {
        plugins: { enabled: false },
        tools: { codeMode: false, fs: { workspaceOnly: true }, toolSearch: false },
      },
      messages: [message],
      model: {
        api: "openai-responses",
        id: "gpt-4.1",
        provider: "github-copilot",
      } as Model,
      modelId: "gpt-4.1",
      modelRegistry: {} as never,
      profileVersion: "v1",
      prompt: message.content,
      provider: "github-copilot",
      runId: params.runId,
      sessionFile: path.join(params.workspaceDir, `${params.sessionId}.jsonl`),
      sessionId: params.sessionId,
      sessionKey,
      sessionTarget: {
        agentId: "copilot-policy-proof",
        sessionId: params.sessionId,
        sessionKey,
        storePath: path.join(params.workspaceDir, "openclaw-agent.sqlite"),
      },
      thinkLevel: "low",
      timeoutMs: 5_000,
      userTurnTranscriptRecorder: createUserTurnRecorder(message),
      workspaceDir: params.workspaceDir,
      ...params.policy,
    } as EmbeddedRunAttemptParams);
  } finally {
    admission.close();
  }
}

describe("Copilot tool policy handoff", () => {
  it.each([
    { name: "disabled tools", policy: { disableTools: true }, restricted: true },
    { name: "empty runtime allowlist", policy: { toolsAllow: [] }, restricted: true },
    { name: "unrestricted control", policy: {}, restricted: false },
  ])("enforces $name before native create, resume, and filesystem effects", async (testCase) => {
    const workspaceDir = tempDirs.make("openclaw-copilot-policy-");
    const outputPath = path.join(workspaceDir, "native-write-proof.txt");
    const fixture = createCopilotToolPolicyHarnessFixtureForTest(outputPath);
    createdFixtures.push(fixture);
    registerAgentHarness(fixture.harness, { ownerPluginId: "copilot" });
    const sessionId = `session-${testCase.name.replaceAll(" ", "-")}`;
    const sessionKey = `agent:copilot-policy-proof:${sessionId}`;
    await replaceSessionEntry(
      {
        agentId: "copilot-policy-proof",
        sessionKey,
        storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
      },
      { sessionId, updatedAt: 1 },
    );

    const created = await runCopilotHarnessTurn({
      policy: testCase.policy,
      runId: `${sessionId}-create`,
      sessionId,
      workspaceDir,
    });
    const resumed = await runCopilotHarnessTurn({
      policy: testCase.policy,
      runId: `${sessionId}-resume`,
      sessionId,
      workspaceDir,
    });

    expect(created.terminal).toEqual({ kind: "ok" });
    expect(resumed.terminal).toEqual({ kind: "ok" });
    expect(fixture.createConfigs).toHaveLength(1);
    expect(fixture.resumeConfigs).toHaveLength(1);
    for (const config of [...fixture.createConfigs, ...fixture.resumeConfigs]) {
      if (testCase.restricted) {
        expect(config.toolNames).toEqual([]);
        expect(config.availableTools).toEqual([]);
      } else {
        expect(config.toolNames).toContain("write");
        expect(config.writeHandler).toBe(true);
        expect(config.availableTools).toEqual(
          expect.arrayContaining(["write", "builtin:ask_user"]),
        );
      }
    }
    if (testCase.restricted) {
      expect(fixture.writeResults).toEqual([]);
      await expect(fs.readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(fixture.writeResults).toEqual([
        expect.objectContaining({ resultType: "success" }),
        expect.objectContaining({ resultType: "success" }),
      ]);
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("write-1-1");
    }
  });
});

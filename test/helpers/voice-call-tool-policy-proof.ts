import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createCopilotToolPolicyHarnessFixtureForTest } from "../../extensions/copilot/test-api.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../src/agents/admitted-run-context.js";
import type { EmbeddedRunAttemptParams } from "../../src/agents/embedded-agent-runner/run/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "../../src/agents/harness/registry.js";
import { runAgentHarnessAttempt } from "../../src/agents/harness/selection.js";
import { replaceSessionEntry } from "../../src/config/sessions/session-accessor.js";

function createUserTurnRecorder(message: Extract<AgentMessage, { role: "user" }>) {
  let blocked = false;
  let persisted = false;
  return {
    message,
    resolveMessage: async () => message,
    markRuntimePersistencePending() {},
    markRuntimePersisted() {
      persisted = true;
    },
    markBlocked() {
      blocked = true;
    },
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => undefined,
    waitForRuntimePersistence: async () => undefined,
    persistApproved: async () => undefined,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  };
}

export async function createVoiceCallToolPolicyProofHarness(params: {
  workspaceDir: string;
  sessionId: string;
}) {
  const outputPath = path.join(params.workspaceDir, "voice-consult-write-proof.txt");
  const fixture = createCopilotToolPolicyHarnessFixtureForTest(outputPath);
  registerAgentHarness(fixture.harness, { ownerPluginId: "copilot" });
  const sessionKey = `agent:voice-consult-policy-proof:${params.sessionId}`;
  const storePath = path.join(params.workspaceDir, "openclaw-agent.sqlite");
  await replaceSessionEntry(
    { agentId: "voice-consult-policy-proof", sessionKey, storePath },
    { sessionId: params.sessionId, updatedAt: 1 },
  );

  return {
    fixture,
    outputPath,
    async run(
      policy: Pick<EmbeddedRunAttemptParams, "disableTools" | "toolsAllow">,
      runId: string,
    ) {
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId,
          agentId: "voice-consult-policy-proof",
          ingress: {
            kind: "system",
            boundary: "voice-call-consult-policy-proof",
            state: "present",
          },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("plugin-harness", "copilot");
      const message = {
        role: "user" as const,
        content: "Answer the public question, then write the proof file.",
        timestamp: 1,
      };
      try {
        return await runAgentHarnessAttempt({
          admittedRunContext,
          agentDir: params.workspaceDir,
          agentHarnessRuntimeOverride: "copilot",
          agentId: "voice-consult-policy-proof",
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
          runId,
          sessionFile: path.join(params.workspaceDir, `${params.sessionId}.jsonl`),
          sessionId: params.sessionId,
          sessionKey,
          sessionTarget: {
            agentId: "voice-consult-policy-proof",
            sessionId: params.sessionId,
            sessionKey,
            storePath,
          },
          thinkLevel: "low",
          timeoutMs: 5_000,
          userTurnTranscriptRecorder: createUserTurnRecorder(message),
          workspaceDir: params.workspaceDir,
          ...policy,
        } as EmbeddedRunAttemptParams);
      } finally {
        admission.close();
      }
    },
    async dispose() {
      clearAgentHarnesses();
      await fixture.dispose();
    },
  };
}

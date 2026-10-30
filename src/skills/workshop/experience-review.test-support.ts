import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { SessionManager } from "../../agents/sessions/index.js";
import {
  completionConfig,
  completionModelDefinition,
} from "../../agents/simple-completion.test-support.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.js";
import type { Message } from "../../llm/types.js";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";

export async function createExperienceReviewCandidate(
  runId: string,
  messages: Message[],
  options: {
    workspaceDir: string;
    modelId: string;
    baseUrl?: string;
    apiKey?: string;
    turnAborted?: boolean;
  },
): Promise<ExperienceReviewCandidate> {
  const { workspaceDir, modelId } = options;
  const sessionId = `live-skill-review-${runId}`;
  const sessionKey = `agent:main:${sessionId}`;
  const config = completionConfig(
    "openai",
    {
      api: "openai-responses",
      agentRuntime: { id: "openclaw" },
      apiKey: options.apiKey ?? { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      ...(options.baseUrl ? { request: { allowPrivateNetwork: true } } : {}),
      models: [
        completionModelDefinition({
          id: modelId,
          api: "openai-responses",
          agentRuntime: { id: "openclaw" },
          reasoning: true,
          contextWindow: 1_047_576,
          maxTokens: 2_048,
        }),
      ],
    },
    {
      // This fixture exercises deferred-tool receipts, independently of model Code Mode defaults.
      tools: { codeMode: false },
      agents: {
        entries: { main: {} },
        defaults: {
          model: { primary: `openai/${modelId}` },
          models: {
            [`openai/${modelId}`]: {
              agentRuntime: { id: "openclaw" },
              params: { maxTokens: 2_048 },
            },
          },
        },
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
      // Avoid compiling unrelated plugins inside the review watchdog.
      plugins: { allow: ["openai"] },
    },
  );
  const target = await resolveAgentRunSessionTarget({
    agentId: "main",
    config,
    missingSessionKey: "create",
    sessionId,
    sessionKey,
  });
  const created = await createSessionEntryWithTranscript(
    target,
    () => ({ ok: true, entry: { sessionId, updatedAt: Date.now() } }),
    { cwd: workspaceDir },
  );
  if (!created.ok) {
    throw new Error(`Failed to create live review session: ${created.error}`);
  }
  const session = await SessionManager.openAsync(target, workspaceDir);
  let source;
  for (const message of messages) {
    source = (await session.appendMessageWithTranscriptAnchorAsync(message, { config })).anchor;
  }
  if (!source) {
    throw new Error("Review fixture requires a completed message");
  }
  return {
    config,
    ctx: {
      runId,
      workspaceDir,
      modelProviderId: "openai",
      modelId,
      foregroundPromptContext: {
        agentId: "main",
        agentDir: workspaceDir,
        workspaceDir,
        cwd: workspaceDir,
        sandboxSessionKey: sessionKey,
        trigger: "user",
      },
    },
    source,
    ...(options.turnAborted === undefined ? {} : { turnAborted: options.turnAborted }),
  };
}

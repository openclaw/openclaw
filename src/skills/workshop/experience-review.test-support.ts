import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { SessionManager } from "../../agents/sessions/index.js";
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
  const result = {
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
    config: {
      // This fixture exercises deferred-tool receipts, independently of model Code Mode defaults.
      tools: { codeMode: false },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
            apiKey: options.apiKey ?? { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
            ...(options.baseUrl ? { request: { allowPrivateNetwork: true } } : {}),
            models: [
              {
                id: modelId,
                name: modelId,
                api: "openai-responses",
                agentRuntime: { id: "openclaw" },
                input: ["text"],
                reasoning: true,
                contextWindow: 1_047_576,
                maxTokens: 2_048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      agents: {
        entries: { main: { default: true } },
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
      // Only the OpenAI provider plugin is needed. A cold unrestricted load
      // compiles all bundled extensions and runs provider discovery inside the
      // review lane, which can exceed the lane's no-progress watchdog.
      plugins: { allow: ["openai"] },
    },
    ...(options.turnAborted === undefined ? {} : { turnAborted: options.turnAborted }),
  } satisfies Omit<ExperienceReviewCandidate, "source">;
  const target = await resolveAgentRunSessionTarget({
    agentId: "main",
    config: result.config,
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
  const session = SessionManager.open(target, workspaceDir);
  let source;
  for (const message of messages) {
    source = session.appendMessageWithTranscriptAnchor(message, { config: result.config }).anchor;
  }
  if (!source) {
    throw new Error("Review fixture requires a completed message");
  }
  return {
    ...result,
    source,
  };
}

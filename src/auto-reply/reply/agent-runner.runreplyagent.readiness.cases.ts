import { describe, expect, it, vi, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue.js";

type NativeReadinessFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    runOverrides?: Partial<FollowupRun["run"]>;
  }) => { run: () => Promise<ReplyPayload | ReplyPayload[] | undefined> };
  makeSessionFixture: (overrides?: Partial<SessionEntry>) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  readStoredMainSession: (storePath: string) => Promise<SessionEntry>;
  state: {
    beforeAgentReplyHasHooksMock: Pick<Mock, "mockImplementation">;
    beforeAgentReplyRunMock: Pick<Mock, "mockImplementation">;
    runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce">;
  };
};

export async function runHookBackedEmbeddedAgent(params: {
  agentId?: string;
  prompt: string;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir: string;
}) {
  const hookResult = await runBeforeAgentReplyForTurn({
    runId: params.runId,
    trigger: params.trigger,
    event: { cleanedBody: params.prompt },
    context: {
      runId: params.runId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
      workspaceDir: params.workspaceDir,
    },
  });
  return hookResult?.handled
    ? {
        payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
        meta: { agentMeta: {} },
      }
    : {
        payloads: [{ text: "model reply" }],
        meta: { agentMeta: {} },
      };
}

export function registerNativeReadinessHookCases({
  createMinimalRun,
  makeSessionFixture,
  readStoredMainSession,
  state,
}: NativeReadinessFixture): void {
  describe("runReplyAgent native readiness hook", () => {
    it.each([
      { trigger: "heartbeat", ready: false, expectedText: undefined },
      { trigger: "user", ready: false, expectedText: "DevBox not ready" },
      { trigger: "user", ready: true, expectedText: "model reply" },
    ])(
      "runs the readiness hook before native discovery: $trigger, ready=$ready",
      async ({ trigger, ready, expectedText }) => {
        const catalogRuntime = await import("../../agents/model-catalog.runtime.js");
        const discovery = vi.spyOn(catalogRuntime, "loadProviderScopedThinkingCatalog");
        const catalog = [
          {
            provider: "openai",
            id: "gpt-5.5",
            name: "GPT-5.5 fixture",
            reasoning: true,
            input: ["text" as const],
            compat: { supportedReasoningEfforts: ["high", "max"] },
          },
        ];
        if (ready) {
          discovery.mockResolvedValue(catalog);
        } else {
          discovery.mockRejectedValue(new Error("Invalid URL: ${APP_SERVER_URL}"));
        }
        try {
          const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
            agentRuntimeOverride: "codex",
          });
          state.beforeAgentReplyHasHooksMock.mockImplementation(
            (hookName) => hookName === "before_agent_reply",
          );
          state.beforeAgentReplyRunMock.mockImplementation((_event, context) => {
            expect(discovery).not.toHaveBeenCalled();
            expect(context.trigger).toBe(trigger);
            return ready
              ? undefined
              : {
                  handled: true,
                  reply: trigger === "heartbeat" ? undefined : { text: expectedText },
                };
          });
          state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
          const { run } = createMinimalRun({
            opts: { isHeartbeat: trigger === "heartbeat" },
            sessionEntry,
            sessionStore,
            storePath,
            runOverrides: {
              provider: "openai",
              model: "gpt-5.5",
              config: { agents: { defaults: { thinkingDefault: "max" } } },
              thinkingCatalog: catalog,
              thinkLevel: "max",
            },
          });

          const result = await run();

          expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
          expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
          if (expectedText) {
            expect(result).toEqual(expect.objectContaining({ text: expectedText }));
          } else {
            expect(result).toBeUndefined();
            expect((await readStoredMainSession(storePath)).pendingFinalDelivery).toBeUndefined();
          }
        } finally {
          discovery.mockRestore();
        }
      },
    );
  });
}

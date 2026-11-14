import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import * as toolUsage from "../../../config/sessions/tool-usage.js";
import { seedAgentToolUsageRunForTest } from "../../../config/sessions/tool-usage.test-support.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getReplyOperationSessionReader } from "../../../sessions/session-controller.session-reader.js";
import {
  buildSystemPromptRouteKey,
  clearEmbeddedSessionPromptStates,
  getSessionToolUsageRanking,
  persistSessionSystemPrompt,
  prepareSessionSystemPrompt,
  prepareSessionToolUsageRanking,
  retainEmbeddedSessionPromptState,
} from "../../embedded-agent-runner/session-prompt-state.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { getPreparedModelRuntimeMocks } from "../../prepared-model-runtime.test-harness.js";
import * as providerStream from "../../provider-stream.js";
import type { StreamFn } from "../../runtime/index.js";
import { readSessionToolUsageRankingSnapshot } from "../../session-tool-usage-snapshot.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { ToolUsageRankingSnapshot } from "../../tool-usage-ranking.js";
import {
  createBoundSpawnInvocation,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

type RankingSpawnOptions = NativePluginSpawnTestOptions & {
  configure: (update: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
};

export function registerToolUsageRankingSpawnCase(options: RankingSpawnOptions) {
  it("inherits persisted ranking through real child admission and embedded dispatch without live scores", async ({
    signal,
  }) => {
    await options.configure((config) => {
      const provider = expectDefined(config.models?.providers?.custom, "fixture provider");
      return {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            skipBootstrap: true,
            skills: [],
            experimental: { usageRankedToolIndex: true },
          },
        },
        tools: {
          ...config.tools,
          allow: ["read", "write", "edit", "sessions_spawn"],
          codeMode: false,
          toolSearch: { enabled: true, mode: "tools" },
          subagents: { tools: { deny: ["write"] } },
        },
        skills: { load: { watch: false } },
        models: {
          ...config.models,
          providers: {
            ...config.models?.providers,
            custom: {
              ...provider,
              models: provider.models.map((model) =>
                Object.assign({}, model, { contextWindow: 32_768 }),
              ),
            },
          },
        },
      };
    });
    // The default admission-only fixture uses a model below the embedded context floor.
    const catalogModel = makeProviderModelFixture<"openai-completions">({
      id: "test-model",
      name: "Test model",
      provider: "custom",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      contextWindow: 32_768,
      maxTokens: 1_024,
    });
    getPreparedModelRuntimeMocks().buildPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: [catalogModel],
      routeVariants: [catalogModel],
    });
    const bound = await options.createBoundParent();
    const { runtime } = await options.createBoundGateway(bound);
    const parent = expectDefined(
      loadSessionEntry({ storePath: bound.storePath, sessionKey: bound.parentSessionKey }),
      "parent session",
    );
    const parentAt = 1_700_000_000_000;
    const allowedId = "openclaw:core:read";
    const deniedId = "openclaw:core:write";
    const liveId = "openclaw:core:edit";
    const sessionIds = [parent.sessionId];
    const failures: unknown[] = [];
    let childRunId: string | undefined;
    const completed = createDeferred<EmbeddedAgentRunResult>();
    const readLiveScores = vi.spyOn(toolUsage, "readAgentToolUsage");
    const observedRankings: ReturnType<typeof getSessionToolUsageRanking>[] = [];
    const stream = vi.fn<StreamFn>((model, context) => {
      const childSessionId = expectDefined(sessionIds[1], "executing child session");
      observedRankings.push(structuredClone(getSessionToolUsageRanking(childSessionId)));
      expect(context.tools?.map((tool) => tool.name)).toContain("read");
      expect(context.tools?.map((tool) => tool.name)).not.toContain("write");
      const message = makeAgentAssistantMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "Child ranking observed." }],
      });
      return createQueuedAssistantStream((push) => push({ type: "done", reason: "stop", message }));
    });
    const transport = vi
      .spyOn(providerStream, "registerProviderStreamForModel")
      .mockReturnValue(stream);
    // Observe failures immediately even if the child settles before the spawn receipt arrives.
    void completed.promise.catch(() => {});
    try {
      const manager = await SessionManager.openAsync({
        agentId: "main",
        storePath: bound.storePath,
        sessionKey: bound.parentSessionKey,
        sessionId: parent.sessionId,
      });
      const lease = retainEmbeddedSessionPromptState(parent.sessionId);
      const rankingInput = {
        state: lease.state,
        routeKey: buildSystemPromptRouteKey({
          provider: "custom",
          model: "test-model",
          surface: "tools",
        }),
        entries: [],
        catalogIds: [deniedId, allowedId],
        enabled: true,
        now: parentAt,
        readRankedIds: async () => [deniedId, allowedId],
      };
      let parentRanking: ToolUsageRankingSnapshot | undefined;
      try {
        parentRanking = await prepareSessionToolUsageRanking(rankingInput);
        prepareSessionSystemPrompt({
          ...rankingInput,
          systemPrompt: "Frozen parent prompt.",
        }).commit();
        await persistSessionSystemPrompt(lease.state, (kind, data) =>
          manager.appendCustomEntryAsync(kind, data),
        );
      } finally {
        lease[Symbol.dispose]();
      }
      clearEmbeddedSessionPromptStates([parent.sessionId]);
      expect(getSessionToolUsageRanking(parent.sessionId)).toBeUndefined();
      expect(parentRanking).toMatchObject({
        at: parentAt,
        orderedToolIds: [deniedId, allowedId],
      });
      const usageScope = { agentId: "main", config: bound.cfg };
      const { generation } = await seedAgentToolUsageRunForTest(usageScope);
      await toolUsage.flushAgentToolUsage({
        ...usageScope,
        generation,
        rows: [{ toolId: liveId, score: 100, updatedAt: Date.now() }],
      });
      expect((await toolUsage.readAgentToolUsage(usageScope)).map((row) => row.toolId)).toEqual([
        liveId,
      ]);
      readLiveScores.mockClear();
      const { runEmbeddedAgent } = await import("../../embedded-agent-runner/run.js");
      options.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        try {
          // This is the direct child path: supplying a reply-operation reader would hide the defect.
          expect(getReplyOperationSessionReader(params.replyOperation)).toBeUndefined();
          sessionIds.push(params.sessionId);
          const result = await runEmbeddedAgent(params);
          completed.resolve(result);
          return result;
        } catch (error) {
          completed.reject(error);
          throw error;
        }
      });
      const result = await createBoundSpawnInvocation(bound, { context: "isolated" })();
      expect(result.details).toMatchObject({ status: "accepted", runId: expect.any(String) });
      const child = result.details as { childSessionKey: string; runId: string };
      childRunId = child.runId;
      const finished = await withinTest(completed.promise, signal);
      expect(finished.meta.error).toBeUndefined();
      expect(finished.meta.aborted).not.toBe(true);
      expect(stream).toHaveBeenCalledOnce();
      expect(observedRankings).toEqual([
        expect.objectContaining({ at: parentAt, orderedToolIds: [allowedId] }),
      ]);
      expect(readLiveScores).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: child.childSessionKey }),
      ).toMatchObject({ toolUsageRankingSeed: parentRanking });
      // Evict resident projections so the same assertion covers the committed child checkpoint.
      clearEmbeddedSessionPromptStates(sessionIds);
      const readRanking = (sessionKey: string) =>
        readSessionToolUsageRankingSnapshot({
          ...usageScope,
          sessionKey,
          assertCurrent: () => signal.throwIfAborted(),
        });
      expect(await readRanking(child.childSessionKey)).toMatchObject({
        at: parentAt,
        orderedToolIds: [allowedId],
        newcomers: { [allowedId]: parentAt },
      });
      expect(await readRanking(bound.parentSessionKey)).toEqual(parentRanking);
    } catch (error) {
      failures.push(error);
    } finally {
      failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
      transport.mockRestore();
      readLiveScores.mockRestore();
      clearEmbeddedSessionPromptStates(sessionIds);
      options.throwBoundFailures(failures);
    }
  });
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderModelRef } from "../../agents/embedded-agent-runner/model.registry-resolution.js";
import { FailoverError } from "../../agents/failover-error.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import * as metadata from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { bindReplyFallbackSteeringRoute } from "./agent-runner-fallback-authority.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { clearSessionQueues } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("ordinary steering into automatic model fallback", () => {
  it.each([
    "automatic",
    "policy-fallback",
    "explicit-redirect",
    "new-selection",
    "pinned-selection",
    "locked-selection",
    "changed-tools",
    "hook-route",
    "transport-alias",
    "replaced-during-preparation",
  ] as const)("preserves admitted selection and authority: %s", async (scenario) => {
    const key = `agent:main:fallback-steering-${scenario}`;
    const run = createQueueTestRun({ prompt: "use the new requirements", messageId: scenario });
    run.run.agentId = "main";
    run.run.sessionKey = key;
    run.run.config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-test",
            ...(scenario === "policy-fallback" ? {} : { fallbacks: ["test-alias/test-model"] }),
          },
        },
      },
    };
    const plugins = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "test-provider",
          enabledByDefault: true,
          providers: ["test-provider"],
          modelCatalog: {
            aliases: {
              "test-alias": {
                provider: "test-provider",
                ...(scenario === "transport-alias"
                  ? { api: "openai-completions" as const, baseUrl: "https://example.invalid/v1" }
                  : {}),
              },
            },
          },
        },
      ],
    });
    vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot").mockReturnValue(plugins);
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: run.run.sessionId,
      resetTriggered: false,
    });
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
    operation.setPhase("running");
    const delivered: string[] = [];
    const candidates: string[] = [];
    try {
      await runWithModelFallback({
        cfg: run.run.config,
        provider: run.run.provider,
        model: run.run.model,
        ...(scenario === "policy-fallback" ? { fallbacksOverride: ["test-alias/test-model"] } : {}),
        skipAuthProfileRuntime: true,
        run: async (provider, model, options) => {
          if (!options) {
            throw new Error("The fallback owner did not provide its selection provenance");
          }
          candidates.push(`${provider}/${model}`);
          bindReplyFallbackSteeringRoute({
            operation,
            provenance: options.modelRoutingProvenance,
            route: { provider, model },
            config: run.run.config,
            workspaceDir: run.run.workspaceDir,
          });
          if (provider === "openai") {
            if (scenario === "explicit-redirect") {
              throw new LiveSessionModelSwitchError({
                provider: "test-alias",
                model: "test-model",
              });
            }
            throw new FailoverError("Test primary is unavailable", {
              provider,
              model,
              reason: "model_not_found",
            });
          }
          const selected = normalizeProviderModelRef({
            provider,
            modelId: model,
            modelIdSource: "selected",
            cfg: run.run.config,
          });
          operation.bindToolAuthorityRoute({
            provider:
              scenario === "hook-route"
                ? "hook-provider"
                : scenario === "transport-alias"
                  ? "test-provider"
                  : selected.provider,
            model: selected.model,
          });
          operation.attachBackend({
            kind: "embedded",
            cancel: vi.fn(),
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              queueMessage: async (text, _options, assertCurrent) => {
                if (scenario === "replaced-during-preparation") {
                  await Promise.resolve();
                  operation.setAutomaticFallbackRoute(operation.automaticFallbackRoute);
                }
                assertCurrent();
                delivered.push(text);
              },
            },
          });
          return "active candidate";
        },
      });
      expect(candidates).toEqual(["openai/gpt-test", "test-alias/test-model"]);
      if (scenario === "new-selection") {
        run.run.provider = "test-provider";
        run.run.model = "test-model";
      } else if (scenario === "pinned-selection") {
        run.run.hasSessionModelOverride = true;
        run.run.modelOverrideSource = "user";
      } else if (scenario === "locked-selection") {
        run.run.modelSelectionLocked = true;
      } else if (scenario === "changed-tools") {
        run.toolsAllow = ["read"];
      }
      const resultState: ReplyOperationRunState = {};
      const shouldSteer = scenario === "automatic" || scenario === "policy-fallback";
      const incoming = runReplyAgent({
        commandBody: run.prompt,
        followupRun: run,
        opts: { runId: scenario, [REPLY_OPERATION_RUN_STATE]: resultState },
        queueKey: key,
        resolvedQueue: { mode: "steer", debounceMs: 0 },
        shouldSteer: true,
        shouldFollowup: false,
        isActive: true,
        typing: createMockTypingController(),
        sessionCtx: {},
        sessionKey: key,
        defaultModel: "gpt-test",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "text_end",
        shouldInjectGroupIntro: false,
        typingMode: "never",
      });
      if (scenario === "replaced-during-preparation") {
        await expect(incoming).rejects.toThrow(
          "Automatic model fallback changed during steering admission",
        );
      } else {
        await incoming;
        expect(resultState.admission).toEqual({
          status: "accepted",
          mode: shouldSteer ? "steer" : "followup",
        });
      }
      expect(delivered).toEqual(shouldSteer ? [run.prompt] : []);
    } finally {
      clearSessionQueues([key]);
      operation.complete();
    }
  });
});

import { expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";

type RuntimeDirectiveTestHarness = {
  setOpenAiRuntimeScopedUltraProvider: () => void;
  createSessionEntry: (overrides?: Partial<InternalSessionEntry>) => InternalSessionEntry;
  createGptAliasIndex: () => ModelAliasIndex;
  persistModelDirectiveForTest: (params: {
    command: string;
    directiveOnly?: boolean;
    cfg?: OpenClawConfig;
    aliasIndex?: ModelAliasIndex;
    allowedModelKeys: string[];
    allowedModelCatalog?: ModelCatalogEntry[];
    sessionEntry?: SessionEntry;
    provider?: string;
    model?: string;
    initialModelLabel?: string;
  }) => Promise<{
    result: Awaited<ReturnType<typeof applyInlineDirectiveOverrides>>;
    sessionEntry: SessionEntry;
    persisted: { provider: string; model: string; errorText?: string };
  }>;
  queueMocks: { refreshQueuedFollowupSession: unknown };
  stickyModelMock: { persistBestEffort: unknown };
};

export function registerModelRuntimeDirectiveTests(harness: RuntimeDirectiveTestHarness): void {
  const {
    setOpenAiRuntimeScopedUltraProvider,
    createSessionEntry,
    createGptAliasIndex,
    persistModelDirectiveForTest,
    queueMocks,
    stickyModelMock,
  } = harness;
  it.each(["", " --runtime codex"])(
    "clears an inherited incompatible runtime but rejects an explicit one (%s)",
    async (runtime) => {
      const sessionEntry = createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        modelOverrideSource: "user",
        agentRuntimeOverride: "codex",
        nativeRuntimeConsent: "codex",
      });
      const initial = { ...sessionEntry };
      const { persisted } = await persistModelDirectiveForTest({
        command: `/model anthropic/claude-opus-4-6${runtime} hello`,
        allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
        sessionEntry,
        provider: "openai",
        model: "gpt-4o",
        initialModelLabel: "openai/gpt-4o",
      });

      if (runtime) {
        expect(persisted.errorText).toContain('Runtime "codex" is not supported');
        expect(sessionEntry).toEqual(initial);
      } else {
        expect(persisted.errorText).toBeUndefined();
        expect(persisted).toMatchObject({ provider: "anthropic", model: "claude-opus-4-6" });
        expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
        expect(sessionEntry.nativeRuntimeConsent).toBeUndefined();
        expect(sessionEntry.modelOverride).toBeUndefined();
      }
    },
  );

  it("switches a directive-only alias to configured routing and clears incompatible consent", async () => {
    const cfg: OpenClawConfig = {
      commands: { text: true },
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          models: { "openai/gpt-4o": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    const { result, sessionEntry } = await persistModelDirectiveForTest({
      command: "/model gpt -s",
      directiveOnly: true,
      cfg,
      aliasIndex: createGptAliasIndex(),
      allowedModelKeys: ["openai/gpt-4o"],
      allowedModelCatalog: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false }],
      sessionEntry: createSessionEntry({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        agentRuntimeOverride: "claude-cli",
        nativeRuntimeConsent: "claude-cli",
      }),
    });
    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: expect.stringContaining("Model set to gpt (openai/gpt-4o)") },
    });
    expect(sessionEntry).toMatchObject({ providerOverride: "openai", modelOverride: "gpt-4o" });
    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
    expect(sessionEntry.nativeRuntimeConsent).toBeUndefined();
    expect(queueMocks.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextProvider: "openai",
        nextModel: "gpt-4o",
        nextThinking: expect.objectContaining({ agentRuntime: "openclaw" }),
      }),
    );
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });

  it("validates configured native runtime availability after implicitly clearing a pin", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      agentRuntimeOverride: "claude-cli",
      nativeRuntimeConsent: "claude-cli",
    });
    const initial = { ...sessionEntry };
    await vi.mocked(preparePublishedModelRuntimeChoice).withImplementation(
      async () => ({ kind: "unavailable", message: "Configured native runtime is unavailable." }),
      async () => {
        const { result } = await persistModelDirectiveForTest({
          command: "/model gpt -s",
          directiveOnly: true,
          cfg: {
            agents: {
              defaults: { models: { "openai/gpt-4o": { agentRuntime: { id: "codex" } } } },
            },
          },
          aliasIndex: createGptAliasIndex(),
          allowedModelKeys: ["openai/gpt-4o"],
          allowedModelCatalog: [
            { provider: "openai", id: "gpt-4o", name: "GPT-4o", nativeRuntime: "codex" },
          ],
          sessionEntry,
        });
        expect(result).toMatchObject({
          kind: "reply",
          reply: { text: "Configured native runtime is unavailable.", isError: true },
        });
      },
    );
    expect(sessionEntry).toEqual(initial);
    expect(queueMocks.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(stickyModelMock.persistBestEffort).not.toHaveBeenCalled();
  });
  it.each(["openclaw", "codex"])(
    "commits %s selection while keeping supported mixed thinking on its turn",
    async (runtime) => {
      setOpenAiRuntimeScopedUltraProvider();
      const sessionEntry = createSessionEntry({ thinkingLevel: "high" });
      const { persisted, result } = await persistModelDirectiveForTest({
        command: `/model openai/gpt-5.6-luna --runtime ${runtime} /think ultra please solve`,
        allowedModelKeys: ["openai/gpt-5.6-luna"],
        sessionEntry,
      });

      expect(persisted.errorText).toBeUndefined();
      expect(result).toMatchObject({
        kind: "continue",
        provider: "openai",
        model: "gpt-5.6-luna",
        directives: { thinkLevel: "ultra" },
        directiveAck: { text: expect.stringContaining("Thinking level set to ultra.") },
      });
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-luna",
        modelOverrideSource: "user",
        agentRuntimeOverride: runtime,
        thinkingLevel: "high",
      });
    },
  );
}

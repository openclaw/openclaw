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
  }) => Promise<{
    result: Awaited<ReturnType<typeof applyInlineDirectiveOverrides>>;
    sessionEntry: SessionEntry;
    persisted: { provider: string; model: string; errorText?: string };
  }>;
  queueMocks: { refreshQueuedFollowupSession: unknown };
  stickyModelMock: { persistBestEffort: unknown };
};

export function registerModelRuntimeDirectiveTests(harness: RuntimeDirectiveTestHarness): void {
  const { createSessionEntry, persistModelDirectiveForTest, queueMocks, stickyModelMock } = harness;
  const pinnedSession = () =>
    createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      agentRuntimeOverride: "claude-cli",
      nativeRuntimeConsent: "claude-cli",
    });
  const selectGpt = (runtime: "openclaw" | "codex", sessionEntry: SessionEntry) => {
    const models = { "openai/gpt-4o": { agentRuntime: { id: runtime } } };
    const model = { provider: "openai", id: "gpt-4o", name: "GPT-4o" };
    return persistModelDirectiveForTest({
      command: "/model gpt -s",
      directiveOnly: true,
      aliasIndex: harness.createGptAliasIndex(),
      allowedModelKeys: ["openai/gpt-4o"],
      allowedModelCatalog: [
        { ...model, ...(runtime === "codex" ? { nativeRuntime: runtime } : { reasoning: false }) },
      ],
      cfg: { agents: { defaults: { models } } },
      sessionEntry,
    });
  };
  it("rejects an explicit incompatible runtime without changing the session", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      agentRuntimeOverride: "codex",
      nativeRuntimeConsent: "codex",
    });
    const initial = { ...sessionEntry };
    const { persisted } = await persistModelDirectiveForTest({
      command: "/model anthropic/claude-opus-4-6 --runtime codex hello",
      allowedModelKeys: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
      sessionEntry,
      provider: "openai",
      model: "gpt-4o",
    });
    expect(persisted.errorText).toContain('Runtime "codex" is not supported');
    expect(sessionEntry).toEqual(initial);
  });

  it("switches a directive-only alias to configured routing and clears incompatible consent", async () => {
    const { result, sessionEntry } = await selectGpt("openclaw", pinnedSession());
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
    const sessionEntry = pinnedSession();
    const initial = { ...sessionEntry };
    await vi.mocked(preparePublishedModelRuntimeChoice).withImplementation(
      async () => ({ kind: "unavailable", message: "Configured native runtime is unavailable." }),
      async () => {
        const { result } = await selectGpt("codex", sessionEntry);
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
  it("commits openclaw selection while keeping supported mixed thinking on its turn", async () => {
    harness.setOpenAiRuntimeScopedUltraProvider();
    const sessionEntry = createSessionEntry({ thinkingLevel: "high" });
    const { persisted, result } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-5.6-luna --runtime openclaw /think ultra please solve",
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
      agentRuntimeOverride: "openclaw",
      thinkingLevel: "high",
    });
  });
}

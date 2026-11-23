import { expect, it, vi, type Mock } from "vitest";
import { createTestOperatorAuthority } from "../../agents/admitted-run-context.test-support.js";
import { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import type { handleDirectiveOnly } from "./directive-handling.impl.js";

type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

export function registerModelRuntimeDirectiveTests({
  createSessionEntry,
  persistedSession,
  persistModelDirectiveForTest,
  runHandleCommand,
  refreshQueuedFollowupSession,
  persistStickyModelSelection,
}: {
  createSessionEntry: (overrides?: Partial<InternalSessionEntry>) => InternalSessionEntry;
  persistedSession: (
    initial: Partial<InternalSessionEntry>,
    concurrent: Partial<InternalSessionEntry>,
  ) => Promise<{ sessionKey: string; storePath: string; sessionEntry: InternalSessionEntry }>;
  persistModelDirectiveForTest: (params: {
    command: string;
    directiveOnly?: boolean;
    cfg?: OpenClawConfig;
    allowedModelKeys?: string[];
    sessionEntry: InternalSessionEntry;
    storePath?: string;
    provider: string;
    model: string;
    initialModelLabel?: string;
  }) => Promise<{ sessionEntry: InternalSessionEntry; result: unknown }>;
  runHandleCommand: (
    command: string,
    overrides?: Partial<HandleParams>,
  ) => ReturnType<typeof handleDirectiveOnly>;
  refreshQueuedFollowupSession: Mock;
  persistStickyModelSelection: Mock;
}): void {
  it("rejects a pinned runtime that cannot enforce the operator role before changing the model", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5",
      agentRuntimeOverride: "codex",
    });
    const before = { ...sessionEntry };
    await vi.mocked(preparePublishedModelRuntimeChoice).withImplementation(
      async () => ({
        kind: "ready",
        runtimeId: "codex",
        validate: () => undefined,
        harness: {
          id: "codex",
          label: "Native fixture",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
        },
      }),
      async () => {
        const result = await runHandleCommand("/model openai/gpt-4o", {
          sessionEntry,
          operatorAuthority: createTestOperatorAuthority({
            profileId: "runtime-policy-fixture",
            scopes: ["operator.write"],
            assertCurrent() {},
            rolePolicy: { sessionAccessCap: "none", sandboxRequired: false, agents: "*" },
          }),
        });
        expect(result).toMatchObject({
          isError: true,
          text: expect.stringContaining("cannot enforce your operator role"),
        });
      },
    );
    expect(sessionEntry).toEqual(before);
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(persistStickyModelSelection).not.toHaveBeenCalled();
  });

  it("preserves an explicit runtime pin when a model switch omits --runtime", async () => {
    const sessionEntry = createSessionEntry({
      agentRuntimeOverride: "codex",
      nativeRuntimeConsent: "codex",
    });
    await runHandleCommand("/model openai/gpt-4o", { sessionEntry });

    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
    expect(sessionEntry.nativeRuntimeConsent).toBe("codex");
  });

  it("clears runtime overrides when the model directive asks for default runtime", async () => {
    const { sessionEntry } = await persistModelDirectiveForTest({
      command: "/model openai/gpt-4o --runtime default hello",
      allowedModelKeys: ["openai/gpt-4o"],
      sessionEntry: createSessionEntry({ agentRuntimeOverride: "codex" }),
      provider: "openai",
      model: "gpt-4o",
      initialModelLabel: "openai/gpt-4o",
    });

    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
  });

  it.each([
    { command: "/model anthropic/claude-opus-4-6", directiveOnly: true, expected: undefined },
    { command: "/model anthropic/claude-opus-4-6 /fast off", directiveOnly: true, expected: false },
    {
      command: "/model anthropic/claude-opus-4-6 /fast on hello",
      directiveOnly: false,
      expected: undefined,
    },
  ])(
    "applies the destination speed policy for $command",
    async ({ command, directiveOnly, expected }) => {
      const { sessionKey, storePath, sessionEntry } = await persistedSession(
        { providerOverride: "openai", modelOverride: "gpt-4o", fastMode: true },
        {},
      );
      const { result } = await persistModelDirectiveForTest({
        command,
        directiveOnly,
        cfg: {
          commands: { text: true },
          agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
        },
        sessionEntry,
        storePath,
        provider: "openai",
        model: "gpt-4o",
      });
      expect(result).toMatchObject(
        directiveOnly
          ? { kind: "reply", reply: { text: expect.stringContaining("anthropic/claude-opus-4-6") } }
          : {
              kind: "continue",
              provider: "anthropic",
              model: "claude-opus-4-6",
              directives: { fastMode: true },
            },
      );
      const stored = loadSessionEntry({ sessionKey, storePath });
      expect(stored?.modelOverrideSource).toBe("default");
      expect(stored?.fastMode).toBe(expected);
    },
  );

  it("rejects model and runtime changes for model-locked sessions", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelSelectionLocked: true,
    });
    const initialSessionEntry = { ...sessionEntry };

    const result = await runHandleCommand("/model openai/gpt-4o --runtime openclaw", {
      sessionEntry,
    });

    expect(result?.text).toBe(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(result?.isError).toBe(true);
    expect(sessionEntry).toEqual(initialSessionEntry);
  });
}

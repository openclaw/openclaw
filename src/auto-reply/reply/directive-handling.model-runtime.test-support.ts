import { expect, it, vi, type Mock } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import type { handleDirectiveOnly } from "./directive-handling.impl.js";

type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

export function registerModelRuntimeDirectiveTests({
  createSessionEntry,
  runHandleCommand,
  refreshQueuedFollowupSession,
  persistStickyModelSelection,
}: {
  createSessionEntry: (overrides?: Partial<InternalSessionEntry>) => InternalSessionEntry;
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
          operatorAuthority: createAdmittedRunOperatorAuthority({
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

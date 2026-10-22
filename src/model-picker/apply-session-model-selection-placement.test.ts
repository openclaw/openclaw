import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { applySessionModelSelection as applySdkModelSelection } from "../plugin-sdk/model-session-runtime.js";
import {
  createModelSelectionInputs,
  selectionMocks,
  useSelectionEffects,
  useSelectionStore,
} from "./apply-session-model-selection.test-support.js";
await vi.hoisted(() => import("./apply-session-model-selection.test-support.js"));
const { placementMocks, validateRuntime } = selectionMocks;

const persistedSession = useSelectionStore("openclaw-model-picker-runtime-race-");
const { expectNoSelectionEffects } = useSelectionEffects();

import { applySessionModelSelectionInternal as applySessionModelSelection } from "./apply-session-model-selection.js";

const { createEntry, createParams } = createModelSelectionInputs();

function createPlacement(sessionId: string, state: "local" | "active" = "active") {
  return {
    sessionId,
    state,
    executionMode: "worker-turn" as const,
    generation: 1,
  };
}

describe("applySessionModelSelection — placement guard", () => {
  it.each([undefined, "worker-turn"] as const)(
    "checks active placement compatibility with %s",
    async (executionMode) => {
      const sessionEntry = createEntry({ sessionId: "placement-active-1" });
      const initial = structuredClone(sessionEntry);
      placementMocks.getMany.mockReturnValue(
        new Map([[sessionEntry.sessionId, createPlacement(sessionEntry.sessionId)]]),
      );
      placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReturnValue({
        executionMode,
      });

      const result = await applySessionModelSelection(createParams({ sessionEntry }));

      if (executionMode) {
        expect(result.status).toBe("applied");
      } else {
        expect(result).toEqual({
          status: "rejected",
          reason: "invalid-runtime",
          message:
            "Session cannot select a runtime without cloud placement support while cloud worker placement is active.",
        });
        expect(sessionEntry).toEqual(initial);
        expectNoSelectionEffects();
      }
    },
  );

  it.each(["runtime", "SDK account"] as const)(
    "rejects %s availability revoked while waiting for the session writer",
    async (source) => {
      const sessionEntry = createEntry({ sessionId: "runtime-race-1" });
      const initial = structuredClone(sessionEntry);
      const { sessionKey, storePath } = await persistedSession(
        sessionEntry,
        "agent:main:dm:runtime-race",
      );
      const entered = createDeferred();
      const release = createDeferred();
      const writer = patchSessionEntryCore({ sessionKey, storePath }, async () => {
        entered.resolve();
        await release.promise;
        return null;
      });
      await entered.promise;
      let available = true;
      const validated = createDeferred();
      const error = `Selected ${source === "runtime" ? "runtime" : "account"} is no longer available.`;
      const validate = () => {
        validated.resolve();
        return available ? undefined : error;
      };
      if (source === "runtime") {
        validateRuntime.mockImplementation(validate);
      }
      const applySelection =
        source === "runtime" ? applySessionModelSelection : applySdkModelSelection;
      const pending = applySelection(
        createParams({
          sessionEntry,
          sessionKey,
          storePath,
          ...(source === "SDK account" ? { validateAuthProfileSelection: validate } : {}),
          request: { ...createParams().request, runtime: { kind: "set", runtime: "openclaw" } },
        }),
      );
      try {
        // Preparation accepts the selection; revoke it before the queued write can commit.
        expect(
          await Promise.race([validated.promise.then(() => true), pending.then(() => false)]),
        ).toBe(true);
        available = false;
      } finally {
        release.resolve();
        await writer;
      }

      expect(await pending).toMatchObject({
        status: "rejected",
        reason: "not-allowed",
        message: error,
      });
      expect(loadSessionEntryReadOnly({ sessionKey, storePath })).toEqual(initial);
      expect(sessionEntry).toEqual(initial);
      expectNoSelectionEffects();
    },
  );

  it("rejects a model selection when placement activates between the pre-write read and the durable commit", async () => {
    const { sessionEntry, sessionKey, storePath } = await persistedSession(
      createEntry({ sessionId: "placement-race-1" }),
      "agent:main:dm:placement-race",
    );
    const initial = structuredClone(sessionEntry);
    const localPlacement = createPlacement(sessionEntry.sessionId, "local");
    const activePlacement = { ...localPlacement, state: "active" as const, generation: 2 };
    // The prepared owner sees local placement; its commit assertion observes activation.
    placementMocks.getMany
      .mockReturnValueOnce(new Map([["placement-race-1", localPlacement]]))
      .mockReturnValueOnce(new Map([["placement-race-1", activePlacement]]));
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReturnValue({
      executionMode: undefined,
    });

    const result = await applySessionModelSelection(
      createParams({ sessionEntry, sessionKey, storePath }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      message: "Session placement changed; retry model selection.",
    });
    // The durable write was fenced: the stored entry is unchanged.
    const stored = loadSessionEntryReadOnly({ sessionKey, storePath });
    expect(stored).toEqual(initial);
    expectNoSelectionEffects();
  });
});

import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
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
const capabilities = placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities;

const persistedSession = useSelectionStore("openclaw-model-picker-runtime-race-");
const { expectNoSelectionEffects } = useSelectionEffects();

import { applySessionModelSelectionInternal as applySessionModelSelection } from "./apply-session-model-selection.js";

const { createEntry, createParams } = createModelSelectionInputs();

function createPlacement(sessionId: string, state: "local" | "active" = "active") {
  return { sessionId, state, executionMode: "worker-turn" as const, generation: 1 };
}

async function persistedParams() {
  const target = await persistedSession(createEntry(), "agent:main:dm:placement");
  return { ...createParams(target), ...target };
}

function expectUnchanged(params: ReturnType<typeof createParams>) {
  expect(params.sessionEntry).toEqual(createEntry());
  if (params.storePath) {
    expect(loadSessionEntryReadOnly(params)).toEqual(createEntry());
  }
  expectNoSelectionEffects();
}

it.each([undefined, "worker-turn"] as const)(
  "checks active placement compatibility with %s",
  async (executionMode) => {
    const params = createParams();
    const { sessionId } = params.sessionEntry;
    placementMocks.getMany.mockReturnValue(new Map([[sessionId, createPlacement(sessionId)]]));
    capabilities.mockReturnValue({ executionMode });

    const result = await applySessionModelSelection(params);

    expect(result.status).toBe(executionMode ? "applied" : "rejected");
    if (!executionMode) {
      expect(result).toMatchObject({ reason: "invalid-runtime" });
      expectUnchanged(params);
    }
  },
);

it.each(["runtime", "SDK account"] as const)(
  "rejects %s availability revoked while waiting for the session writer",
  async (source) => {
    const params = await persistedParams();
    const entered = createDeferred();
    const release = createDeferred();
    const writer = patchSessionEntryCore(params, async () => {
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
    params.request.runtime = { kind: "set", runtime: "openclaw" };
    if (source === "SDK account") {
      params.validateAuthProfileSelection = validate;
    }
    const pending = applySelection(params);
    try {
      // Preparation accepts the selection; revoke it before the queued write can commit.
      await awaitGateBeforeSettlement(validated.promise, pending, "Validation not reached");
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
    expectUnchanged(params);
  },
);

it("rejects a model selection when placement activates between the pre-write read and the durable commit", async () => {
  const params = await persistedParams();
  const { sessionId } = params.sessionEntry;
  const localPlacement = createPlacement(sessionId, "local");
  const activePlacement = { ...localPlacement, state: "active" as const, generation: 2 };
  // The prepared owner sees local placement; its commit assertion observes activation.
  placementMocks.getMany
    .mockReturnValueOnce(new Map([[sessionId, localPlacement]]))
    .mockReturnValueOnce(new Map([[sessionId, activePlacement]]));
  capabilities.mockReturnValue({ executionMode: undefined });

  const result = await applySessionModelSelection(params);

  expect(result).toMatchObject({
    status: "rejected",
    message: "Session placement changed; retry model selection.",
  });
  expectUnchanged(params);
});

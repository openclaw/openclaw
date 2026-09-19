import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { createModelSelectionInputs } from "./apply-session-model-selection.test-support.js";

const runtimeChoiceMocks = vi.hoisted(() => ({
  validate: vi.fn<() => string | undefined>(),
}));

// Runtime eligibility belongs to its owner; exercise its commit guard here.
vi.mock("../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn(async () => ({
    kind: "ready",
    validate: runtimeChoiceMocks.validate,
  })),
}));

vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

const { effects, placementMocks, factories, resetMocks } = await vi.hoisted(async () => {
  const { createModelSelectionMocks } =
    await import("./apply-session-model-selection.test-support.js");
  return createModelSelectionMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let lifecycleEvents: SessionLifecycleEvent[];
let unsubscribeLifecycle: () => void;

vi.mock("../infra/system-events.js", factories.systemEvents);
vi.mock("../auto-reply/reply/queue.js", factories.queue);
vi.mock("../gateway/session-patch-hooks.js", factories.patchHooks);
vi.mock("../config/config.js", factories.config);

vi.mock("../logging/subsystem.js", factories.logging);

vi.mock("../gateway/session-worker-placement-context.js", factories.placementContext);
vi.mock("../gateway/worker-environments/placement-session-runtime.js", factories.placementRuntime);

import { applySessionModelSelection } from "./apply-session-model-selection.js";

const { createEntry, createParams } = createModelSelectionInputs();

beforeEach(() => {
  runtimeChoiceMocks.validate.mockReset().mockReturnValue(undefined);
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
  lifecycleEvents = [];
  unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
  resetMocks();
});

afterEach(() => unsubscribeLifecycle());

describe("applySessionModelSelection — placement guard", () => {
  it("rejects a model selection incompatible with an active cloud placement without persisting", async () => {
    const sessionEntry = createEntry({ sessionId: "placement-active-1" });
    const initial = structuredClone(sessionEntry);
    const placement = {
      sessionId: "placement-active-1",
      state: "active" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    placementMocks.getMany.mockReturnValue(new Map([["placement-active-1", placement]]));
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReturnValue({
      executionMode: undefined,
    });

    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid-runtime",
      message:
        "Session cannot select a runtime without cloud placement support while cloud worker placement is active.",
    });
    expect(sessionEntry).toEqual(initial);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("allows a model selection compatible with an active cloud placement", async () => {
    const sessionEntry = createEntry({ sessionId: "placement-active-2" });
    const placement = {
      sessionId: "placement-active-2",
      state: "active" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    placementMocks.getMany.mockReturnValue(new Map([["placement-active-2", placement]]));
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReturnValue({
      executionMode: "worker-turn",
    });

    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result.status).toBe("applied");
  });

  it("skips placement validation when no active placement exists", async () => {
    const sessionEntry = createEntry({ sessionId: "placement-none" });
    placementMocks.getMany.mockReturnValue(new Map());

    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result.status).toBe("applied");
    expect(placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities).not.toHaveBeenCalled();
  });

  it("rejects runtime availability revoked while waiting for the session writer", async () => {
    const tempRoot = tempDirs.make("openclaw-model-picker-runtime-race-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:runtime-race";
    const sessionEntry = createEntry({ sessionId: "runtime-race-1" });
    const initial = structuredClone(sessionEntry);
    await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
    const entered = createDeferred();
    const release = createDeferred();
    const writer = patchSessionEntryCore({ sessionKey, storePath }, async () => {
      entered.resolve();
      await release.promise;
      return null;
    });
    await entered.promise;
    let runtimeAvailable = true;
    const validated = createDeferred();
    runtimeChoiceMocks.validate.mockImplementation(() => {
      validated.resolve();
      return runtimeAvailable ? undefined : "Selected runtime is no longer available.";
    });
    const pending = applySessionModelSelection(
      createParams({
        sessionEntry,
        sessionKey,
        storePath,
        request: {
          provider: "openai",
          model: "gpt-4o",
          isDefault: false,
          runtime: { kind: "set", runtime: "openclaw" },
        },
      }),
    );
    try {
      // Preparation accepts the runtime; revoke it before the queued write can commit.
      expect(
        await Promise.race([validated.promise.then(() => true), pending.then(() => false)]),
      ).toBe(true);
      runtimeAvailable = false;
    } finally {
      release.resolve();
      await writer;
    }

    expect(await pending).toMatchObject({
      status: "rejected",
      reason: "not-allowed",
      message: "Selected runtime is no longer available.",
    });
    expect(loadSessionEntryReadOnly({ sessionKey, storePath })).toEqual(initial);
    expect(sessionEntry).toEqual(initial);
    expect(lifecycleEvents).toEqual([]);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("rejects a model selection when placement activates between the pre-write read and the durable commit", async () => {
    const tempRoot = tempDirs.make("openclaw-model-picker-placement-race-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:placement-race";
    const sessionEntry = createEntry({ sessionId: "placement-race-1" });
    await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
    const initial = structuredClone(sessionEntry);
    const localPlacement = {
      sessionId: "placement-race-1",
      state: "local" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const activePlacement = { ...localPlacement, state: "active" as const, generation: 2 };
    // First read (pre-write guard) sees a local placement; the synchronous commit boundary
    // then sees an activation that overtook the directive's first read.
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
      message:
        "Session cannot select a runtime without cloud placement support while cloud worker placement is active.",
    });
    // The durable write was fenced: the stored entry is unchanged.
    const stored = loadSessionEntryReadOnly({ sessionKey, storePath });
    expect(stored).toEqual(initial);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});

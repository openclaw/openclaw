import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginStateStoreError } from "../plugin-state/plugin-state-store.types.js";
import { serializePluginStoreJson } from "../plugin-state/plugin-store-validation.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  MeetingParticipationAttempt,
  MeetingParticipationOptions,
  MeetingParticipationRequest,
  MeetingParticipationSource,
} from "./participation-types.js";
import { MeetingParticipation } from "./participation.js";

const sessionId = "meeting-1";
const request: MeetingParticipationRequest = {
  requestId: "request-1",
  action: { type: "chat", text: "Hello" },
};
const source: MeetingParticipationSource = {
  id: "provider-message-1",
  epoch: "document-1",
  revision: "1",
  kind: "chat",
  text: "Please reply in chat.",
  finalized: true,
};

function memoryStore(maxEntries = Infinity): MeetingParticipationOptions<object>["store"] {
  const rows = new Map<string, MeetingParticipationAttempt>();
  const createdAt = new Map<string, number>();
  let clock = 0;
  const validate = (value: MeetingParticipationAttempt) =>
    serializePluginStoreJson({
      value,
      label: "plugin state value",
      maxBytes: 1_048_576,
      errors: {
        invalid: (message) =>
          new PluginStateStoreError(message, {
            code: "PLUGIN_STATE_INVALID_INPUT",
            operation: "register",
          }),
        limit: (message) =>
          new PluginStateStoreError(message, {
            code: "PLUGIN_STATE_LIMIT_EXCEEDED",
            operation: "register",
          }),
      },
    });
  const set = (key: string, value: MeetingParticipationAttempt) => {
    validate(value);
    if (!rows.has(key)) {
      if (rows.size >= maxEntries) {
        throw new PluginStateStoreError("Namespace full.", {
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
          operation: "register",
        });
      }
      createdAt.set(key, clock++);
    }
    rows.set(key, structuredClone(value));
  };
  return {
    lookup: async (key) => structuredClone(rows.get(key)),
    registerIfAbsent: async (key, value) => {
      validate(value);
      if (rows.has(key)) {
        return false;
      }
      set(key, value);
      return true;
    },
    register: async (key, value) => set(key, value),
    entries: async () =>
      [...rows].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: createdAt.get(key)!,
      })),
    delete: async (key) => {
      createdAt.delete(key);
      return rows.delete(key);
    },
  };
}

function gate() {
  const { promise, resolve: release } = createDeferredCore();
  return { promise, release };
}

function harness(
  overrides: Partial<MeetingParticipationOptions<object>> = {},
  sessionIds = [sessionId],
) {
  let active = true;
  const session = {};
  const store = overrides.store ?? memoryStore();
  const effect = vi.fn<MeetingParticipationOptions<object>["execute"]>(async () => ({
    status: "succeeded",
    observed: { sent: true },
  }));
  const owner = new MeetingParticipation({
    store,
    capabilities: () => ["chat", "reaction"],
    validateAction: (action) => (action.text === "" ? "Text is required." : undefined),
    execute: effect,
    ...overrides,
    current: (id) =>
      active && sessionIds.includes(id)
        ? {
            session,
            assertCurrent: () => {
              if (!active) {
                throw new Error("Session replaced.");
              }
            },
          }
        : undefined,
  });
  return {
    owner,
    store,
    effect,
    leave: () => {
      active = false;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("meeting participation authority and durable attempts", () => {
  it("claims before the effect, suppresses an in-flight duplicate, and replays its recorded result", async () => {
    const started = gate();
    const complete = gate();
    const { owner, store, effect } = harness();
    effect.mockImplementation(async () => {
      expect(await store.lookup(`${sessionId}:request:${request.requestId}`)).toMatchObject({
        requestId: request.requestId,
        actionType: "chat",
      });
      started.release();
      await complete.promise;
      return { status: "succeeded", observed: { sent: true } };
    });
    const first = owner.execute(sessionId, request);
    await started.promise;
    await expect(owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "uncertain",
      replayed: true,
    });
    complete.release();
    const result = await first;
    expect(result).toMatchObject({ status: "succeeded", observed: { sent: true } });
    await expect(owner.execute(sessionId, request)).resolves.toEqual({ ...result, replayed: true });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused request identity with a different payload", async () => {
    const { owner, effect } = harness();
    await owner.execute(sessionId, request);
    await expect(
      owner.execute(sessionId, {
        ...request,
        action: { type: "chat", text: "Different answer" },
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("suppresses the same source and action even under another request identity", async () => {
    const { owner, effect } = harness();
    const sourceId = owner.observe(sessionId, source);
    expect(sourceId).toBeTruthy();
    await expect(owner.execute(sessionId, { ...request, sourceId })).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      owner.execute(sessionId, { ...request, sourceId, requestId: "another-request" }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("does not replay a consumed source after its text is revised", async () => {
    const { owner, effect } = harness();
    const sourceId = owner.observe(sessionId, source);
    await expect(owner.execute(sessionId, { ...request, sourceId })).resolves.toMatchObject({
      status: "succeeded",
    });
    const revisedSourceId = owner.observe(sessionId, {
      ...source,
      revision: "2",
      text: "Please reply now.",
    });
    expect(revisedSourceId).toBeTruthy();
    expect(revisedSourceId).not.toBe(sourceId);
    await expect(
      owner.execute(sessionId, {
        ...request,
        sourceId: revisedSourceId,
        requestId: "after-revision",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("never re-executes an uncertain effect after reconstructing its owner", async () => {
    const first = harness();
    first.effect.mockRejectedValue(new Error("Native response lost."));
    await expect(first.owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "uncertain",
    });
    const restored = harness({ store: first.store });
    await expect(restored.owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "uncertain",
      replayed: true,
    });
    expect(restored.effect).not.toHaveBeenCalled();
  });

  it("retains the claim when result persistence fails", async () => {
    const store = memoryStore();
    const first = harness({
      store: {
        ...store,
        register: async () => {
          throw new Error("Storage unavailable.");
        },
      },
    });
    await expect(first.owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "uncertain",
    });
    const restored = harness({ store });
    await expect(restored.owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "uncertain",
      replayed: true,
    });
    expect(first.effect).toHaveBeenCalledTimes(1);
    expect(restored.effect).not.toHaveBeenCalled();
  });

  it("checks current capabilities without producing an effect for unsupported actions", async () => {
    const { owner, effect } = harness({ capabilities: () => [] });
    await expect(owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "unsupported",
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["close", "replace"] as const)(
    "revalidates after awaiting the durable claim when sessions %s",
    async (kind) => {
      const claimed = gate();
      const resume = gate();
      const store = memoryStore();
      const originalClaim = store.registerIfAbsent;
      store.registerIfAbsent = async (...args) => {
        const result = await originalClaim(...args);
        claimed.release();
        await resume.promise;
        return result;
      };
      const { owner, effect, leave } = harness({ store });
      const result = owner.execute(sessionId, request);
      await claimed.promise;
      if (kind === "close") {
        owner.close(sessionId);
      } else {
        leave();
      }
      resume.release();
      await expect(result).resolves.toMatchObject({ status: "rejected" });
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("revalidates capability after awaiting the source claim", async () => {
    const sourceClaimed = gate();
    const resume = gate();
    const store = memoryStore();
    const originalClaim = store.registerIfAbsent;
    let available = true;
    store.registerIfAbsent = async (...args) => {
      const result = await originalClaim(...args);
      if (args[0].includes(":source:")) {
        sourceClaimed.release();
        await resume.promise;
      }
      return result;
    };
    const { owner, effect } = harness({ store, capabilities: () => (available ? ["chat"] : []) });
    const sourceId = owner.observe(sessionId, source);
    const result = owner.execute(sessionId, { ...request, sourceId });
    await sourceClaimed.promise;
    available = false;
    resume.release();
    await expect(result).resolves.toMatchObject({ status: "rejected" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("snapshots arguments before awaiting a claim", async () => {
    const claimed = gate();
    const resume = gate();
    const store = memoryStore();
    const originalClaim = store.registerIfAbsent;
    store.registerIfAbsent = async (...args) => {
      const result = await originalClaim(...args);
      claimed.release();
      await resume.promise;
      return result;
    };
    const { owner, effect } = harness({ store });
    const mutable = structuredClone(request);
    const result = owner.execute(sessionId, mutable);
    await claimed.promise;
    mutable.action.text = "Mutated after claim";
    resume.release();
    await result;
    expect(effect.mock.calls[0]?.[1]).toEqual(request);
  });

  it("persists completed attempts across independent SQLite store and owner instances", async () => {
    const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
      await import("../plugin-state/plugin-state-store.js");
    await withOpenClawTestState(
      { label: "meeting-participation", applyEnv: false },
      async (state) => {
        const options = {
          namespace: "meeting-participation",
          maxEntries: 100,
          overflowPolicy: "reject-new" as const,
          env: state.env,
        };
        try {
          const first = harness({
            store: createPluginStateKeyedStore<MeetingParticipationAttempt>("google-meet", options),
          });
          const result = await first.owner.execute(sessionId, request);
          expect(result.status).toBe("succeeded");
          resetPluginStateStoreForTests();
          const restored = harness({
            store: createPluginStateKeyedStore<MeetingParticipationAttempt>("google-meet", options),
          });
          await expect(restored.owner.execute(sessionId, request)).resolves.toEqual({
            ...result,
            replayed: true,
          });
          expect(restored.effect).not.toHaveBeenCalled();
        } finally {
          resetPluginStateStoreForTests();
        }
      },
    );
  });
});

describe("meeting participation observed source identities", () => {
  it("keeps the source authority callback bound to its original owner", () => {
    const { store, effect } = harness();
    const current = {
      session: {},
      active: true,
      assertCurrent() {
        if (!this.active) {
          throw new Error("Session replaced.");
        }
      },
    };
    const owner = new MeetingParticipation({
      store,
      capabilities: () => ["chat"],
      validateAction: () => undefined,
      execute: effect,
      current: () => current,
    });
    const sourceId = owner.observe(sessionId, source);
    expect(sourceId).toBeTruthy();
    expect(owner.context(sessionId).sources).toHaveLength(1);
    const inspection = owner.inspect(sessionId, sourceId!);
    expect(inspection).toBeDefined();
    expect(() => inspection?.assertCurrent()).not.toThrow();

    current.active = false;
    expect(owner.context(sessionId).sources).toEqual([]);
    expect(() => inspection?.assertCurrent()).toThrow();
    expect(owner.inspect(sessionId, sourceId!)).toBeUndefined();
  });

  it.each([
    { label: "new document", update: { epoch: "document-2" } },
    { label: "corrected revision", update: { revision: "2", text: "Corrected request." } },
    { label: "own echo", update: { ownEcho: true } },
    { label: "interim revision", update: { revision: "2", finalized: false } },
    { label: "blank correction", update: { revision: "2", text: "" } },
    { label: "whitespace correction", update: { revision: "2", text: "  \t " } },
    { label: "oversized correction", update: { revision: "2", text: "a".repeat(16_385) } },
  ])("invalidates issued source authority after a $label", async ({ update }) => {
    const { owner, effect } = harness();
    const sourceId = owner.observe(sessionId, source);
    expect(sourceId).toBeTruthy();
    const inspection = owner.inspect(sessionId, sourceId!);
    expect(inspection).toBeDefined();
    owner.observe(sessionId, { ...source, ...update });
    expect(() => inspection?.assertCurrent()).toThrow();
    expect(owner.inspect(sessionId, sourceId!)).toBeUndefined();
    await expect(owner.execute(sessionId, { ...request, sourceId })).resolves.toMatchObject({
      status: "rejected",
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it("advances the observation watermark for interim text without granting an actionable source", () => {
    const { owner } = harness();
    expect(owner.observe(sessionId, { ...source, finalized: false })).toBeUndefined();
    const cutoff = owner.context(sessionId).sourceOrder;
    expect(cutoff).toBe(1);
    expect(owner.context(sessionId).sources).toEqual([]);
    owner.observe(sessionId, { ...source, revision: "2", finalized: true });
    expect(owner.context(sessionId).sources[0]?.order).toBe(cutoff);
    owner.observe(sessionId, { ...source, id: "new-message" });
    expect(owner.context(sessionId).sourceOrder).toBe(2);
    expect(owner.context(sessionId).sources[1]?.order).toBeGreaterThan(cutoff);
  });

  it("preserves correction order, detects identical observations, and never rehabilitates an own echo", () => {
    const { owner } = harness();
    const original = owner.observe(sessionId, source);
    expect(owner.observe(sessionId, source)).toBe(original);
    const corrected = owner.observe(sessionId, { ...source, revision: "2", text: "Correction." });
    expect(owner.context(sessionId).sources).toMatchObject([
      { sourceId: corrected, order: 1, replacesSourceId: original },
    ]);
    owner.observe(sessionId, { ...source, revision: "2", ownEcho: true });
    expect(owner.observe(sessionId, { ...source, revision: "3", ownEcho: false })).toBeUndefined();
    expect(owner.context(sessionId).sources).toEqual([]);
  });

  it("ignores historical revisions and epochs without displacing current authority", () => {
    const { owner } = harness();
    owner.observe(sessionId, source);
    const revision = owner.observe(sessionId, {
      ...source,
      revision: "2",
      text: "Current revision.",
    });
    expect(owner.observe(sessionId, source)).toBeUndefined();
    expect(owner.context(sessionId).sources).toMatchObject([{ sourceId: revision }]);
    const epoch = owner.observe(sessionId, {
      ...source,
      epoch: "document-2",
      text: "Current document.",
    });
    expect(
      owner.observe(sessionId, { ...source, revision: "3", text: "Old document." }),
    ).toBeUndefined();
    expect(owner.context(sessionId).sources).toMatchObject([
      { sourceId: epoch, epoch: "document-2" },
    ]);
  });

  it("invalidates caption authority when a new document snapshot is empty", async () => {
    const { owner, effect } = harness();
    const oldCaption = { ...source, kind: "caption" as const };
    const sourceId = owner.observe(sessionId, oldCaption);
    expect(sourceId).toBeTruthy();
    const inspection = owner.inspect(sessionId, sourceId!);
    expect(inspection).toBeDefined();

    expect(owner.observeEpoch(sessionId, "caption", "empty-document-2")).toBe(true);
    expect(owner.context(sessionId).sources).toEqual([]);
    expect(owner.inspect(sessionId, sourceId!)).toBeUndefined();
    expect(() => inspection?.assertCurrent()).toThrow();
    await expect(owner.execute(sessionId, { ...request, sourceId })).resolves.toMatchObject({
      status: "rejected",
    });
    expect(owner.observeEpoch(sessionId, "caption", source.epoch)).toBe(false);
    expect(owner.observe(sessionId, oldCaption)).toBeUndefined();
    expect(owner.context(sessionId).sources).toEqual([]);
    expect(effect).not.toHaveBeenCalled();
  });

  it("expires observations and refuses to restore authority after closing", async () => {
    vi.useFakeTimers();
    const { owner, effect } = harness();
    const sourceId = owner.observe(sessionId, source);
    vi.advanceTimersByTime(120_001);
    expect(owner.context(sessionId).sources).toEqual([]);
    expect(owner.observe(sessionId, source)).toBeUndefined();
    expect(
      owner.observe(sessionId, { ...source, revision: "2", text: "Updated after expiry." }),
    ).toBeUndefined();
    await expect(owner.execute(sessionId, { ...request, sourceId })).resolves.toMatchObject({
      status: "rejected",
    });
    owner.close(sessionId);
    expect(owner.observe(sessionId, { ...source, id: "new-message" })).toBeUndefined();
    expect(owner.context(sessionId)).toMatchObject({
      active: false,
      sources: [],
      capabilities: [],
    });
    expect(effect).not.toHaveBeenCalled();
  });
});

describe("meeting participation live source capacity", () => {
  function captions(count: number): MeetingParticipationSource[] {
    return Array.from({ length: count }, (_, index) => ({
      ...source,
      kind: "caption",
      id: `caption-${index}`,
      text: `Request ${index}`,
    }));
  }

  it.each([129, 1_025])(
    "preserves retained references and issued guards when replaying %i unchanged captions",
    async (count) => {
      vi.useFakeTimers();
      const { owner, effect } = harness();
      const snapshot = captions(count);
      for (const caption of snapshot) {
        owner.observe(sessionId, caption);
      }
      const before = owner.context(sessionId);
      const retained = before.sources.at(-1)!;
      const inspection = owner.inspect(sessionId, retained.sourceId);
      expect(inspection).toBeDefined();

      for (const caption of snapshot) {
        owner.observe(sessionId, caption);
      }

      expect(() => inspection!.assertCurrent()).not.toThrow();
      expect(owner.context(sessionId)).toEqual(before);
      await expect(
        owner.execute(sessionId, { ...request, sourceId: retained.sourceId }),
      ).resolves.toMatchObject({ status: "succeeded" });
      expect(effect).toHaveBeenCalledOnce();
    },
  );

  it("retains 1024 sources and evicts only the oldest for a newer observation", () => {
    vi.useFakeTimers();
    const { owner } = harness();
    const snapshot = captions(1_025);
    for (const caption of snapshot) {
      owner.observe(sessionId, caption);
    }
    const before = owner.context(sessionId).sources;
    expect(before).toHaveLength(1_024);
    expect(before.map((entry) => entry.id)).toEqual(snapshot.slice(1).map((entry) => entry.id));
    const evicted = owner.inspect(sessionId, before[0]!.sourceId)!;
    const retained = owner.inspect(sessionId, before.at(-1)!.sourceId)!;
    expect(evicted).toBeDefined();
    expect(retained).toBeDefined();

    const next = owner.observe(sessionId, { ...source, kind: "caption", id: "next-caption" });
    const after = owner.context(sessionId).sources;
    expect(next).toBeTruthy();
    expect(after).toHaveLength(1_024);
    expect(after.slice(0, -1)).toEqual(before.slice(1));
    expect(after.at(-1)).toMatchObject({ sourceId: next, order: 1_026 });
    expect(() => evicted.assertCurrent()).toThrow();
    expect(() => retained.assertCurrent()).not.toThrow();
    expect(owner.inspect(sessionId, before[0]!.sourceId)).toBeUndefined();
  });

  it("evicts by original observation order after an interim correction is finalized", () => {
    vi.useFakeTimers();
    const { owner } = harness();
    const snapshot = captions(1_024);
    for (const caption of snapshot) {
      owner.observe(sessionId, caption);
    }
    const before = owner.context(sessionId).sources;
    expect(before).toHaveLength(1_024);
    const original = owner.inspect(sessionId, before[0]!.sourceId)!;
    const retained = owner.inspect(sessionId, before[1]!.sourceId)!;
    expect(original).toBeDefined();
    expect(retained).toBeDefined();
    owner.observe(sessionId, { ...snapshot[0]!, revision: "2", finalized: false });
    expect(() => original.assertCurrent()).toThrow();

    const corrected = owner.observe(sessionId, {
      ...snapshot[0]!,
      revision: "3",
      text: "Corrected request",
    });
    expect(corrected).toBeTruthy();
    expect(corrected).not.toBe(before[0]!.sourceId);
    const correctedSource = owner.inspect(sessionId, corrected!)!;
    expect(correctedSource.source.order).toBe(1);
    expect(() => correctedSource.assertCurrent()).not.toThrow();

    owner.observe(sessionId, { ...source, kind: "caption", id: "next-caption" });
    expect(owner.context(sessionId).sources).toHaveLength(1_024);
    expect(() => correctedSource.assertCurrent()).toThrow();
    expect(() => retained.assertCurrent()).not.toThrow();
    expect(owner.inspect(sessionId, corrected!)).toBeUndefined();
  });
});

describe("meeting participation bounded correction", () => {
  it("allows one correction retaining the source and action type", async () => {
    const { owner, effect } = harness();
    const sourceId = owner.observe(sessionId, source);
    await expect(
      owner.execute(sessionId, { ...request, sourceId, action: { type: "chat", text: "" } }),
    ).resolves.toMatchObject({ status: "rejected", correctionOf: request.requestId });
    await expect(
      owner.execute(sessionId, { ...request, sourceId, requestId: "bypass-invalid-request" }),
    ).resolves.toMatchObject({ status: "rejected" });
    const correction = {
      ...request,
      sourceId,
      requestId: "correction-1",
      correctionOf: request.requestId,
    };
    await expect(owner.execute(sessionId, correction)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      owner.execute(sessionId, { ...correction, requestId: "correction-2" }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      owner.execute(sessionId, {
        ...correction,
        requestId: "grandchild",
        correctionOf: correction.requestId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("does not issue another correction reference for an invalid correction", async () => {
    const { owner, effect } = harness();
    const invalid = { ...request, action: { type: "chat", text: "" } };
    await owner.execute(sessionId, invalid);
    const correction = { ...invalid, requestId: "correction-1", correctionOf: request.requestId };
    const result = await owner.execute(sessionId, correction);
    expect(result.status).toBe("rejected");
    expect(result.correctionOf).toBeUndefined();
    await expect(
      owner.execute(sessionId, {
        ...request,
        requestId: "grandchild",
        correctionOf: correction.requestId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["different source", "different action", "new source authority"])(
    "rejects a correction with %s",
    async (change) => {
      const { owner, effect } = harness();
      const sourceId = owner.observe(sessionId, source);
      const anotherSourceId = owner.observe(sessionId, { ...source, id: "provider-message-2" });
      await owner.execute(sessionId, {
        ...request,
        sourceId: change === "new source authority" ? undefined : sourceId,
        action: { type: "chat", text: "" },
      });
      await expect(
        owner.execute(sessionId, {
          requestId: "correction-1",
          correctionOf: request.requestId,
          sourceId: change === "different source" ? anotherSourceId : sourceId,
          action: change === "different action" ? { type: "reaction" } : request.action,
        }),
      ).resolves.toMatchObject({ status: "rejected" });
      expect(effect).not.toHaveBeenCalled();
    },
  );
});

describe("meeting participation SQLite value contract", () => {
  it("omits absent optional claim and result fields before canonical validation", async () => {
    const { owner, store, effect } = harness();
    effect.mockResolvedValue({ status: "succeeded", message: undefined, observed: undefined });
    const outcome = await owner.execute(sessionId, {
      ...request,
      sourceId: undefined,
      correctionOf: undefined,
    });
    expect(outcome).toEqual({ requestId: request.requestId, status: "succeeded" });
    const stored = await store.lookup(`${sessionId}:request:${request.requestId}`);
    expect(stored).not.toHaveProperty("sourceId");
    expect(stored).not.toHaveProperty("correctionOf");
    expect(stored?.result).toEqual(outcome);
    expect(await owner.execute(sessionId, request)).toEqual({ ...outcome, replayed: true });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("keeps the claim fenced when a provider returns a non-JSON observation", async () => {
    const { owner, store, effect } = harness();
    effect.mockResolvedValue({ status: "succeeded", observed: { unsupportedValue: undefined } });
    expect(await owner.execute(sessionId, request)).toMatchObject({ status: "uncertain" });
    expect(await store.lookup(`${sessionId}:request:${request.requestId}`)).not.toHaveProperty(
      "result",
    );
    expect(await owner.execute(sessionId, request)).toMatchObject({
      status: "uncertain",
      replayed: true,
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });
});

describe("meeting participation native correction feedback", () => {
  it("offers one correction after a native rejection that guarantees no effect", async () => {
    const { owner, effect } = harness();
    const sourceId = owner.observe(sessionId, source);
    effect.mockResolvedValueOnce({
      status: "rejected",
      message: "Use a supported value.",
      correctable: true,
    });
    await expect(owner.execute(sessionId, { ...request, sourceId })).resolves.toEqual({
      requestId: request.requestId,
      status: "rejected",
      message: "Use a supported value.",
      correctionOf: request.requestId,
    });
    const correction = {
      ...request,
      sourceId,
      requestId: "native-correction",
      correctionOf: request.requestId,
    };
    await expect(owner.execute(sessionId, correction)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      owner.execute(sessionId, { ...correction, requestId: "second-correction" }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it.each(["succeeded", "failed", "uncertain", "unsupported"] as const)(
    "does not authorize retry of a %s native outcome",
    async (status) => {
      const { owner, effect } = harness();
      effect.mockResolvedValue({ status, correctable: true });
      const outcome = await owner.execute(sessionId, request);
      expect(outcome).toEqual({ requestId: request.requestId, status });
      await expect(
        owner.execute(sessionId, {
          ...request,
          requestId: "correction",
          correctionOf: request.requestId,
        }),
      ).resolves.toMatchObject({ status: "rejected" });
      expect(effect).toHaveBeenCalledTimes(1);
    },
  );

  it("does not offer native correction feedback for a correction's rejection", async () => {
    const { owner, effect } = harness();
    effect.mockResolvedValue({ status: "rejected", correctable: true });
    await owner.execute(sessionId, request);
    const correction = { ...request, requestId: "correction", correctionOf: request.requestId };
    await expect(owner.execute(sessionId, correction)).resolves.toEqual({
      requestId: correction.requestId,
      status: "rejected",
    });
    await expect(
      owner.execute(sessionId, {
        ...request,
        requestId: "grandchild",
        correctionOf: correction.requestId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("does not grant native correction authority after the session closes during dispatch", async () => {
    const { owner, effect } = harness();
    effect.mockImplementation(async () => {
      owner.close(sessionId);
      return { status: "rejected", correctable: true };
    });
    const outcome = await owner.execute(sessionId, request);
    expect(outcome.status).toBe("uncertain");
    expect(outcome.correctionOf).toBeUndefined();
    expect(effect).toHaveBeenCalledTimes(1);
  });
});

describe("meeting participation ledger capacity", () => {
  async function verifyClosedSessionCleanup(store: MeetingParticipationOptions<object>["store"]) {
    const { owner, effect } = harness({ store }, ["closed", "active", "next"]);
    const original = await owner.execute("closed", request);
    await owner.execute("active", request);
    owner.close("closed");
    await expect(owner.execute("closed", request)).resolves.toEqual({
      ...original,
      replayed: true,
    });

    await expect(owner.execute("next", request)).resolves.toMatchObject({ status: "succeeded" });
    expect(await store.lookup(`closed:request:${request.requestId}`)).toBeUndefined();
    expect(await store.lookup(`active:request:${request.requestId}`)).toMatchObject({
      result: { status: "succeeded" },
    });
    await expect(owner.execute("active", request)).resolves.toMatchObject({
      status: "succeeded",
      replayed: true,
    });
    await expect(owner.execute("closed", request)).resolves.toMatchObject({ status: "rejected" });
    expect(effect).toHaveBeenCalledTimes(3);
  }

  it("makes space using only closed session claims, preserving active duplicates", async () => {
    await verifyClosedSessionCleanup(memoryStore(2));
  });

  it("makes space for new meetings in the real SQLite namespace without evicting active claims", async () => {
    const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
      await import("../plugin-state/plugin-state-store.js");
    await withOpenClawTestState(
      { label: "meeting-participation-capacity", applyEnv: false },
      async (state) => {
        try {
          const store = createPluginStateKeyedStore<MeetingParticipationAttempt>("google-meet", {
            namespace: "meeting-participation",
            maxEntries: 2,
            overflowPolicy: "reject-new",
            env: state.env,
          });
          await verifyClosedSessionCleanup(store);
        } finally {
          resetPluginStateStoreForTests();
        }
      },
    );
  });

  async function verifyInvalidIdentifiersPreserveClosedLedger(
    store: MeetingParticipationOptions<object>["store"],
  ) {
    const { owner, effect } = harness({ store }, ["closed", sessionId]);
    await owner.execute("closed", request);
    owner.close("closed");
    const before = await store.entries();
    const lookup = vi.spyOn(store, "lookup");
    const claim = vi.spyOn(store, "registerIfAbsent");
    const entries = vi.spyOn(store, "entries");
    const deletion = vi.spyOn(store, "delete");

    for (const field of [
      "sessionId",
      "requestId",
      "actionType",
      "sourceId",
      "correctionOf",
    ] as const) {
      for (const value of ["", "  ", "a".repeat(129), "🦞".repeat(33)]) {
        const invalid = structuredClone(request);
        let targetSession = sessionId;
        if (field === "sessionId") {
          targetSession = value;
        } else if (field === "actionType") {
          invalid.action.type = value;
        } else {
          invalid[field] = value;
        }
        await expect(owner.execute(targetSession, invalid)).resolves.toMatchObject({
          status: "rejected",
        });
      }
    }

    expect(lookup).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await store.entries()).toEqual(before);
  }

  it("rejects malformed and oversized identifiers before any ledger access", async () => {
    await verifyInvalidIdentifiersPreserveClosedLedger(memoryStore(1));
  });

  it("does not clean up closed SQLite claims for oversized or blank input fields", async () => {
    const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
      await import("../plugin-state/plugin-state-store.js");
    await withOpenClawTestState(
      { label: "meeting-participation-invalid-fields", applyEnv: false },
      async (state) => {
        try {
          const store = createPluginStateKeyedStore<MeetingParticipationAttempt>("google-meet", {
            namespace: "meeting-participation",
            maxEntries: 1,
            overflowPolicy: "reject-new",
            env: state.env,
          });
          await verifyInvalidIdentifiersPreserveClosedLedger(store);
        } finally {
          resetPluginStateStoreForTests();
        }
      },
    );
  });

  it("does not evict current session claims when capacity is exhausted", async () => {
    const store = memoryStore(1);
    const { owner, effect } = harness({ store });
    await owner.execute(sessionId, request);
    await expect(
      owner.execute(sessionId, { ...request, requestId: "new-request" }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_LIMIT_EXCEEDED" });
    await expect(owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "succeeded",
      replayed: true,
    });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await store.entries()).toHaveLength(1);
  });

  it("reclaims an inactive session after reconstruction but never permits its action again", async () => {
    const store = memoryStore(1);
    await harness({ store }).owner.execute(sessionId, request);
    const restored = harness({ store }, ["new-session"]);
    await expect(restored.owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "succeeded",
      replayed: true,
    });
    await expect(restored.owner.execute("new-session", request)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(restored.owner.execute(sessionId, request)).resolves.toMatchObject({
      status: "rejected",
    });
    expect(restored.effect).toHaveBeenCalledTimes(1);
  });

  it.each(["typed write failure", "generic error"])(
    "never cleans up or retries a %s",
    async (kind) => {
      const store = memoryStore();
      const error =
        kind === "typed write failure"
          ? new PluginStateStoreError("Write outcome unknown.", {
              code: "PLUGIN_STATE_WRITE_FAILED",
              operation: "register",
            })
          : new Error("Write outcome unknown.");
      const claim = vi.spyOn(store, "registerIfAbsent").mockRejectedValue(error);
      const entries = vi.spyOn(store, "entries");
      const deletion = vi.spyOn(store, "delete");
      const { owner, effect } = harness({ store });
      await expect(owner.execute(sessionId, request)).rejects.toBe(error);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(entries).not.toHaveBeenCalled();
      expect(deletion).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("bounds cleanup to 1000 oldest closed claims and preserves unrelated keys", async () => {
    const store = memoryStore(1_003);
    const { owner, effect } = harness({ store });
    const attempt: MeetingParticipationAttempt = {
      kind: "meeting-participation-attempt",
      sessionId: "closed",
      requestId: "old",
      fingerprint: "old",
      actionType: "chat",
    };
    await store.register("unrelated-key", attempt);
    for (let index = 0; index < 1_001; index++) {
      await store.register(`closed:request:${index}`, { ...attempt, requestId: String(index) });
    }
    await owner.execute(sessionId, request);
    await expect(
      owner.execute(sessionId, { ...request, requestId: "next-request" }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect((await store.entries()).map((row) => row.key)).toEqual([
      "unrelated-key",
      "closed:request:1000",
      `${sessionId}:request:${request.requestId}`,
      `${sessionId}:request:next-request`,
    ]);
    expect(effect).toHaveBeenCalledTimes(2);
  });
});

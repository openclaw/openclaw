import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginStateStoreError,
  type PluginStateStoreErrorCode,
} from "../plugin-state/plugin-state-store.types.js";
import { serializePluginStoreJson } from "../plugin-state/plugin-store-validation.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  MeetingParticipationAttempt,
  MeetingParticipationOptions,
  MeetingParticipationRequest,
  MeetingParticipationResult,
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

function observe(
  owner: MeetingParticipation<object>,
  overrides: Partial<MeetingParticipationSource> = {},
) {
  return owner.observe(sessionId, { ...source, ...overrides });
}

function execute(
  owner: MeetingParticipation<object>,
  overrides: Partial<MeetingParticipationRequest> = {},
  id = sessionId,
) {
  return owner.execute(id, { ...request, ...overrides });
}

async function check(
  owner: MeetingParticipation<object>,
  expected: Partial<MeetingParticipationResult> | MeetingParticipationResult["status"],
  overrides: Partial<MeetingParticipationRequest> = {},
  id = sessionId,
) {
  await expect(execute(owner, overrides, id)).resolves.toMatchObject(
    typeof expected === "string" ? { status: expected } : expected,
  );
}

async function withSqliteStore(
  maxEntries: number,
  run: (
    store: MeetingParticipationOptions<object>["store"],
    reopen: () => MeetingParticipationOptions<object>["store"],
  ) => Promise<void>,
) {
  const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
    await import("../plugin-state/plugin-state-store.js");
  await withOpenClawTestState(
    { label: "meeting-participation", applyEnv: false },
    async (state) => {
      const createStore = () =>
        createPluginStateKeyedStore<MeetingParticipationAttempt>("google-meet", {
          namespace: "meeting-participation",
          maxEntries,
          overflowPolicy: "reject-new",
          env: state.env,
        });
      try {
        await run(createStore(), () => {
          resetPluginStateStoreForTests();
          return createStore();
        });
      } finally {
        resetPluginStateStoreForTests();
      }
    },
  );
}

function memoryStore(maxEntries = Infinity): MeetingParticipationOptions<object>["store"] {
  const rows = new Map<string, { value: MeetingParticipationAttempt; createdAt: number }>();
  let clock = 0;
  const error = (code: PluginStateStoreErrorCode) => (message: string) =>
    new PluginStateStoreError(message, { code, operation: "register" });
  const validate = (value: MeetingParticipationAttempt) =>
    serializePluginStoreJson({
      value,
      label: "plugin state value",
      maxBytes: 1_048_576,
      errors: {
        invalid: error("PLUGIN_STATE_INVALID_INPUT"),
        limit: error("PLUGIN_STATE_LIMIT_EXCEEDED"),
      },
    });
  const set = (key: string, value: MeetingParticipationAttempt) => {
    validate(value);
    if (!rows.has(key)) {
      if (rows.size >= maxEntries) {
        throw error("PLUGIN_STATE_LIMIT_EXCEEDED")("Namespace full.");
      }
    }
    rows.set(key, {
      value: structuredClone(value),
      createdAt: rows.get(key)?.createdAt ?? clock++,
    });
  };
  return {
    lookup: async (key) => structuredClone(rows.get(key)?.value),
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
      Array.from(rows, ([key, { value, createdAt }]) => ({
        key,
        value: structuredClone(value),
        createdAt,
      })),
    delete: async (key) => rows.delete(key),
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
  const current = {
    session: {},
    active: true,
    assertCurrent() {
      if (!this.active) {
        throw new Error("Session replaced.");
      }
    },
  };
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
    current: (id) => (sessionIds.includes(id) ? current : undefined),
  });
  return {
    owner,
    store,
    effect,
    leave: () => {
      current.active = false;
    },
  };
}

function inspect(owner: MeetingParticipation<object>, id: string | undefined) {
  expect(id).toEqual(expect.any(String));
  const inspection = owner.inspect(sessionId, id!);
  expect(inspection).toBeDefined();
  return inspection!;
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
      return { status: "succeeded", observed: { sent: true }, correctable: true };
    });
    const first = owner.execute(sessionId, request);
    await started.promise;
    await check(owner, { status: "uncertain", replayed: true });
    complete.release();
    const result = await first;
    expect(result).toMatchObject({ status: "succeeded", observed: { sent: true } });
    expect(result.correctionOf).toBeUndefined();
    expect(result).not.toHaveProperty("correctable");
    await expect(owner.execute(sessionId, request)).resolves.toEqual({ ...result, replayed: true });
    await check(owner, "rejected", { action: { type: "chat", text: "Different answer" } });
    await check(owner, "rejected", { requestId: "correction", correctionOf: request.requestId });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("does not replay a consumed source under a new request or after its text is revised", async () => {
    const { owner, effect } = harness();
    const sourceId = observe(owner);
    await check(owner, "succeeded", { sourceId });
    await check(owner, "rejected", { sourceId, requestId: "another-request" });
    const revisedSourceId = observe(owner, { revision: "2", text: "Please reply now." });
    expect(revisedSourceId).toBeTruthy();
    expect(revisedSourceId).not.toBe(sourceId);
    await check(owner, "rejected", { sourceId: revisedSourceId, requestId: "after-revision" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it.each(["native response", "result persistence", "non-JSON observation"])(
    "fences replay after losing %s",
    async (failure) => {
      const store = memoryStore();
      const first = harness({
        store:
          failure === "result persistence"
            ? {
                ...store,
                register: async () => {
                  throw new Error("Storage unavailable.");
                },
              }
            : store,
      });
      if (failure === "native response") {
        first.effect.mockRejectedValue(new Error("Native response lost."));
      }
      if (failure === "non-JSON observation") {
        first.effect.mockResolvedValue({
          status: "succeeded",
          observed: { unsupportedValue: undefined },
        });
      }
      await check(first.owner, "uncertain");
      if (failure !== "native response") {
        expect(await store.lookup(`${sessionId}:request:${request.requestId}`)).not.toHaveProperty(
          "result",
        );
      }
      await check(first.owner, { status: "uncertain", replayed: true });
      const restored = harness({ store });
      await check(restored.owner, { status: "uncertain", replayed: true });
      expect(first.effect).toHaveBeenCalledTimes(1);
      expect(restored.effect).not.toHaveBeenCalled();
    },
  );

  it("checks current capabilities without producing an effect for unsupported actions", async () => {
    const { owner, effect } = harness({ capabilities: () => [] });
    await check(owner, "unsupported");
    expect(effect).not.toHaveBeenCalled();
  });

  it.each([
    "close",
    "replace",
    "revoke capability",
    "mutate input",
    "close during dispatch",
  ] as const)("preserves admitted input and fences revoked authority: %s", async (change) => {
    const claimed = gate();
    const resume = gate();
    const store = memoryStore();
    const originalClaim = store.registerIfAbsent;
    let available = true;
    store.registerIfAbsent = async (...args) => {
      const result = await originalClaim(...args);
      if (change !== "revoke capability" || args[0].includes(":source:")) {
        claimed.release();
        await resume.promise;
      }
      return result;
    };
    const { owner, effect, leave } = harness({
      store,
      capabilities: () => (available ? ["chat"] : []),
    });
    const mutable = structuredClone(request);
    if (change === "revoke capability") {
      mutable.sourceId = observe(owner);
    }
    const inspected = change === "replace" ? inspect(owner, observe(owner)) : undefined;
    if (change === "close during dispatch") {
      effect.mockImplementation(async () => {
        owner.close(sessionId);
        return { status: "rejected", correctable: true };
      });
    }
    const result = owner.execute(sessionId, mutable);
    await claimed.promise;
    if (change === "close") {
      owner.close(sessionId);
      expect(observe(owner, { id: "new-message" })).toBeUndefined();
      expect(owner.context(sessionId)).toMatchObject({
        active: false,
        sources: [],
        capabilities: [],
      });
    }
    if (change === "replace") {
      leave();
      expect(owner.context(sessionId).sources).toEqual([]);
      expect(() => inspected!.assertCurrent()).toThrow();
      expect(owner.inspect(sessionId, inspected!.source.sourceId)).toBeUndefined();
    }
    if (change === "revoke capability") {
      available = false;
    }
    if (change === "mutate input") {
      mutable.action.text = "Mutated after claim";
    }
    resume.release();
    if (change === "mutate input") {
      await result;
      expect(effect.mock.calls[0]?.[1]).toEqual(request);
    } else if (change === "close during dispatch") {
      const outcome = await result;
      expect(outcome.status).toBe("uncertain");
      expect(outcome.correctionOf).toBeUndefined();
      expect(effect).toHaveBeenCalledOnce();
    } else {
      await expect(result).resolves.toMatchObject({ status: "rejected" });
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it("persists completed attempts across independent SQLite store and owner instances", async () => {
    await withSqliteStore(100, async (store, reopen) => {
      const first = harness({ store });
      const result = await first.owner.execute(sessionId, request);
      expect(result.status).toBe("succeeded");
      const restored = harness({ store: reopen() });
      await expect(restored.owner.execute(sessionId, request)).resolves.toEqual({
        ...result,
        replayed: true,
      });
      expect(restored.effect).not.toHaveBeenCalled();
    });
  });
});

describe("meeting participation observed source identities", () => {
  it.each([
    { label: "new document", update: { epoch: "document-2" } },
    { label: "corrected revision", update: { revision: "2", text: "Corrected request." } },
    { label: "own echo", update: { ownEcho: true } },
    { label: "interim revision", update: { revision: "2", finalized: false } },
    { label: "blank correction", update: { revision: "2", text: "" } },
    { label: "oversized correction", update: { revision: "2", text: "a".repeat(16_385) } },
  ])("invalidates issued source authority after a $label", async ({ update }) => {
    const { owner, effect } = harness();
    const inspection = inspect(owner, observe(owner));
    const sourceId = inspection.source.sourceId;
    const replacement = observe(owner, update);
    if (update.ownEcho) {
      expect(observe(owner, { revision: "3", ownEcho: false })).toBeUndefined();
    }
    if (update.epoch || update.text === "Corrected request.") {
      expect(observe(owner, update.epoch ? { revision: "3" } : {})).toBeUndefined();
      expect(owner.context(sessionId).sources).toMatchObject([{ sourceId: replacement }]);
    }
    expect(() => inspection.assertCurrent()).toThrow();
    expect(owner.inspect(sessionId, sourceId)).toBeUndefined();
    await check(owner, "rejected", { sourceId });
    expect(effect).not.toHaveBeenCalled();
  });

  it("expires observations without renewing their authority", async () => {
    vi.useFakeTimers();
    const { owner, effect } = harness();
    const sourceId = observe(owner);
    vi.advanceTimersByTime(120_001);
    expect(owner.context(sessionId).sources).toEqual([]);
    expect(observe(owner)).toBeUndefined();
    expect(observe(owner, { revision: "2", text: "Updated after expiry." })).toBeUndefined();
    await check(owner, "rejected", { sourceId });
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

  it("preserves retained references and issued guards when replaying 1025 unchanged captions", async () => {
    vi.useFakeTimers();
    const { owner, effect } = harness();
    const snapshot = captions(1_025);
    for (const caption of snapshot) {
      owner.observe(sessionId, caption);
    }
    const before = owner.context(sessionId);
    const retained = before.sources.at(-1)!;
    const inspection = inspect(owner, retained.sourceId);

    for (const caption of snapshot) {
      owner.observe(sessionId, caption);
    }

    expect(owner.observe(sessionId, snapshot.at(-1)!)).toBe(retained.sourceId);
    expect(() => inspection!.assertCurrent()).not.toThrow();
    expect(owner.context(sessionId)).toEqual(before);
    await check(owner, "succeeded", { sourceId: retained.sourceId });
    expect(effect).toHaveBeenCalledOnce();
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
    const original = inspect(owner, before[0]!.sourceId);
    const retained = inspect(owner, before[1]!.sourceId);
    owner.observe(sessionId, { ...snapshot[0]!, revision: "2", finalized: false });
    expect(() => original.assertCurrent()).toThrow();

    const corrected = owner.observe(sessionId, {
      ...snapshot[0]!,
      revision: "3",
      text: "Corrected request",
    });
    expect(corrected).not.toBe(before[0]!.sourceId);
    const correctedSource = inspect(owner, corrected);
    expect(correctedSource.source).toMatchObject({
      order: 1,
      replacesSourceId: before[0]!.sourceId,
    });
    expect(() => correctedSource.assertCurrent()).not.toThrow();

    observe(owner, { kind: "caption", id: "next-caption" });
    expect(owner.context(sessionId).sources).toHaveLength(1_024);
    expect(() => correctedSource.assertCurrent()).toThrow();
    expect(() => retained.assertCurrent()).not.toThrow();
    expect(owner.inspect(sessionId, corrected!)).toBeUndefined();
  });
});

describe("meeting participation bounded correction", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("permits one correction (native: %s, rejected correction: %s)", async (native, rejected) => {
    const { owner, effect } = harness();
    const invalid = { action: native ? request.action : { type: "chat", text: "" } };
    const correction = { requestId: "correction-1", correctionOf: request.requestId };
    const sourceId = rejected ? undefined : observe(owner);
    if (native) {
      effect.mockResolvedValueOnce({
        status: "rejected",
        ...(!rejected ? { message: "Use a supported value." } : {}),
        correctable: true,
      });
      effect.mockResolvedValue(
        rejected ? { status: "rejected", correctable: true } : { status: "succeeded" },
      );
    }
    await check(
      owner,
      {
        status: "rejected",
        correctionOf: request.requestId,
        ...(!rejected ? { message: native ? "Use a supported value." : "Text is required." } : {}),
      },
      { ...invalid, sourceId },
    );
    if (!rejected) {
      await check(owner, "rejected", { sourceId, requestId: "bypass-invalid-request" });
    }
    const result = await execute(owner, {
      ...correction,
      sourceId,
      action: rejected ? invalid.action : request.action,
    });
    expect(result).toMatchObject({
      requestId: correction.requestId,
      status: rejected ? "rejected" : "succeeded",
    });
    expect(result.correctionOf).toBeUndefined();
    if (!rejected) {
      await check(owner, "rejected", { ...correction, sourceId, requestId: "correction-2" });
    }
    await check(owner, "rejected", {
      sourceId,
      requestId: "grandchild",
      correctionOf: correction.requestId,
    });
    expect(effect).toHaveBeenCalledTimes(native ? 2 : rejected ? 0 : 1);
  });

  it.each(["different source", "different action", "new source authority"])(
    "rejects a correction with %s",
    async (change) => {
      const { owner, effect } = harness();
      const sourceId = observe(owner);
      const anotherSourceId = observe(owner, { id: "provider-message-2" });
      await execute(owner, {
        sourceId: change === "new source authority" ? undefined : sourceId,
        action: { type: "chat", text: "" },
      });
      await check(owner, "rejected", {
        requestId: "correction-1",
        correctionOf: request.requestId,
        sourceId: change === "different source" ? anotherSourceId : sourceId,
        action: change === "different action" ? { type: "reaction" } : request.action,
      });
      expect(effect).not.toHaveBeenCalled();
    },
  );
});

describe("meeting participation ledger capacity", () => {
  it("makes space for new meetings in the real SQLite namespace without evicting active claims", async () => {
    await withSqliteStore(2, async (store) => {
      const { owner, effect } = harness({ store }, ["closed", "active", "next"]);
      effect.mockResolvedValue({ status: "succeeded", message: undefined, observed: undefined });
      const original = await owner.execute("closed", {
        ...request,
        sourceId: undefined,
        correctionOf: undefined,
      });
      await owner.execute("active", request);
      owner.close("closed");
      await expect(owner.execute("closed", request)).resolves.toEqual({
        ...original,
        replayed: true,
      });

      await check(owner, "succeeded", {}, "next");
      expect(await store.lookup(`closed:request:${request.requestId}`)).toBeUndefined();
      const stored = await store.lookup(`active:request:${request.requestId}`);
      expect(stored).not.toHaveProperty("sourceId");
      expect(stored).not.toHaveProperty("correctionOf");
      expect(stored?.result).toEqual({ requestId: request.requestId, status: "succeeded" });
      await check(owner, { status: "succeeded", replayed: true }, {}, "active");
      await check(owner, "rejected", {}, "closed");
      expect(effect).toHaveBeenCalledTimes(3);
    });
  });

  it("does not clean up closed SQLite claims for oversized or blank input fields", async () => {
    await withSqliteStore(1, async (store) => {
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
    });
  });

  it("does not evict current session claims when capacity is exhausted", async () => {
    const store = memoryStore(1);
    const { owner, effect } = harness({ store });
    await owner.execute(sessionId, request);
    await expect(
      owner.execute(sessionId, { ...request, requestId: "new-request" }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_LIMIT_EXCEEDED" });
    await check(owner, { status: "succeeded", replayed: true });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await store.entries()).toHaveLength(1);
  });

  it("reclaims an inactive session after reconstruction but never permits its action again", async () => {
    const store = memoryStore(1);
    await harness({ store }).owner.execute(sessionId, request);
    const restored = harness({ store }, ["new-session"]);
    await check(restored.owner, { status: "succeeded", replayed: true });
    await check(restored.owner, "succeeded", {}, "new-session");
    await check(restored.owner, "rejected");
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
    await check(owner, "succeeded", { requestId: "next-request" });
    expect((await store.entries()).map((row) => row.key)).toEqual([
      "unrelated-key",
      "closed:request:1000",
      `${sessionId}:request:${request.requestId}`,
      `${sessionId}:request:next-request`,
    ]);
    expect(effect).toHaveBeenCalledTimes(2);
  });
});

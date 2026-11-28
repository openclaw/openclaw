import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../deferred.js";
import { DictationRefinementCoordinator } from "./coordinator.js";
import { detectRefinementLiteralSpans, whitespaceRefinementProcessor } from "./plan.js";
import {
  REFINEMENT_LIMITS,
  RefinementError,
  type RefinementCandidate,
  type RefinementCoordinatorOptions,
  type RefinementModelAdapter,
  type RefinementModelInput,
  type RefinementProcessor,
  type RefinementRequest,
} from "./types.js";
import { validateRefinementCandidate, validateRefinementRequest } from "./validation.js";

function request(overrides: Partial<RefinementRequest> = {}): RefinementRequest {
  const rawTranscript = overrides.rawTranscript ?? "  Do not delete customer_id.  ";
  return {
    schemaVersion: 1,
    offsetUnit: "utf16",
    captureId: "capture",
    generation: 1,
    transcriptRevision: 3,
    rawTranscript,
    isFinal: true,
    mode: "dictation",
    locale: { tag: "en-US", source: "user" },
    target: { id: "draft", revision: 0, draftRevision: 0 },
    scope: {
      connectionId: "connection",
      connectionGeneration: 1,
      accountId: "account",
      authorizationRevision: 1,
      policyRevision: 1,
    },
    transcriptProvenance: { authorizationRevision: 1, hintSnapshotIds: [] },
    contextSnapshots: [],
    vocabularySnapshots: [],
    protectedSpans: detectRefinementLiteralSpans(rawTranscript),
    authorizedEdits: [],
    featurePolicy: { enabled: true, processorIds: ["whitespace"] },
    providerPolicy: { routeId: null, locality: "strict-local" },
    deadlineAt: Date.now() + 2_500,
    ...overrides,
  };
}

function candidate(text: string, baseRevision = 3): RefinementCandidate {
  return { schemaVersion: 1, offsetUnit: "utf16", baseRevision, kind: "text", text };
}

const owners: DictationRefinementCoordinator[] = [];
function owner(options: Partial<RefinementCoordinatorOptions> = {}) {
  const coordinator = new DictationRefinementCoordinator({
    processors: [whitespaceRefinementProcessor],
    isCurrent: () => true,
    authorize: () => true,
    ...options,
  });
  owners.push(coordinator);
  return coordinator;
}

// These are transport/conformance fixtures, not claims of shipped optional features or offline inference.
function model(
  refine: RefinementModelAdapter["refine"],
  locality: "local" | "remote" = "local",
): RefinementModelAdapter {
  return { id: "selected", locality, supportedLocales: ["en"], refine };
}
function modelRequest(overrides: Partial<RefinementRequest> = {}) {
  return request({
    providerPolicy: { routeId: "selected", locality: "strict-local" },
    ...overrides,
  });
}

afterEach(() => {
  for (const coordinator of owners.splice(0)) {
    coordinator.dispose();
  }
  vi.useRealTimers();
});

describe("private refinement boundary", () => {
  it.each([
    { schemaVersion: 2 },
    { offsetUnit: "bytes" },
    { generation: -1 },
    { generation: 1.5 },
    { transcriptRevision: Number.NaN },
    { isFinal: "yes" },
    { deadlineAt: Infinity },
    { locale: { tag: "not a locale", source: "user" } },
    { unexpected: "instruction" },
  ])("rejects malformed capture snapshots before dispatch: %j", async (invalid) => {
    const refine = vi.fn();
    await expect(
      owner({ model: model(refine) }).refine({ ...modelRequest(), ...invalid }),
    ).rejects.toBeInstanceOf(RefinementError);
    expect(refine).not.toHaveBeenCalled();
  });

  it("rejects UTF-8 byte overflow and wrong-base/overlapping/unknown output", () => {
    expect(() =>
      validateRefinementRequest(
        request({ rawTranscript: "界".repeat(11_000), protectedSpans: [] }),
      ),
    ).toThrow("payload-limit");
    const base = { text: "alpha beta", revision: 3, protectedSpans: [] };
    expect(() => validateRefinementCandidate(candidate("alpha beta", 2), base)).toThrow(
      "wrong-base",
    );
    expect(() =>
      validateRefinementCandidate(
        { ...candidate("alpha beta"), toolCalls: [{ name: "delete" }] },
        base,
      ),
    ).toThrow("invalid-candidate");
    expect(() =>
      validateRefinementCandidate(
        {
          schemaVersion: 1,
          offsetUnit: "utf16",
          baseRevision: 3,
          kind: "edits",
          edits: [
            { start: 0, end: 5, text: "one" },
            { start: 3, end: 6, text: "two" },
          ],
        },
        base,
      ),
    ).toThrow("invalid-range");
    expect(() =>
      validateRefinementCandidate(candidate("x".repeat(REFINEMENT_LIMITS.outputBytes + 1)), base),
    ).toThrow("payload-limit");
  });

  it.each(["context-count", "vocabulary-count", "context-bytes", "vocabulary-bytes", "combined"])(
    "rejects %s overflow before any model dispatch",
    async (boundary) => {
      const snapshot = (id: string, text: string) => ({
        id,
        text,
        revision: 1,
        source: "fixture",
        authorizationId: "owner",
        expiresAt: Date.now() + 10_000,
      });
      const accepted = {
        ...modelRequest(),
        contextSnapshots: [snapshot("context", "c".repeat(8_192))],
        vocabularySnapshots: [snapshot("vocabulary", "v".repeat(8_192))],
      };
      expect(() => validateRefinementRequest(accepted)).not.toThrow();
      const patch =
        boundary === "context-count"
          ? {
              contextSnapshots: Array.from({ length: 33 }, (_, index) => snapshot(`c${index}`, "")),
            }
          : boundary === "vocabulary-count"
            ? {
                vocabularySnapshots: Array.from({ length: 33 }, (_, index) =>
                  snapshot(`v${index}`, ""),
                ),
              }
            : boundary === "context-bytes"
              ? {
                  contextSnapshots: [
                    snapshot("a", "界".repeat(1_366)),
                    snapshot("b", "界".repeat(1_366)),
                  ],
                }
              : boundary === "vocabulary-bytes"
                ? {
                    vocabularySnapshots: [
                      snapshot("a", "v".repeat(4_097)),
                      snapshot("b", "v".repeat(4_097)),
                    ],
                  }
                : {
                    rawTranscript: '"'.repeat(22_000),
                    protectedSpans: [],
                    contextSnapshots: [snapshot("a", '"'.repeat(8_192))],
                    vocabularySnapshots: [snapshot("b", '"'.repeat(8_192))],
                  };
      const refine = vi.fn();
      await expect(
        owner({ model: model(refine) }).refine({ ...accepted, ...patch }),
      ).rejects.toMatchObject({ code: "payload-limit" });
      expect(refine).not.toHaveBeenCalled();
    },
  );

  it("rejects every edit boundary inside surrogate, combining and joined graphemes", () => {
    for (const grapheme of ["😀", "e\u0301", "👩‍💻", "🇦🇺"]) {
      const base = { text: `a${grapheme}b`, revision: 3, protectedSpans: [] };
      for (let offset = 2; offset < 1 + grapheme.length; offset++) {
        expect(() =>
          validateRefinementCandidate(
            {
              schemaVersion: 1,
              offsetUnit: "utf16",
              baseRevision: 3,
              kind: "edits",
              edits: [{ start: offset, end: offset, text: "x" }],
            },
            base,
          ),
        ).toThrow("invalid-range");
      }
    }
  });

  it("keeps protected reference identity and rejects replacement, duplication, reordering and joined marks", () => {
    const base = {
      text: "alpha beta",
      revision: 3,
      protectedSpans: [
        { start: 0, end: 5, kind: "reference" as const, identity: "object-1" },
        { start: 6, end: 10, kind: "literal" as const },
      ],
    };
    for (const output of ["gamma beta", "alpha alpha beta", "beta alpha", "alpha\u0301 beta"]) {
      expect(() => validateRefinementCandidate(candidate(output), base)).toThrow(
        "protected-content",
      );
    }
    const valid = validateRefinementCandidate(candidate(" alpha beta "), base);
    expect(valid.protectedSpans[0]).toEqual({
      start: 1,
      end: 6,
      kind: "reference",
      identity: "object-1",
    });
  });
});

describe("one bounded plan and eligible recovery", () => {
  it("supports no processors, disabled mode, unsupported locale and missing adapters without model work", async () => {
    for (const configuration of [
      request({ featurePolicy: { enabled: false, processorIds: [] } }),
      request({ featurePolicy: { enabled: true, processorIds: [] } }),
      request({ featurePolicy: { enabled: true, processorIds: ["future-M07-fixture"] } }),
    ]) {
      const result = await owner({ processors: [] }).refine(configuration);
      expect(result).toMatchObject({
        status: "raw-fallback",
        text: configuration.rawTranscript,
        metrics: { providerRequests: 0 },
      });
    }
    const refine = vi.fn();
    const result = await owner({ model: model(refine) }).refine(
      modelRequest({ locale: { tag: "ar", source: "user" } }),
    );
    expect(result.warnings).toContain("unsupported-locale");
    expect(refine).not.toHaveBeenCalled();
  });

  it("protects joined words, not plain prose or unmatched underscores", () => {
    const text = "今日は晴れ _𠮷_駅__tag_２_cafe\u0301_ plain";
    const spans = detectRefinementLiteralSpans(text);
    expect(spans.map(({ start, end }) => text.slice(start, end))).toEqual([
      "𠮷_駅",
      "tag_２_cafe\u0301",
    ]);
  });

  it("only trims outer whitespace and preserves quoted/code/literal bytes", async () => {
    const quoted = '"https://example.test/customer_id"';
    const rawTranscript = '  keep " a  b " and `x  =  1` and ' + (quoted + " ").repeat(70);
    const result = await owner().refine(request({ rawTranscript }));
    expect(result.status).toBe("refined");
    expect(result.text).toBe(rawTranscript.trim());
    expect(result.rawText).toBe(rawTranscript);
  });

  it.each([false, true])(
    "refuses model-only work without a selected route (with local work: %s)",
    async (withLocal) => {
      const prose: RefinementProcessor = {
        id: "prose-fixture",
        stage: "prose",
        order: 0,
        modes: ["dictation"],
        supportedLocales: ["en"],
        modelInstruction: "Preserve the speaker's wording.",
      };
      const result = await owner({ processors: [whitespaceRefinementProcessor, prose] }).refine(
        request({
          featurePolicy: {
            enabled: true,
            processorIds: withLocal ? ["whitespace", prose.id] : [prose.id],
          },
        }),
      );
      expect(result).toMatchObject({
        status: "raw-fallback",
        warnings: ["provider-unavailable"],
        metrics: { providerRequests: 0 },
      });
      expect(result.text).toBe(result.rawText);
    },
  );

  it("orders optional conformance adapters, freezes nested input and combines policy into one selected request", async () => {
    const stages: string[] = [];
    const fixture = (id: string, stage: RefinementProcessor["stage"]): RefinementProcessor => ({
      id,
      stage,
      order: 0,
      modes: ["dictation"],
      supportedLocales: ["en"],
      modelInstruction: `fixture: ${id}`,
      transform(input) {
        stages.push(id);
        expect(Object.isFrozen(input.request.scope)).toBe(true);
        expect(Object.isFrozen(input.request.contextSnapshots)).toBe(true);
        return candidate(input.text, input.baseRevision);
      },
    });
    const refine = vi.fn(async (input: RefinementModelInput) => {
      expect(input.modelInstructions).toEqual([
        "fixture: correction",
        "fixture: snippet",
        "fixture: style",
      ]);
      return candidate(input.text, input.baseRevision);
    });
    const result = await owner({
      processors: [
        fixture("style", "prose"),
        fixture("snippet", "deterministic"),
        fixture("correction", "intent"),
      ],
      model: model(refine),
    }).refine(
      modelRequest({
        featurePolicy: { enabled: true, processorIds: ["style", "snippet", "correction"] },
      }),
    );
    expect(stages).toEqual(["correction", "snippet", "style"]);
    expect(refine).toHaveBeenCalledOnce();
    expect(result.metrics.providerRequests).toBe(1);
  });

  it("applies explicit correction before prose and protects an approved static expansion", async () => {
    const rawTranscript = "Tuesday no Thursday snippet";
    const refine = vi.fn(async (input: RefinementModelInput) => {
      expect(input.text).toBe("Thursday customer_id");
      return candidate("Thursday customer ID", input.baseRevision);
    });
    const result = await owner({ model: model(refine) }).refine(
      modelRequest({
        rawTranscript,
        authorizedEdits: [
          { start: 0, end: 19, text: "Thursday", intentId: "correction-1", kind: "correction" },
          {
            start: 20,
            end: 27,
            text: "customer_id",
            intentId: "snippet-1",
            kind: "expansion",
            protection: { kind: "snippet" },
          },
        ],
      }),
    );
    expect(result).toMatchObject({ status: "raw-fallback", text: rawTranscript });
    expect(result.warnings).toContain("protected-content");
    expect(refine).toHaveBeenCalledOnce();
  });

  it("rejects original-offset edits after a preceding transform changes the exact base", async () => {
    const refine = vi.fn(async (input: RefinementModelInput) => {
      expect(input.text).toBe("alpha beta");
      expect(input.baseRevision).toBe(4);
      return {
        schemaVersion: 1,
        offsetUnit: "utf16",
        baseRevision: 3,
        kind: "edits",
        edits: [{ start: 0, end: 5, text: "other" }],
      };
    });
    const result = await owner({ model: model(refine) }).refine(
      modelRequest({ rawTranscript: "  alpha beta  " }),
    );
    expect(result).toMatchObject({
      status: "raw-fallback",
      text: "  alpha beta  ",
      warnings: ["wrong-base"],
    });
  });

  it("owns the admitted snapshot even if the caller changes its input during a provider request", async () => {
    const pending = createDeferredCore<unknown>();
    let admitted: RefinementModelInput | undefined;
    const mutable = {
      ...modelRequest({ featurePolicy: { enabled: true, processorIds: [] } }),
      scope: { ...request().scope },
    };
    const result = owner({
      model: model((input) => {
        admitted = input;
        return pending.promise;
      }),
    }).refine(mutable);
    mutable.rawTranscript = "different words";
    mutable.scope.accountId = "another account";
    expect(admitted?.request.rawTranscript).toBe("  Do not delete customer_id.  ");
    expect(admitted?.request.scope.accountId).toBe("account");
    pending.resolve(candidate("  Do not delete customer_id.  "));
    expect((await result).text).toBe("  Do not delete customer_id.  ");
  });

  it.each([
    ["Do not delete backup", "Do delete backup"],
    ["Pay Alice 5 kg on Tuesday", "Pay Alicia 50 lb on Thursday"],
    ["Call Ana", "Call Ana and approve the purchase"],
    ["if allowed:\n  delete_backup()", "if allowed:\ndelete_backup()"],
  ])("requires review of uncertain meaning: %s", async (rawTranscript, rewritten) => {
    const result = await owner({ model: model(async () => candidate(rewritten)) }).refine(
      modelRequest({ rawTranscript }),
    );
    expect(result).toMatchObject({
      status: "needs-review",
      text: rawTranscript,
      candidateText: rewritten,
    });
    expect(result.warnings).toContain("meaning-review");
  });

  it("never promotes a partial caption and refuses remote dispatch under strict local policy", async () => {
    const refine = vi.fn();
    const coordinator = owner({ model: model(refine, "remote") });
    const partial = await coordinator.refine(
      modelRequest({ isFinal: false, transcriptRevision: 1 }),
    );
    expect(partial).toMatchObject({ status: "unavailable", warnings: ["incomplete-transcript"] });
    expect(partial.text).toBeUndefined();
    const final = await coordinator.refine(modelRequest());
    expect(final.warnings).toContain("locality-denied");
    expect(refine).not.toHaveBeenCalled();
  });

  it("falls back once on malformed/provider failure without retries or private errors in metrics", async () => {
    const onMetric = vi.fn();
    const refine = vi.fn(async () => {
      throw new Error("SECRET TRANSCRIPT and PRIVATE CONTEXT");
    });
    const result = await owner({ model: model(refine), onMetric }).refine(modelRequest());
    expect(result.status).toBe("raw-fallback");
    expect(result.warnings).toContain("provider-error");
    expect(refine).toHaveBeenCalledOnce();
    expect(JSON.stringify(onMetric.mock.calls)).not.toMatch(/SECRET|PRIVATE|customer_id/u);
  });
});

describe("generation and authority races", () => {
  it("retires a cancelled provisional generation but allows a newer capture", async () => {
    const refine = vi.fn(async () => candidate("Do not delete customer_id."));
    const coordinator = owner({ model: model(refine) });
    await coordinator.refine(modelRequest({ isFinal: false, transcriptRevision: 1 }));
    coordinator.cancel();
    const late = await coordinator.refine(modelRequest());
    expect(late).toMatchObject({ status: "cancelled", warnings: ["cancelled"] });
    expect(late.text).toBeUndefined();
    expect(refine).not.toHaveBeenCalled();
    const next = await coordinator.refine(request({ captureId: "next", generation: 2 }));
    expect(next.status).toBe("refined");
    expect(
      (await coordinator.refine(request({ captureId: "next", generation: 2 }))).warnings,
    ).toContain("duplicate-final");
  });

  it("cancels promptly, ignores a late provider and suppresses duplicate or late partial generations", async () => {
    const pending = createDeferredCore<unknown>();
    const refine = vi.fn(() => pending.promise);
    const coordinator = owner({ model: model(refine) });
    const first = coordinator.refine(
      modelRequest({ featurePolicy: { enabled: true, processorIds: [] } }),
    );
    expect(refine).toHaveBeenCalledOnce();
    coordinator.cancel();
    expect((await first).status).toBe("cancelled");
    pending.resolve(candidate("late rewrite"));
    expect((await coordinator.refine(modelRequest())).warnings).toContain("cancelled");
    expect(
      (await coordinator.refine(modelRequest({ isFinal: false, transcriptRevision: 4 }))).status,
    ).toBe("cancelled");
    expect(refine).toHaveBeenCalledOnce();
  });

  it("a new recording and a user edit each prevent stale success and fallback", async () => {
    let current = true;
    const pending = createDeferredCore<unknown>();
    const coordinator = owner({ model: model(() => pending.promise), isCurrent: () => current });
    const old = coordinator.refine(
      modelRequest({ featurePolicy: { enabled: true, processorIds: [] } }),
    );
    const next = await coordinator.refine(request({ captureId: "next", generation: 2 }));
    expect(next.text).toBe("Do not delete customer_id.");
    expect((await old).status).toBe("cancelled");
    const edit = coordinator.refine(
      modelRequest({ generation: 3, featurePolicy: { enabled: true, processorIds: [] } }),
    );
    current = false;
    pending.resolve(candidate("Do not delete customer_id."));
    expect(await edit).toMatchObject({ status: "cancelled", warnings: ["superseded"] });
  });

  it("a deadline aborts the adapter and never marks raw fallback as successful refinement", async () => {
    vi.useFakeTimers();
    const pending = createDeferredCore<unknown>();
    let providerSignal: AbortSignal | undefined;
    const coordinator = owner({
      model: model((_input, signal) => {
        providerSignal = signal;
        return pending.promise;
      }),
    });
    const resultPromise = coordinator.refine(
      modelRequest({ featurePolicy: { enabled: true, processorIds: [] } }),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await resultPromise;
    expect(providerSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "raw-fallback",
      warnings: ["deadline"],
      metrics: { providerRequests: 1 },
    });
    pending.resolve(candidate("ignored late result"));
  });

  it("revoked STT hint provenance makes newly arriving raw fallback unavailable", async () => {
    const pending = createDeferredCore<unknown>();
    let authorized = true;
    const coordinator = owner({ model: model(() => pending.promise), authorize: () => authorized });
    const refinement = coordinator.refine(
      modelRequest({
        featurePolicy: { enabled: true, processorIds: [] },
        transcriptProvenance: { authorizationRevision: 1, hintSnapshotIds: ["shared"] },
        vocabularySnapshots: [
          {
            id: "shared",
            revision: 1,
            source: "shared",
            authorizationId: "membership",
            expiresAt: Date.now() + 10_000,
            text: "customer_id",
          },
        ],
      }),
    );
    authorized = false;
    pending.reject(new Error("provider unavailable"));
    expect(await refinement).toMatchObject({
      status: "unavailable",
      warnings: ["provider-error", "authorization-changed"],
    });
  });

  it("expiry of refinement-only context permits independently authorized raw recovery", async () => {
    vi.useFakeTimers();
    const pending = createDeferredCore<unknown>();
    const coordinator = owner({ model: model(() => pending.promise) });
    const refinement = coordinator.refine(
      modelRequest({
        featurePolicy: { enabled: true, processorIds: [] },
        contextSnapshots: [
          {
            id: "context",
            revision: 1,
            source: "selection",
            authorizationId: "consent",
            expiresAt: Date.now() + 10,
            text: "bounded context",
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(11);
    pending.resolve(candidate("Do not delete customer_id."));
    expect(await refinement).toMatchObject({
      status: "raw-fallback",
      warnings: ["authorization-changed"],
    });
  });
});

import { compileRefinementPlan, registerRefinementProcessors } from "./plan.js";
import {
  REFINEMENT_LIMITS,
  RefinementError,
  type ProtectedSpan,
  type RefinementCoordinatorOptions,
  type RefinementFailureCode,
  type RefinementModelInput,
  type RefinementPhase,
  type RefinementRequest,
  type RefinementResult,
} from "./types.js";
import {
  freezeRefinementValue,
  refinementByteLength,
  validateRefinementCandidate,
  validateRefinementRequest,
} from "./validation.js";

type Outcome = Pick<
  RefinementResult,
  "status" | "text" | "rawText" | "candidateText" | "protectedSpans" | "warnings"
>;
type Operation = {
  request: RefinementRequest;
  controller: AbortController;
  startedAt: number;
  inputBytes: number;
  providerRequests: number;
  finished: boolean;
  phases: { phase: RefinementPhase; durationMs: number }[];
};

/** One preview owner, one active operation, no queued transcripts or durable history. */
export class DictationRefinementCoordinator {
  private readonly processors;
  private readonly now;
  private active: Operation | undefined;
  private latest:
    | {
        captureId: string;
        generation: number;
        revision: number;
        final: boolean;
        cancelled: boolean;
      }
    | undefined;
  private disposed = false;

  constructor(private readonly options: RefinementCoordinatorOptions) {
    this.processors = registerRefinementProcessors(options.processors ?? []);
    this.now = options.now ?? Date.now;
  }

  cancel(): void {
    if (this.latest) {
      // Provisional input also owns a generation. Cancellation must retire it
      // even when no final operation has started yet.
      this.latest.cancelled = true;
    }
    this.active?.controller.abort(new RefinementError("cancelled"));
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  /** Generation is monotonic for this owner, including when a capture ID changes. */
  async refine(value: unknown, signal?: AbortSignal): Promise<RefinementResult> {
    const request = validateRefinementRequest(value);
    const operation: Operation = {
      request,
      controller: new AbortController(),
      startedAt: this.now(),
      inputBytes: refinementByteLength(request.rawTranscript),
      providerRequests: 0,
      finished: false,
      phases: [],
    };
    if (this.disposed || signal?.aborted) {
      return this.finish(operation, { status: "cancelled", warnings: ["cancelled"] });
    }
    const latest = this.latest;
    if (
      latest &&
      (request.generation < latest.generation ||
        (request.generation === latest.generation &&
          (request.captureId !== latest.captureId ||
            latest.final ||
            latest.cancelled ||
            request.transcriptRevision < latest.revision)))
    ) {
      return this.finish(operation, {
        status: "cancelled",
        warnings: [
          latest.cancelled && request.generation === latest.generation
            ? "cancelled"
            : latest.final && request.generation === latest.generation
              ? "duplicate-final"
              : "superseded",
        ],
      });
    }
    this.active?.controller.abort(new RefinementError("superseded"));
    this.latest = {
      captureId: request.captureId,
      generation: request.generation,
      revision: request.transcriptRevision,
      final: request.isFinal,
      cancelled: false,
    };
    if (!request.isFinal) {
      return this.finish(operation, { status: "unavailable", warnings: ["incomplete-transcript"] });
    }
    this.active = operation;
    const remaining = Math.min(
      REFINEMENT_LIMITS.deadlineMs,
      request.deadlineAt - operation.startedAt,
    );
    const abortExternal = () => operation.controller.abort(new RefinementError("cancelled"));
    signal?.addEventListener("abort", abortExternal, { once: true });
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (remaining <= 0) {
        return this.finish(operation, this.fallback(operation, "deadline"));
      }
      timer = globalThis.setTimeout(
        () => operation.controller.abort(new RefinementError("deadline")),
        remaining,
      );
      const aborted = new Promise<Outcome>((resolve) => {
        abortListener = () => {
          const reason: unknown = operation.controller.signal.reason;
          resolve(
            reason instanceof RefinementError && reason.code === "deadline"
              ? this.fallback(operation, "deadline")
              : {
                  status: "cancelled",
                  warnings: [reason instanceof RefinementError ? reason.code : "cancelled"],
                },
          );
        };
        operation.controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      const outcome = await Promise.race([this.execute(operation), aborted]);
      return this.finish(operation, outcome);
    } finally {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abortExternal);
      if (abortListener) {
        operation.controller.signal.removeEventListener("abort", abortListener);
      }
      if (this.active === operation) {
        this.active = undefined;
      }
    }
  }

  private current(request: RefinementRequest): boolean {
    try {
      return this.options.isCurrent(request);
    } catch {
      return false;
    }
  }

  private authorized(
    request: RefinementRequest,
    phase: "dispatch" | "publication" | "fallback",
  ): boolean {
    const used =
      phase === "fallback"
        ? [...request.contextSnapshots, ...request.vocabularySnapshots].filter((snapshot) =>
            request.transcriptProvenance.hintSnapshotIds.includes(snapshot.id),
          )
        : [...request.contextSnapshots, ...request.vocabularySnapshots];
    if (used.some((snapshot) => snapshot.expiresAt <= this.now())) {
      return false;
    }
    try {
      return this.options.authorize(request, phase);
    } catch {
      return false;
    }
  }

  private assertActive(operation: Operation): void {
    operation.controller.signal.throwIfAborted();
    if (this.active !== operation || !this.current(operation.request)) {
      throw new RefinementError("superseded");
    }
    if (
      this.now() >= operation.request.deadlineAt ||
      this.now() - operation.startedAt >= REFINEMENT_LIMITS.deadlineMs
    ) {
      operation.controller.abort(new RefinementError("deadline"));
      throw new RefinementError("deadline");
    }
  }

  private fallback(
    operation: Operation,
    reason: RefinementFailureCode,
    warnings: readonly RefinementFailureCode[] = [],
  ): Outcome {
    const request = operation.request;
    if (!this.current(request)) {
      return { status: "cancelled", warnings: ["superseded"] };
    }
    if (!request.isFinal || !request.rawTranscript || !this.authorized(request, "fallback")) {
      return {
        status: "unavailable",
        warnings: [
          ...warnings,
          reason,
          ...(!request.isFinal
            ? ["incomplete-transcript" as const]
            : request.rawTranscript
              ? ["authorization-changed" as const]
              : []),
        ],
      };
    }
    return {
      status: "raw-fallback",
      text: request.rawTranscript,
      rawText: request.rawTranscript,
      protectedSpans: request.protectedSpans,
      warnings: [...warnings, reason],
    };
  }

  private async execute(operation: Operation): Promise<Outcome> {
    const { request, controller } = operation;
    let warnings: readonly RefinementFailureCode[] = [];
    let phase: RefinementPhase = "plan";
    let phaseStarted = this.now();
    const endPhase = () => {
      if (!operation.finished) {
        operation.phases.push({ phase, durationMs: Math.max(0, this.now() - phaseStarted) });
      }
      phaseStarted = this.now();
    };
    try {
      this.assertActive(operation);
      if (!request.featurePolicy.enabled) {
        return this.fallback(operation, "disabled");
      }
      const plan = compileRefinementPlan(request, this.processors, this.options.model);
      warnings = plan.warnings;
      if (!this.authorized(request, "dispatch")) {
        return this.fallback(operation, "authorization-changed");
      }
      if (!plan.processors.length && !plan.model && !request.authorizedEdits.length) {
        return this.fallback(operation, warnings[0] ?? "disabled", warnings.slice(1));
      }
      let text = plan.text;
      let baseRevision = request.transcriptRevision + (text === request.rawTranscript ? 0 : 1);
      let protectedSpans: readonly ProtectedSpan[] = plan.protectedSpans;
      let needsReview = false;
      const input = (): RefinementModelInput =>
        freezeRefinementValue({
          request,
          text,
          baseRevision,
          protectedSpans,
          modelInstructions: plan.modelInstructions,
        });
      const accept = (candidate: unknown) => {
        const validated = validateRefinementCandidate(candidate, {
          text,
          revision: baseRevision,
          protectedSpans,
        });
        needsReview ||=
          validated.needsReview || (request.mode !== "dictation" && validated.text !== text);
        if (validated.text !== text) {
          baseRevision++;
          if (!Number.isSafeInteger(baseRevision)) {
            throw new RefinementError("invalid-candidate");
          }
        }
        text = validated.text;
        protectedSpans = validated.protectedSpans;
      };
      // Owner-approved literal/expansion spans must also be valid in the resulting text.
      accept({
        schemaVersion: 1,
        offsetUnit: "utf16",
        baseRevision,
        kind: "text",
        text,
      });
      endPhase();
      phase = "deterministic";
      for (const processor of plan.processors) {
        this.assertActive(operation);
        if (processor.transform) {
          accept(await processor.transform(input(), controller.signal));
        }
      }
      this.assertActive(operation);
      endPhase();
      if (plan.model) {
        phase = "provider";
        if (!this.authorized(request, "dispatch")) {
          return this.fallback(operation, "authorization-changed", warnings);
        }
        const modelInput = input();
        // Account for the actual bounded text passed after explicit expansions.
        if (
          refinementByteLength(
            JSON.stringify({
              text,
              context: request.contextSnapshots,
              vocabulary: request.vocabularySnapshots,
              instructions: plan.modelInstructions,
            }),
          ) > REFINEMENT_LIMITS.payloadBytes
        ) {
          throw new RefinementError("payload-limit");
        }
        operation.providerRequests = 1;
        const candidate = await plan.model.refine(modelInput, controller.signal);
        this.assertActive(operation);
        endPhase();
        phase = "validation";
        accept(candidate);
      } else {
        phase = "validation";
      }
      this.assertActive(operation);
      if (!this.authorized(request, "publication")) {
        return this.fallback(operation, "authorization-changed", warnings);
      }
      endPhase();
      return needsReview
        ? {
            status: "needs-review",
            text: request.rawTranscript,
            rawText: request.rawTranscript,
            candidateText: text,
            protectedSpans: request.protectedSpans,
            warnings: [...warnings, "meaning-review"],
          }
        : { status: "refined", text, rawText: request.rawTranscript, protectedSpans, warnings };
    } catch (error) {
      endPhase();
      const reason =
        error instanceof RefinementError
          ? error.code
          : controller.signal.aborted
            ? "cancelled"
            : phase === "provider"
              ? "provider-error"
              : "processor-error";
      if (reason === "cancelled" || reason === "superseded") {
        return { status: "cancelled", warnings: [reason] };
      }
      return this.fallback(operation, reason, warnings);
    }
  }

  private finish(operation: Operation, proposed: Outcome): RefinementResult {
    const { request } = operation;
    let outcome = proposed;
    if (operation.controller.signal.aborted) {
      const reason: unknown = operation.controller.signal.reason;
      if (!(reason instanceof RefinementError && reason.code === "deadline")) {
        outcome = {
          status: "cancelled",
          warnings: [reason instanceof RefinementError ? reason.code : "cancelled"],
        };
      }
    }
    if (
      (outcome.status === "refined" || outcome.status === "needs-review") &&
      (this.now() >= request.deadlineAt ||
        this.now() - operation.startedAt >= REFINEMENT_LIMITS.deadlineMs)
    ) {
      outcome = this.fallback(operation, "deadline");
    }
    // This is the final synchronous publication fence, including the fallback path.
    if (outcome.text !== undefined) {
      if (!this.current(request)) {
        outcome = { status: "cancelled", warnings: ["superseded"] };
      } else if (
        !this.authorized(request, outcome.status === "raw-fallback" ? "fallback" : "publication")
      ) {
        outcome = { status: "unavailable", warnings: ["authorization-changed"] };
      }
    }
    operation.finished = true;
    const elapsedMs = Math.max(0, this.now() - operation.startedAt);
    const result: RefinementResult = freezeRefinementValue({
      schemaVersion: 1,
      captureId: request.captureId,
      generation: request.generation,
      transcriptRevision: request.transcriptRevision,
      ...outcome,
      warnings: [...new Set(outcome.warnings)],
      metrics: {
        elapsedMs,
        inputBytes: operation.inputBytes,
        outputBytes: refinementByteLength(outcome.candidateText ?? outcome.text ?? ""),
        providerRequests: operation.providerRequests,
        phases: operation.phases.map((entry) => ({ ...entry })),
      },
    });
    try {
      this.options.onMetric?.({
        phase: "terminal",
        durationMs: elapsedMs,
        sizeBucket:
          operation.inputBytes === 0
            ? "empty"
            : operation.inputBytes <= 1024
              ? "small"
              : operation.inputBytes <= 8192
                ? "medium"
                : "large",
        status: result.status,
        providerRequests: operation.providerRequests,
      });
    } catch {
      // Optional content-free diagnostics cannot change draft publication.
    }
    return result;
  }
}

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  getConfiguredDecisionProviderIds,
  resolveDecisionModelSetting,
} from "../agents/decision-model-setting.js";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginProviderRegistration } from "../plugins/provider-plugin.types.js";
import type { PluginRecord, PluginRegistry } from "../plugins/registry-types.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  decisionResultV1ToV2,
  decisionResultV2ToV1,
} from "./compatibility.js";
import { DecisionContractError } from "./contract-error.js";
import {
  decisionDebugEnabled,
  logDecisionEvaluation,
  type DecisionEvaluationFacts,
} from "./diagnostics.js";
import type { DecisionEvaluateOptionsV2 } from "./execution-types.js";
import type { PreparedDecisionBillingFacts } from "./host-billing.js";
import type { DecisionOutcome, DecisionOutcomeV2, UnavailableReason } from "./host-outcomes.js";
import type { ProviderFailureReason } from "./provider-outcomes.js";
import type { DecisionProviderV2, DecisionProviderV1 } from "./provider-types.js";
import type { DecisionBatchV2 } from "./types-v2.js";
import type { DecisionBatch } from "./types.js";
import { validateDecisionResult } from "./validation.js";

type Options = DecisionEvaluateOptionsV2;
type Batch = DecisionBatch | DecisionBatchV2;
type Outcome = DecisionOutcome | DecisionOutcomeV2;
const FAILURE_REASONS = new Set<ProviderFailureReason>([
  "credentials-unavailable",
  "authentication",
  "rate-limited",
  "transport",
  "unsupported-input",
  "invalid-response",
]);
const MAX_CONCURRENT = 4;
const COOLDOWN_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;

class DecisionConsumerClosedError extends Error {
  constructor() {
    super("Decision consumer authority closed.");
  }
}

type Health = {
  id: string;
  secretRevision: number;
  config: PluginEntryConfig | undefined;
  failures: number;
  openUntil: number;
  trial: boolean;
  lastSuccessAt?: number;
};

/** Provider-owned admission and health. */
export class DecisionProviderHost {
  private retired = false;
  private reloadPause?: object;
  private health?: Health;
  private readonly pending = new Map<
    AbortController,
    { consumerId?: string; done: Promise<void> }
  >();
  private readonly reasons: Partial<Record<UnavailableReason, number>> = {};
  private successCount = 0;
  private totalLatencyMs = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    readonly provider: DecisionProviderV1 | DecisionProviderV2,
    readonly record: PluginRecord,
    private readonly registration?: PluginProviderRegistration,
  ) {}

  private generation(config: OpenClawConfig): Health {
    const secretRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const providerConfig = config.plugins?.entries?.[this.record.id];
    if (
      !this.health ||
      this.health.secretRevision !== secretRevision ||
      !isDeepStrictEqual(this.health.config, providerConfig)
    ) {
      this.health = {
        id: randomUUID(),
        secretRevision,
        config: providerConfig,
        failures: 0,
        openUntil: 0,
        trial: false,
      };
    }
    return this.health;
  }

  unavailable(reason: UnavailableReason): DecisionOutcome {
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    return { status: "unavailable", reason };
  }

  /** Close only capability admission before reversible native reload preparation. */
  pauseForReload(changedConsumerIds: ReadonlySet<string> = new Set()) {
    const token = {};
    this.reloadPause = token;
    for (const [controller, request] of this.pending) {
      // Close admission before abort callbacks can reenter. A retiring consumer
      // must reject rather than receive the provider-only fallback classification.
      controller.abort(
        request.consumerId !== undefined && changedConsumerIds.has(request.consumerId)
          ? new DecisionConsumerClosedError()
          : "decision-provider-retired",
      );
    }
    const assertResumable = () => {
      const instance = getPluginInstance(this.record);
      if (
        this.reloadPause !== token ||
        this.retired ||
        this.pending.size > 0 ||
        !instance?.acceptingCalls ||
        instance.owner?.revoked ||
        instance.lifecycle.signal.aborted
      ) {
        throw new Error("Decision reload admission cannot safely resume.");
      }
    };
    return {
      settled: Promise.all([...this.pending.values()].map((request) => request.done)),
      assertResumable,
      resume: () => {
        assertResumable();
        // Preserve circuit policy, but never reuse the canceled request generation.
        if (this.health) {
          this.health = { ...this.health, id: randomUUID(), trial: false };
        }
        this.reloadPause = undefined;
      },
    };
  }

  /** Native service stop/disposal is irreversible; rollback must not reopen it. */
  retire(): void {
    this.retired = true;
    for (const controller of this.pending.keys()) {
      controller.abort("decision-provider-retired");
    }
  }

  cancelConsumer(pluginId: string): void {
    for (const [controller, request] of this.pending) {
      if (request.consumerId === pluginId) {
        controller.abort(new DecisionConsumerClosedError());
      }
    }
  }

  async stop(): Promise<void> {
    this.retire();
    await Promise.all([...this.pending.values()].map((request) => request.done));
  }

  private ready(): boolean | undefined {
    if (this.provider.contractVersion === 2) {
      // V2 authentication belongs to the selected prepared agent/profile, not a global probe.
      return undefined;
    }
    try {
      // Providers may resolve per-call credentials without prepared local evidence.
      if (this.provider.isReady === undefined) {
        return undefined;
      }
      const available = this.provider.isReady();
      if (typeof available !== "boolean") {
        throw new DecisionContractError();
      }
      return available;
    } catch {
      throw new DecisionContractError();
    }
  }

  inspect(config: OpenClawConfig) {
    const health = this.generation(config);
    const instance = getPluginInstance(this.record);
    const configured = getConfiguredDecisionProviderIds(config).includes(this.provider.id);
    const enabled =
      config.plugins?.enabled !== false &&
      config.plugins?.entries?.[this.record.id]?.enabled !== false;
    const admitted = !this.retired && !this.reloadPause && instance?.acceptingCalls === true;
    const readiness =
      this.provider.contractVersion === 1
        ? admitted && instance.run(() => this.ready())
        : undefined;
    return {
      providerId: this.provider.id,
      pluginId: this.record.id,
      configured,
      ...(this.provider.contractVersion === 1 ? { credentialReady: readiness === true } : {}),
      callable:
        configured &&
        enabled &&
        admitted &&
        readiness !== false &&
        !health.trial &&
        health.openUntil <= performance.now() &&
        this.pending.size < MAX_CONCURRENT,
      runtimeGeneration: health.id,
      recentSuccessAt: health.lastSuccessAt,
      activeRequests: this.pending.size,
      successCount: this.successCount,
      totalLatencyMs: this.totalLatencyMs,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      reasons: { ...this.reasons },
    };
  }

  async evaluate(
    submitted: Batch,
    options: Options,
    model: string,
    config: OpenClawConfig,
    registry: PluginRegistry,
    version: 1 | 2,
    consumerId?: string,
    isAdmissible?: () => boolean,
    onPreparedBilling?: (facts: PreparedDecisionBillingFacts) => void,
  ): Promise<Outcome> {
    const evaluationStarted = performance.now();
    const facts: DecisionEvaluationFacts = { dispatched: false };
    let evaluationOutcome: Outcome | undefined;
    const evaluateRequest = async (): Promise<Outcome> => {
      options.signal.throwIfAborted();
      const instance = getPluginInstance(this.record);
      if (
        this.retired ||
        this.reloadPause ||
        !instance?.acceptingCalls ||
        instance.owner?.revoked
      ) {
        return this.unavailable("retiring");
      }
      if (decisionDebugEnabled()) {
        // The runtime already admitted bounded, accessor-free JSON. Never retain its text.
        facts.questionCount = Object.keys(submitted.questions).length;
        facts.jsonInputBytes = Buffer.byteLength(JSON.stringify(submitted));
      }
      const health = this.generation(config);
      const readConfig = createRuntimeConfigReader(config);
      if (instance.runInRegistry(registry, () => this.ready()) === false) {
        return this.unavailable("credentials-unavailable");
      }
      if (health.openUntil > performance.now() || health.trial) {
        return this.unavailable("circuit-open");
      }
      // Optional work leaves the last physical slot for requested evaluations.
      const limit = options.priority === "optional" ? MAX_CONCURRENT - 1 : MAX_CONCURRENT;
      if (this.pending.size >= limit) {
        return this.unavailable("overloaded");
      }
      const halfOpen = health.openUntil > 0;
      if (halfOpen) {
        health.trial = true;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const started = performance.now();
      const budget = Math.min(options.timeoutMs, 30_000);
      const deadlineMonotonicMs = started + budget;
      const timer = setTimeout(() => controller.abort("decision-deadline"), budget);
      const { promise: done, resolve: settle } = createDeferredCore();
      this.pending.set(controller, { consumerId, done });
      let observedInterruption: Outcome | undefined;
      let admissionError: { error: unknown } | undefined;
      const interrupted = (): Outcome | undefined => {
        options.signal.throwIfAborted();
        if (controller.signal.reason instanceof DecisionConsumerClosedError) {
          throw controller.signal.reason;
        }
        if (admissionError) {
          throw admissionError.error;
        }
        if (
          this.retired ||
          instance.owner?.revoked ||
          controller.signal.reason === "decision-provider-retired"
        ) {
          return this.unavailable("retiring");
        }
        if (
          controller.signal.reason === "decision-deadline" ||
          performance.now() >= deadlineMonotonicMs
        ) {
          // The host deadline bounds this request; it is not a provider-reported outage.
          // Genuine transport and rate-limit failures are accounted below.
          return this.unavailable("deadline");
        }
        if (observedInterruption) {
          return observedInterruption;
        }
        try {
          if (isAdmissible && !isAdmissible()) {
            return this.unavailable("disabled");
          }
        } catch (error) {
          // Adapters may sanitize this error and yield during cleanup. Preserve
          // the caller-owned terminal assertion rather than treating it as health.
          admissionError = { error };
          throw error;
        }
        const currentConfig = readConfig();
        const selection = resolveDecisionModelSetting(currentConfig, options.agentId);
        if (
          getActiveSecretsRuntimeSnapshotRevisionState() !== health.secretRevision ||
          this.health !== health ||
          currentConfig.plugins?.enabled === false ||
          !isDeepStrictEqual(currentConfig.plugins?.entries?.[this.record.id], health.config) ||
          selection?.provider !== this.provider.id ||
          selection.model !== model
        ) {
          return this.unavailable("retiring");
        }
        return undefined;
      };
      try {
        // Await physical settlement. A callback that ignores abort keeps its native lease
        // and is fenced by normal failed-drain recovery, never detached as "disposed".
        let outcome;
        const provider = this.provider;
        const v1Batch =
          version === 1
            ? (submitted as DecisionBatch) // SAFETY: The V1 entry point supplies a V1 batch for version 1.
            : provider.contractVersion === 1
              ? decisionBatchV2ToV1(
                  submitted as DecisionBatchV2, // SAFETY: The V2 entry point supplies a V2 batch for version 2.
                )
              : undefined;
        const v2Batch =
          version === 2
            ? (submitted as DecisionBatchV2) // SAFETY: The V2 entry point supplies a V2 batch for version 2.
            : provider.contractVersion === 2
              ? decisionBatchV1ToV2(
                  submitted as DecisionBatch, // SAFETY: The V1 entry point supplies a V1 batch for version 1.
                )
              : undefined;
        if (
          (provider.contractVersion === 1 &&
            (!v1Batch || (options.reasoning !== undefined && options.reasoning !== "auto"))) ||
          (provider.contractVersion === 2 && !v2Batch)
        ) {
          return this.unavailable("unsupported-input");
        }
        // V1 validation and cross-version conversion need the executor's original questions.
        // Same-version V2 validation retains its snapshot in executePreparedDecision.
        const offeredV1 =
          provider.contractVersion === 1 && v1Batch ? structuredClone(v1Batch) : undefined;
        const offeredV2 = version === 1 && v2Batch ? structuredClone(v2Batch) : undefined;
        const admissible = () => {
          observedInterruption ??= interrupted();
          return observedInterruption === undefined;
        };
        try {
          outcome = await instance.runInRegistry(
            registry,
            async () => {
              facts.dispatched = true;
              if (provider.contractVersion === 1) {
                return provider.evaluate(v1Batch!, {
                  model,
                  ...(options.agentId ? { agentId: options.agentId } : {}),
                  signal,
                  deadlineMonotonicMs,
                  // Explicit callers may have no predicate; transports must still fence
                  // host secret/config generations after asynchronous preparation.
                  isAdmissible: admissible,
                });
              }
              if (!this.registration) {
                throw new DecisionContractError();
              }
              const { executePreparedDecision } = await import("../agents/decision-inference.js");
              if (!admissible()) {
                return { status: "unavailable" as const, reason: "unsupported-input" as const };
              }
              return executePreparedDecision({
                provider,
                registration: this.registration,
                batch: v2Batch!,
                modelId: model,
                config,
                options,
                signal,
                deadlineMonotonicMs,
                isAdmissible: admissible,
                onPreparedBilling,
              });
            },
            // The provider callback's physical settlement is already tracked by
            // `done`. Do not make its lease await instance disposal: disposal
            // invokes host.stop(), which itself waits for `done`.
            { joinDisposal: false },
          );
        } catch {
          const stopped = interrupted();
          if (stopped) {
            return stopped;
          }
          throw new DecisionContractError();
        }
        const stopped = interrupted();
        if (stopped) {
          return stopped;
        }
        if (outcome?.status === "ok") {
          // The prepared V2 adapter already validates against route capabilities.
          const nativeResult = outcome.result;
          if (
            provider.contractVersion === 1 &&
            (!offeredV1 || !validateDecisionResult(offeredV1, nativeResult))
          ) {
            this.fail(health, "invalid-response");
            return this.unavailable("invalid-response");
          }
          const result =
            version === provider.contractVersion
              ? nativeResult
              : version === 1
                ? decisionResultV2ToV1(
                    offeredV2!,
                    nativeResult as import("./types-v2.js").DecisionBatchResultV2, // SAFETY: The provider V2 branch validated this native result against offeredV2.
                  )
                : decisionResultV1ToV2(
                    offeredV1!,
                    nativeResult as import("./types.js").DecisionBatchResult, // SAFETY: The provider V1 branch validated this native result against offeredV1.
                  );
          // V1 narrowing must be lossless: explicit abstention or provider units cannot be fabricated away.
          if (!result) {
            return this.unavailable("unsupported-input");
          }
          health.failures = 0;
          health.openUntil = 0;
          health.lastSuccessAt = Date.now();
          this.successCount++;
          this.inputTokens += result.usage?.inputTokens ?? 0;
          this.outputTokens += result.usage?.outputTokens ?? 0;
          return {
            status: "ok",
            result: structuredClone(result),
            provenance: {
              providerId: this.provider.id,
              rubricVersion: options.rubricVersion,
              runtimeGeneration: health.id,
            },
          };
        }
        if (outcome?.status !== "unavailable") {
          throw new DecisionContractError();
        }
        // Validate and publish the same primitives even if a provider envelope is executable.
        const { reason, retryAfterMs } = outcome;
        if (!FAILURE_REASONS.has(reason)) {
          throw new DecisionContractError();
        }
        this.fail(health, reason, retryAfterMs);
        return this.unavailable(reason);
      } catch (error) {
        options.signal.throwIfAborted();
        if (controller.signal.reason instanceof DecisionConsumerClosedError) {
          throw controller.signal.reason;
        }
        if (admissionError) {
          throw admissionError.error;
        }
        if (error instanceof DecisionContractError) {
          throw error;
        }
        // A malformed provider envelope must not leak getter/implementation diagnostics.
        throw new DecisionContractError();
      } finally {
        clearTimeout(timer);
        this.pending.delete(controller);
        if (halfOpen) {
          health.trial = false;
        }
        this.totalLatencyMs += performance.now() - started;
        settle();
      }
    };
    try {
      evaluationOutcome = await evaluateRequest();
      return evaluationOutcome;
    } finally {
      logDecisionEvaluation({
        options,
        providerId: this.provider.id,
        model,
        facts,
        started: evaluationStarted,
        outcome: evaluationOutcome,
      });
    }
  }

  private fail(health: Health, reason: ProviderFailureReason, retryAfterMs?: number): void {
    // The provider resolves credentials per evaluation. Rejecting one credential
    // must not block other agents or a replacement credential at this shared host.
    if (
      reason === "authentication" ||
      reason === "unsupported-input" ||
      reason === "credentials-unavailable"
    ) {
      return;
    }
    health.failures++;
    const retryAfter =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
        ? Math.max(0, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS))
        : 0;
    if (health.failures >= 3 || retryAfter > 0) {
      health.openUntil = performance.now() + Math.max(COOLDOWN_MS, retryAfter);
    }
  }
}

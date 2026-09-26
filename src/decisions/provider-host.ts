import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
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
import { decisionBatchV2ToV1, decisionResultV1ToV2 } from "./compatibility.js";
import type {
  DecisionProviderV2,
  DecisionBatchV2,
  DecisionEvaluateOptionsV2,
  DecisionOutcomeV2,
  ProviderDecisionOutcomeV2,
} from "./types-v2.js";
import type {
  DecisionOutcome,
  DecisionProviderV1,
  ProviderFailureReason,
  UnavailableReason,
} from "./types.js";
import { validateDecisionResultV2 } from "./validation-v2.js";
import { DecisionContractError } from "./validation.js";

type Options = DecisionEvaluateOptionsV2;
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
  authFailed: boolean;
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
    readonly registration?: PluginProviderRegistration,
    private readonly readCredentialEligibility?: (config: OpenClawConfig) => boolean,
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
        authFailed: false,
        trial: false,
      };
    }
    return this.health;
  }

  unavailable(
    reason: UnavailableReason,
    recordOutcome = true,
  ): Extract<DecisionOutcome, { status: "unavailable" }> {
    if (recordOutcome) {
      this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    }
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

  private ready(config: OpenClawConfig): boolean {
    if (this.provider.contractVersion === 2) {
      try {
        return this.readCredentialEligibility?.(config) ?? false;
      } catch {
        return false;
      }
    }
    try {
      const available = this.provider.isReady?.() ?? true;
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
    const credentialReady = enabled && admitted && instance.run(() => this.ready(config));
    return {
      providerId: this.provider.id,
      pluginId: this.record.id,
      configured,
      credentialReady,
      callable:
        configured &&
        enabled &&
        credentialReady &&
        !health.authFailed &&
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

  async evaluateV2(
    batch: DecisionBatchV2,
    options: Options,
    model: string,
    config: OpenClawConfig,
    registry: PluginRegistry,
    consumerId?: string,
    authoredSelection: NonNullable<ReturnType<typeof resolveDecisionModelSetting>> = {
      provider: this.provider.id,
      model,
    },
    onPreparedBilling?: (billing: ModelDecisionCapabilities["billing"]) => void,
  ): Promise<DecisionOutcomeV2> {
    options.signal.throwIfAborted();
    // V1 providers cannot honor new modalities or reasoning controls. Reject before dispatch.
    if (
      this.provider.contractVersion === 1 &&
      (options.reasoning !== undefined ||
        authoredSelection.profileId !== undefined ||
        !decisionBatchV2ToV1(batch))
    ) {
      return this.unavailable("unsupported-input");
    }
    let submitted: DecisionBatchV2;
    try {
      submitted = structuredClone(batch);
    } catch {
      throw new DecisionContractError();
    }
    const instance = getPluginInstance(this.record);
    if (this.retired || this.reloadPause || !instance?.acceptingCalls || instance.owner?.revoked) {
      return this.unavailable("retiring");
    }
    const health = this.generation(config);
    const readConfig = createRuntimeConfigReader(config);
    if (
      this.provider.contractVersion === 1 &&
      !instance.runInRegistry(registry, () => this.ready(config))
    ) {
      return this.unavailable("credentials-unavailable");
    }
    if (health.authFailed || health.openUntil > performance.now() || health.trial) {
      return this.unavailable("circuit-open");
    }
    if (this.pending.size >= MAX_CONCURRENT) {
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
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.pending.set(controller, { consumerId, done });
    const interrupted = (recordOutcome = true): DecisionOutcome | undefined => {
      options.signal.throwIfAborted();
      if (controller.signal.reason instanceof DecisionConsumerClosedError) {
        throw controller.signal.reason;
      }
      if (
        this.retired ||
        instance.owner?.revoked ||
        controller.signal.reason === "decision-provider-retired"
      ) {
        return this.unavailable("retiring", recordOutcome);
      }
      if (
        controller.signal.reason === "decision-deadline" ||
        performance.now() >= deadlineMonotonicMs
      ) {
        return this.unavailable("deadline", recordOutcome);
      }
      const currentConfig = readConfig();
      const selection = resolveDecisionModelSetting(currentConfig, options.agentId);
      if (
        getActiveSecretsRuntimeSnapshotRevisionState() !== health.secretRevision ||
        this.health !== health ||
        currentConfig.plugins?.enabled === false ||
        !isDeepStrictEqual(currentConfig.plugins?.entries?.[this.record.id], health.config) ||
        selection?.provider !== authoredSelection.provider ||
        selection.model !== authoredSelection.model ||
        selection.profileId !== authoredSelection.profileId
      ) {
        return this.unavailable("retiring", recordOutcome);
      }
      return undefined;
    };
    let releaseInvocation: (() => void) | undefined;
    try {
      // The host already joins this operation in stop(). A retained invocation keeps
      // physical custody without making its result await that same disposal.
      const invocation = instance.retainConsumer(undefined, registry);
      releaseInvocation = () => invocation.release();
      // Await physical settlement. A callback that ignores abort keeps its native lease
      // and is fenced by normal failed-drain recovery, never detached as "disposed".
      let outcome: ProviderDecisionOutcomeV2;
      let offered: DecisionBatchV2;
      try {
        // Preserve the offered questions even when the provider mutates its input.
        offered = structuredClone(submitted);
        const provider = this.provider;
        if (provider.contractVersion === 2) {
          const registration = this.registration;
          if (
            !registration ||
            registry.providers.every(
              (entry) =>
                entry.provider.id !== registration.provider.id ||
                entry.pluginId !== registration.pluginId,
            )
          ) {
            throw new DecisionContractError();
          }
          const { executePreparedDecision } = await import("../agents/decision-inference.js");
          outcome = await invocation.run(() =>
            executePreparedDecision({
              provider,
              registration,
              batch: submitted,
              modelId: model,
              profileId: authoredSelection.profileId,
              config,
              options,
              signal,
              onPreparedBilling,
              deadlineMonotonicMs,
              assertCurrent: () => {
                if (!instance.acceptingCalls || instance.owner?.revoked || interrupted(false)) {
                  throw new Error("Decision provider authority is no longer current.");
                }
              },
            }),
          );
        } else {
          const legacy = decisionBatchV2ToV1(submitted);
          if (!legacy) {
            return this.unavailable("unsupported-input");
          }
          const legacyOutcome = await invocation.run(() =>
            provider.evaluate(legacy, {
              model,
              ...(options.agentId ? { agentId: options.agentId } : {}),
              signal,
              deadlineMonotonicMs,
            }),
          );
          if (legacyOutcome?.status === "ok") {
            const offeredLegacy = decisionBatchV2ToV1(offered);
            const result =
              offeredLegacy && decisionResultV1ToV2(offeredLegacy, legacyOutcome.result);
            outcome = result
              ? { status: "ok", result }
              : { status: "unavailable", reason: "invalid-response" };
          } else {
            outcome = legacyOutcome;
          }
        }
      } catch {
        const stopped = interrupted();
        if (stopped) {
          if (stopped.status === "unavailable" && stopped.reason === "deadline") {
            this.fail(health, "transport");
          }
          return stopped;
        }
        throw new DecisionContractError();
      }
      const stopped = interrupted();
      if (stopped) {
        if (stopped.status === "unavailable" && stopped.reason === "deadline") {
          this.fail(health, "transport");
        }
        return stopped;
      }
      if (outcome?.status === "ok") {
        const result = outcome.result;
        if (!validateDecisionResultV2(offered, result)) {
          this.fail(health, "invalid-response");
          return this.unavailable("invalid-response");
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
      if (error instanceof DecisionContractError) {
        throw error;
      }
      // A malformed provider envelope must not leak getter/implementation diagnostics.
      throw new DecisionContractError();
    } finally {
      releaseInvocation?.();
      clearTimeout(timer);
      this.pending.delete(controller);
      if (halfOpen) {
        health.trial = false;
      }
      this.totalLatencyMs += performance.now() - started;
      settle();
    }
  }

  private fail(health: Health, reason: ProviderFailureReason, retryAfterMs?: number): void {
    if (
      this.health !== health ||
      getActiveSecretsRuntimeSnapshotRevisionState() !== health.secretRevision ||
      this.retired ||
      this.reloadPause
    ) {
      return;
    }
    if (reason === "authentication") {
      // V2 account/credential state belongs to normal model auth, not a provider-wide latch.
      if (this.provider.contractVersion === 1) {
        health.authFailed = true;
      }
      return;
    }
    if (reason === "unsupported-input" || reason === "credentials-unavailable") {
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

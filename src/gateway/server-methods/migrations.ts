// Gateway handlers expose reviewed, memory-only migration plans to trusted operators.
import crypto from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import {
  ErrorCodes,
  errorShape,
  type MemoryMigrationItem,
  type MemoryMigrationProviderPlan,
  type MigrationsMemoryApplyResult,
  type MigrationsMemoryPlanResult,
  validateMigrationsMemoryApplyParams,
  validateMigrationsMemoryPlanParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  applyProviderMemoryImport,
  withMemoryMigrationProviders,
  planProviderMemoryImport,
} from "../../commands/migrate/memory-import.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import { summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationItem, MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MEMORY_APPLY_DEDUPE_PREFIX = "migrations.memory.apply:";
const activeApplies = new Set<string>();

function emptySummary() {
  return summarizeMigrationItems([]);
}

type CachedMemoryApply = {
  requestFingerprint: string;
  outcome: MemoryApplyOutcome;
};

type MemoryApplyOutcome =
  | { ok: true; resultJson: string }
  | { ok: false; error: ReturnType<typeof errorShape> };

type InFlightMemoryApply = {
  requestFingerprint: string;
  completion: Promise<MemoryApplyOutcome>;
};

const inFlightMemoryApplies = new WeakMap<object, Map<string, InFlightMemoryApply>>();

function memoryApplyInflightMap(dedupe: object): Map<string, InFlightMemoryApply> {
  let active = inFlightMemoryApplies.get(dedupe);
  if (!active) {
    active = new Map();
    inFlightMemoryApplies.set(dedupe, active);
  }
  return active;
}

function memoryApplyRequestFingerprint(params: {
  agentId: string;
  providerId: string;
  planFingerprint: string;
  itemIds: string[];
  overwrite?: boolean;
}): string {
  return stableStringify({
    agentId: params.agentId,
    providerId: params.providerId,
    planFingerprint: params.planFingerprint,
    itemIds: params.itemIds,
    overwrite: params.overwrite === true,
  });
}

function isCachedMemoryApply(value: unknown): value is CachedMemoryApply {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CachedMemoryApply>;
  return typeof candidate.requestFingerprint === "string" && candidate.outcome !== undefined;
}

function respondMemoryApply(outcome: MemoryApplyOutcome, respond: RespondFn, cached = false): void {
  const meta = cached ? { cached: true } : undefined;
  if (outcome.ok) {
    respond(true, JSON.parse(outcome.resultJson), undefined, meta);
  } else {
    respond(false, undefined, outcome.error, meta);
  }
}

function toWireItem(item: MigrationItem): MemoryMigrationItem {
  return {
    id: item.id,
    status: item.status,
    ...(item.source ? { source: item.source } : {}),
    ...(item.target ? { target: item.target } : {}),
    ...(item.message !== undefined ? { message: item.message } : {}),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    ...(item.details !== undefined ? { details: item.details } : {}),
  };
}

function fingerprintMemoryPlan(params: {
  agentId: string;
  workspace: string;
  providerId: string;
  overwrite?: boolean;
  plan: MigrationPlan;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        version: 3,
        agentId: params.agentId,
        workspace: params.workspace,
        providerId: params.providerId,
        overwrite: params.overwrite === true,
        // Apply receives the full plan, so every provider-visible field must bind to the review.
        plan: params.plan,
      }),
    )
    .digest("hex");
}

function targetAgentOrRespond(
  rawAgentId: string,
  config: OpenClawConfig,
  respond: RespondFn,
): string | undefined {
  if (!isValidAgentId(rawAgentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid agent id"));
    return undefined;
  }
  const agentId = normalizeAgentId(rawAgentId);
  if (!new Set(listAgentIds(config)).has(agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return undefined;
  }
  return agentId;
}

async function planMemoryProvider(params: {
  provider: MigrationProviderPlugin;
  config: OpenClawConfig;
  agentId: string;
  overwrite?: boolean;
}): Promise<MemoryMigrationProviderPlan> {
  const base = {
    providerId: params.provider.id,
    label: params.provider.label,
    ...(params.provider.description ? { description: params.provider.description } : {}),
  };
  try {
    const { detection, plan } = await planProviderMemoryImport({
      provider: params.provider,
      config: params.config,
      agentId: params.agentId,
      overwrite: params.overwrite,
    });
    if (detection && !detection.found) {
      return {
        ...base,
        found: false,
        ...(detection.source ? { source: detection.source } : {}),
        ...(detection.confidence ? { confidence: detection.confidence } : {}),
        ...(detection.message ? { message: detection.message } : {}),
        summary: emptySummary(),
        items: [],
      };
    }
    const found = plan.items.length > 0;
    const workspace = resolveAgentWorkspaceDir(params.config, params.agentId);
    return {
      ...base,
      found,
      planFingerprint: fingerprintMemoryPlan({
        agentId: params.agentId,
        workspace,
        providerId: params.provider.id,
        overwrite: params.overwrite,
        plan,
      }),
      source: plan.source,
      ...(plan.target ? { target: plan.target } : {}),
      ...(detection?.confidence ? { confidence: detection.confidence } : {}),
      ...(detection?.message ? { message: detection.message } : {}),
      summary: plan.summary,
      items: plan.items.map(toWireItem),
      ...(plan.warnings?.length ? { warnings: plan.warnings } : {}),
    };
  } catch (error) {
    return {
      ...base,
      found: false,
      error: errorMessage(error),
      summary: emptySummary(),
      items: [],
    };
  }
}

function findMemoryProvider(
  providers: readonly MigrationProviderPlugin[],
  providerId: string,
): MigrationProviderPlugin | undefined {
  return providers.find((provider) => provider.id === providerId);
}

export const migrationsHandlers: GatewayRequestHandlers = {
  "migrations.memory.plan": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateMigrationsMemoryPlanParams,
        "migrations.memory.plan",
        respond,
      )
    ) {
      return;
    }
    const config = context.getRuntimeConfig();
    const agentId = targetAgentOrRespond(params.agentId, config, respond);
    if (!agentId) {
      return;
    }
    const resultJson = await withMemoryMigrationProviders(config, async (providers) => {
      const planning = providers.map(
        async (provider) =>
          await planMemoryProvider({
            provider,
            config,
            agentId,
            overwrite: params.overwrite,
          }),
      );
      let planned: MemoryMigrationProviderPlan[];
      try {
        planned = await Promise.all(planning);
      } catch (error) {
        // Preserve the first whole-request rejection, but keep resources until every issued plan settles.
        await Promise.allSettled(planning);
        throw error;
      }
      const result: MigrationsMemoryPlanResult = {
        agentId,
        workspace: resolveAgentWorkspaceDir(config, agentId),
        providers: planned,
      };
      return JSON.stringify(result);
    });
    respond(true, JSON.parse(resultJson), undefined);
  },

  "migrations.memory.apply": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateMigrationsMemoryApplyParams,
        "migrations.memory.apply",
        respond,
      )
    ) {
      return;
    }
    const config = context.getRuntimeConfig();
    const agentId = targetAgentOrRespond(params.agentId, config, respond);
    if (!agentId) {
      return;
    }
    const requestFingerprint = memoryApplyRequestFingerprint({
      agentId,
      providerId: params.providerId,
      planFingerprint: params.planFingerprint,
      itemIds: params.itemIds,
      overwrite: params.overwrite,
    });
    const dedupeKey = `${MEMORY_APPLY_DEDUPE_PREFIX}${params.idempotencyKey}`;
    const cached = context.dedupe.get(dedupeKey);
    if (cached && isCachedMemoryApply(cached.payload)) {
      if (cached.payload.requestFingerprint !== requestFingerprint) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "memory import idempotency key was reused"),
        );
        return;
      }
      respondMemoryApply(cached.payload.outcome, respond, true);
      return;
    }
    const inFlightMap = memoryApplyInflightMap(context.dedupe);
    const inFlight = inFlightMap.get(dedupeKey);
    if (inFlight) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "memory import idempotency key was reused"),
        );
        return;
      }
      respondMemoryApply(await inFlight.completion, respond, true);
      return;
    }
    let settle!: (outcome: MemoryApplyOutcome) => void;
    const completion = new Promise<MemoryApplyOutcome>((resolve) => {
      settle = resolve;
    });
    // Reserve before acquisition. Once apply completes, even an unreadable result is terminal.
    inFlightMap.set(dedupeKey, { requestFingerprint, completion });
    let applyCompleted = false;
    let producedOutcome: MemoryApplyOutcome | undefined;
    let outcome: MemoryApplyOutcome;
    const runApply = async (providers: MigrationProviderPlugin[]): Promise<MemoryApplyOutcome> => {
      const provider = findMemoryProvider(providers, params.providerId);
      if (!provider) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, "unknown memory migration provider"),
        };
      }
      const applyKey = `${agentId}:${provider.id}`;
      if (activeApplies.has(applyKey)) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "memory import already running", {
            retryable: true,
            retryAfterMs: 1000,
          }),
        };
      }
      activeApplies.add(applyKey);
      try {
        const { plan } = await planProviderMemoryImport({
          provider,
          config,
          agentId,
          overwrite: params.overwrite,
        });
        const currentFingerprint = fingerprintMemoryPlan({
          agentId,
          workspace: resolveAgentWorkspaceDir(config, agentId),
          providerId: provider.id,
          overwrite: params.overwrite,
          plan,
        });
        if (currentFingerprint !== params.planFingerprint) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "memory migration plan changed; refresh the plan before importing",
            ),
          };
        }
        const selectable = new Map(
          plan.items
            .filter((item) => item.status === "planned" || item.status === "conflict")
            .map((item) => [item.id, item]),
        );
        const unavailable = params.itemIds.filter((id) => !selectable.has(id));
        if (unavailable.length > 0) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `memory migration items changed; refresh the plan (${unavailable.join(", ")})`,
            ),
          };
        }
        const selectedConflicts = params.itemIds.filter(
          (id) => selectable.get(id)?.status === "conflict",
        );
        if (!params.overwrite && selectedConflicts.length > 0) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "selected memory was already imported; enable replacement and refresh the plan",
            ),
          };
        }
        const applied = await applyProviderMemoryImport({
          provider,
          config,
          agentId,
          itemIds: params.itemIds,
          overwrite: params.overwrite,
          preflightPlan: plan,
          onApplyCompleted: () => {
            applyCompleted = true;
          },
        });
        const result: MigrationsMemoryApplyResult = {
          providerId: applied.providerId,
          source: applied.source,
          ...(applied.target ? { target: applied.target } : {}),
          summary: applied.summary,
          items: applied.items.map(toWireItem),
          ...(applied.warnings?.length ? { warnings: applied.warnings } : {}),
          ...(applied.backupPath ? { backupPath: applied.backupPath } : {}),
          ...(applied.reportDir ? { reportDir: applied.reportDir } : {}),
        };
        // Only the projected JSON transport result crosses the registration lifetime.
        return { ok: true, resultJson: JSON.stringify(result) };
      } finally {
        activeApplies.delete(applyKey);
      }
    };
    try {
      outcome = await withMemoryMigrationProviders(config, async (providers) => {
        try {
          producedOutcome = await runApply(providers);
        } catch (error) {
          producedOutcome = {
            ok: false,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              applyCompleted
                ? `Memory import apply completed, but its result could not be returned: ${errorMessage(error)}. Inspect the migration report before starting another import.`
                : errorMessage(error),
            ),
          };
        }
        if (applyCompleted) {
          context.dedupe.set(dedupeKey, {
            ts: Date.now(),
            ok: producedOutcome.ok,
            payload: { requestFingerprint, outcome: producedOutcome } satisfies CachedMemoryApply,
          });
        }
        return producedOutcome;
      });
    } catch (error) {
      if (producedOutcome) {
        context.logGateway.warn(`Memory migration plugin cleanup failed: ${errorMessage(error)}`);
        outcome = producedOutcome;
      } else {
        outcome = { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, errorMessage(error)) };
      }
    } finally {
      inFlightMap.delete(dedupeKey);
    }
    settle(outcome);
    respondMemoryApply(outcome, respond);
  },
};

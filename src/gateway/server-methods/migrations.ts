// Gateway handlers expose reviewed, memory-only migration plans to trusted operators.
import crypto from "node:crypto";
import {
  ErrorCodes,
  MAX_MEMORY_MIGRATION_ITEMS,
  errorShape,
  type MemoryMigrationItem,
  type MemoryMigrationProviderPlan,
  type MigrationsMemoryApplyResult,
  type MigrationsMemoryPlanResult,
  validateMigrationsMemoryApplyParams,
  validateMigrationsMemoryPlanParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { runMigrationApply } from "../../commands/migrate/apply.js";
import { buildMigrationContext } from "../../commands/migrate/context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import {
  ensureStandaloneMigrationProviderRegistryLoaded,
  resolvePluginMigrationProviders,
} from "../../plugins/migration-provider-runtime.js";
import type { MigrationItem, MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MEMORY_ITEM_KIND = "memory";
const activeApplies = new Set<string>();
const silentRuntime: RuntimeEnv = {
  log() {},
  error() {},
  exit(code) {
    throw new Error(`migration exited with ${code}`);
  },
};

function emptySummary() {
  return summarizeMigrationItems([]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function memoryProviders(config: OpenClawConfig) {
  ensureStandaloneMigrationProviderRegistryLoaded({ cfg: config });
  return resolvePluginMigrationProviders({ cfg: config }).filter((provider) =>
    provider.supportedItemKinds?.includes(MEMORY_ITEM_KIND),
  );
}

function memoryOnlyPlan(plan: MigrationPlan): MigrationPlan {
  const items = plan.items.filter((item) => item.kind === MEMORY_ITEM_KIND);
  if (items.length > MAX_MEMORY_MIGRATION_ITEMS) {
    throw new Error(
      `memory import found ${items.length} items; the maximum is ${MAX_MEMORY_MIGRATION_ITEMS}. Narrow or split the source memory before importing.`,
    );
  }
  return { ...plan, items, summary: summarizeMigrationItems(items) };
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
      JSON.stringify({
        version: 1,
        agentId: params.agentId,
        workspace: params.workspace,
        providerId: params.providerId,
        overwrite: params.overwrite === true,
        source: params.plan.source,
        target: params.plan.target ?? null,
        items: params.plan.items.map((item) => ({
          id: item.id,
          status: item.status,
          source: item.source ?? null,
          target: item.target ?? null,
          reason: item.reason ?? null,
        })),
      }),
    )
    .digest("hex");
}

function targetAgentOrRespond(
  rawAgentId: string,
  config: OpenClawConfig,
  respond: RespondFn,
): string | undefined {
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
    const ctx = buildMigrationContext({
      runtime: silentRuntime,
      configOverride: params.config,
      targetAgentId: params.agentId,
      itemKinds: [MEMORY_ITEM_KIND],
      overwrite: params.overwrite,
      json: true,
    });
    const detection = await params.provider.detect?.(ctx);
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
    const plan = memoryOnlyPlan(await params.provider.plan(ctx));
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
    const providers = memoryProviders(config);
    const planned = await Promise.all(
      providers.map(
        async (provider) =>
          await planMemoryProvider({
            provider,
            config,
            agentId,
            overwrite: params.overwrite,
          }),
      ),
    );
    const result: MigrationsMemoryPlanResult = {
      agentId,
      workspace: resolveAgentWorkspaceDir(config, agentId),
      providers: planned,
    };
    respond(true, result, undefined);
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
    const provider = findMemoryProvider(memoryProviders(config), params.providerId);
    if (!provider) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "unknown memory migration provider"),
      );
      return;
    }
    const applyKey = `${agentId}:${provider.id}`;
    if (activeApplies.has(applyKey)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "memory import already running", {
          retryable: true,
          retryAfterMs: 1000,
        }),
      );
      return;
    }
    activeApplies.add(applyKey);
    try {
      const ctx = buildMigrationContext({
        runtime: silentRuntime,
        configOverride: config,
        targetAgentId: agentId,
        itemKinds: [MEMORY_ITEM_KIND],
        overwrite: params.overwrite,
        json: true,
      });
      const plan = memoryOnlyPlan(await provider.plan(ctx));
      const currentFingerprint = fingerprintMemoryPlan({
        agentId,
        workspace: resolveAgentWorkspaceDir(config, agentId),
        providerId: provider.id,
        overwrite: params.overwrite,
        plan,
      });
      if (currentFingerprint !== params.planFingerprint) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "memory migration plan changed; refresh the plan before importing",
          ),
        );
        return;
      }
      const selectable = new Map(
        plan.items
          .filter((item) => item.status === "planned" || item.status === "conflict")
          .map((item) => [item.id, item]),
      );
      const unavailable = params.itemIds.filter((id) => !selectable.has(id));
      if (unavailable.length > 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `memory migration items changed; refresh the plan (${unavailable.join(", ")})`,
          ),
        );
        return;
      }
      const selectedConflicts = params.itemIds.filter(
        (id) => selectable.get(id)?.status === "conflict",
      );
      if (!params.overwrite && selectedConflicts.length > 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "selected memory was already imported; enable replacement and refresh the plan",
          ),
        );
        return;
      }
      const applied = await runMigrationApply({
        runtime: silentRuntime,
        providerId: provider.id,
        provider,
        opts: {
          yes: true,
          json: true,
          configOverride: config,
          targetAgentId: agentId,
          itemKinds: [MEMORY_ITEM_KIND],
          itemIds: params.itemIds,
          overwrite: params.overwrite,
          preflightPlan: plan,
          allowPartialResult: true,
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
      respond(true, result, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, errorMessage(error)));
    } finally {
      activeApplies.delete(applyKey);
    }
  },
};

import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ClawGatewayPlanChangedError } from "./gateway-add-apply.js";
import { planClawRemoveForGateway } from "./gateway-lifecycle-plan.js";
import { projectClawRemovePlan } from "./gateway-plan-projection.js";
import { runClawRemoveCli } from "./gateway-remove-cli.js";
import {
  CLAW_REMOVE_PLAN_SCHEMA_VERSION,
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
} from "./lifecycle-remove-contract.js";
import type { ClawMonitorCleanupGateway } from "./monitor-cleanup-contract.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

const log = createSubsystemLogger("claws/gateway-remove");
const REMOVE_AUTHORITY_CHECK_INTERVAL_MS = 50;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const removeActionSchema = z
  .object({
    kind: z.enum([
      "agent",
      "configBinding",
      "agentAllow",
      "workspace",
      "agentState",
      "sessionIndex",
      "sessionTranscripts",
      "scheduledJob",
      "workspaceFile",
      "bootstrap",
      "packageRef",
      "mcpServer",
      "cronJob",
      "installRecord",
    ]),
    id: z.string(),
    action: z.enum(["remove", "delete", "retain", "release", "uninstall", "trash"]),
    target: z.string(),
    blocked: z.boolean(),
    reason: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const removePlanSchema = z
  .object({
    schemaVersion: z.literal(CLAW_REMOVE_PLAN_SCHEMA_VERSION),
    stability: z.literal(CLAW_OUTPUT_STABILITY),
    dryRun: z.literal(true),
    mutationAllowed: z.literal(false),
    planIntegrity: digest,
    target: z.string(),
    agentId: z.string(),
    actions: z.array(removeActionSchema),
    blockers: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  })
  .strict();
const removeResultSchema = z
  .object({
    schemaVersion: z.literal(CLAW_REMOVE_RESULT_SCHEMA_VERSION),
    stability: z.literal(CLAW_OUTPUT_STABILITY),
    dryRun: z.literal(false),
    status: z.enum(["complete", "partial"]),
    agentId: z.string(),
    agentRemoved: z.boolean(),
  })
  .passthrough();

export type GatewayClawRemoveApplyResult = {
  agentId: string;
  status: "complete" | "partial";
  agentRemoved: boolean;
  error?: { code: string; message: string };
};

export async function applyClawRemoveForGateway(input: {
  agentId: string;
  planIntegrity: string;
  getRuntimeConfig: () => OpenClawConfig;
  monitorGateway: ClawMonitorCleanupGateway;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<GatewayClawRemoveApplyResult> {
  input.assertCurrent();
  const preview = await planClawRemoveForGateway({
    agentId: input.agentId,
    config: input.getRuntimeConfig(),
    monitorGateway: input.monitorGateway,
  });
  input.assertCurrent();
  if (
    preview.planIntegrity !== input.planIntegrity ||
    preview.target.agentId !== input.agentId ||
    preview.blockers.length > 0 ||
    preview.actions.some((action) => action.blocked)
  ) {
    throw new ClawGatewayPlanChangedError();
  }

  const dryRun = await runClawRemoveCli({ agentId: input.agentId, signal: input.signal });
  input.assertCurrent();
  const parsed = removePlanSchema.safeParse(dryRun.payload);
  if (!parsed.success) {
    throw new Error("The Claw removal command returned an invalid plan.");
  }
  const canonicalPlan = parsed.data;
  if (
    dryRun.code !== 0 ||
    canonicalPlan.target !== input.agentId ||
    canonicalPlan.agentId !== input.agentId ||
    canonicalPlan.blockers.length > 0 ||
    canonicalPlan.actions.some((action) => action.blocked)
  ) {
    throw new ClawGatewayPlanChangedError();
  }
  const installed =
    preview.target.name && preview.target.currentVersion
      ? { name: preview.target.name, version: preview.target.currentVersion }
      : undefined;
  if (projectClawRemovePlan(canonicalPlan, installed).planIntegrity !== preview.planIntegrity) {
    throw new ClawGatewayPlanChangedError();
  }
  input.assertCurrent();

  try {
    const controller = new AbortController();
    const onRequestAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) {
      onRequestAbort();
    } else {
      input.signal?.addEventListener("abort", onRequestAbort, { once: true });
    }
    const checkAuthority = () => {
      if (controller.signal.aborted) {
        return;
      }
      try {
        input.assertCurrent();
      } catch (error) {
        controller.abort(error);
      }
    };
    const authorityWatcher = setInterval(checkAuthority, REMOVE_AUTHORITY_CHECK_INTERVAL_MS);
    authorityWatcher.unref?.();
    let applied: Awaited<ReturnType<typeof runClawRemoveCli>>;
    try {
      checkAuthority();
      controller.signal.throwIfAborted();
      applied = await runClawRemoveCli({
        agentId: input.agentId,
        planIntegrity: canonicalPlan.planIntegrity,
        signal: controller.signal,
      });
      input.assertCurrent();
      controller.signal.throwIfAborted();
    } finally {
      clearInterval(authorityWatcher);
      input.signal?.removeEventListener("abort", onRequestAbort);
    }
    const result = removeResultSchema.safeParse(applied.payload);
    if (
      !result.success ||
      result.data.agentId !== input.agentId ||
      applied.code !== (result.data.status === "complete" ? 0 : 1)
    ) {
      throw new Error("The Claw removal command returned an invalid result.");
    }
    return {
      agentId: input.agentId,
      status: result.data.status,
      agentRemoved: result.data.agentRemoved,
      ...(result.data.status === "partial"
        ? {
            error: {
              code: "remove_partial",
              message: "Claw removal is incomplete. Review its status before retrying.",
            },
          }
        : {}),
    };
  } catch {
    log.error("Claw removal outcome is uncertain; inspect Claws status before retrying.");
    return {
      agentId: input.agentId,
      status: "partial",
      agentRemoved: false,
      error: {
        code: "remove_outcome_uncertain",
        message: "Claw state may have changed. Review its status before retrying.",
      },
    };
  }
}

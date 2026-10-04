// Agent cron writes retain caller scope and optimistic concurrency, not tool snapshots.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../../utils.js";
import type { GatewayToolCaller } from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";

export function assertNoCronShellExecution(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const payload = isRecord(value.payload) ? value.payload : undefined;
  if (normalizeLowercaseStringOrEmpty(payload?.kind) === "command") {
    throw new Error(
      "automation command payloads cannot be created or edited through the agent automations tool; use the CLI or Gateway API.",
    );
  }
  const schedule = isRecord(value.schedule) ? value.schedule : undefined;
  if (schedule?.kind === "on-exit") {
    throw new Error(
      "automation on-exit schedules cannot be created or edited through the agent automations tool; use the CLI or Gateway API.",
    );
  }
}

export async function updateCronJobFromAgentTool(params: {
  id: string;
  patch: Record<string, unknown>;
  adminManagement?: boolean;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
  operationSignal?: AbortSignal;
}): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    params.operationSignal?.throwIfAborted();
    let patch = params.patch;
    let expectedConfigRevision: string | undefined;
    if (isRecord(patch.payload) || Object.hasOwn(patch, "trigger")) {
      const existing = await params.callGateway("cron.get", params.gatewayOpts, { id: params.id });
      params.operationSignal?.throwIfAborted();
      if (
        !isRecord(existing) ||
        typeof existing.configRevision !== "string" ||
        !existing.configRevision
      ) {
        throw new Error(
          "cron.get response is missing configRevision; restart the Gateway before retrying this update",
        );
      }
      expectedConfigRevision = existing.configRevision;
      if (isRecord(patch.payload)) {
        const currentPayload = isRecord(existing.payload) ? existing.payload : undefined;
        patch = {
          ...patch,
          payload: { ...patch.payload, kind: patch.payload.kind ?? currentPayload?.kind },
        };
      }
      // A partial payload must not hide an operator-only command behind its omitted kind.
      if (!params.adminManagement) {
        assertNoCronShellExecution(patch);
      }
    }
    try {
      params.operationSignal?.throwIfAborted();
      return await params.callGateway("cron.update", params.gatewayOpts, {
        id: params.id,
        patch,
        ...(expectedConfigRevision ? { expectedConfigRevision } : {}),
      });
    } catch (error) {
      if (attempt === 0 && isCronJobConfigRevisionConflict(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("cron update retry exhausted");
}

function isCronJobConfigRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const details = isRecord((error as Error & { details?: unknown }).details)
    ? (error as Error & { details: Record<string, unknown> }).details
    : undefined;
  return details?.code === "CRON_JOB_CHANGED";
}

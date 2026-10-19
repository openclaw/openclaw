import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import type { RespondFn } from "./types.js";
export { parseGatewayPayload } from "../server-json.js";

export const respondUnavailableOnNodeInvokeError: <T extends { ok: boolean; error?: unknown }>(
  respond: RespondFn,
  res: T,
) => res is T & { ok: true } = respondUnavailableOnNodeInvokeErrorWithProvenance;

export function respondUnavailableOnNodeInvokeErrorWithProvenance<
  T extends { ok: boolean; error?: unknown },
>(
  respond: RespondFn,
  res: T,
  provenance?: { nodeCommandDispatched: boolean; permissionMissing?: unknown; message?: string },
): res is T & { ok: true } {
  if (res.ok) {
    return true;
  }
  const nodeError =
    res.error && typeof res.error === "object"
      ? (res.error as { code?: unknown; message?: unknown })
      : null;
  const nodeCode = normalizeOptionalString(nodeError?.code) ?? "";
  const nodeMessage = normalizeOptionalString(nodeError?.message) ?? "node invoke failed";
  const message = provenance?.message ?? (nodeCode ? `${nodeCode}: ${nodeMessage}` : nodeMessage);
  const details = {
    nodeError: res.error ?? null,
    ...(provenance ? { nodeCommandDispatched: provenance.nodeCommandDispatched } : {}),
    ...(provenance?.permissionMissing ? { permissionMissing: provenance.permissionMissing } : {}),
  };
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details,
    }),
  );
  return false;
}

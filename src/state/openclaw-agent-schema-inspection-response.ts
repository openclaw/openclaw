import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import { nativeErrorResponseSchema } from "../infra/native-error-response-schema.js";
import {
  restoreNativeErrorResponse,
  serializeNativeErrorResponse,
} from "../infra/native-error-response.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

export const agentSchemaInspectionErrorSchema = nativeErrorResponseSchema.extend({
  stateError: z.unknown().optional(),
});

type InspectionError = z.infer<typeof agentSchemaInspectionErrorSchema>;

export function serializeAgentSchemaInspectionError(value: unknown): InspectionError {
  const error = toStringifiedError(value);
  return {
    ...serializeNativeErrorResponse(error),
    stateError: encodeOpenClawStateWorkerError(error),
  };
}

export function restoreAgentSchemaInspectionError(value: InspectionError): Error {
  const error = restoreNativeErrorResponse(value);
  if (value.stateError) {
    retainOpenClawStateWorkerErrorPayload(error, value.stateError);
  }
  return hydrateOpenClawStateWorkerError(error);
}

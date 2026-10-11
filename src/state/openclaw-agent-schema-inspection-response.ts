import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { NativeErrorResponse } from "../infra/native-error-response-schema.js";
import {
  restoreNativeErrorResponse,
  serializeNativeErrorResponse,
} from "../infra/native-error-response.js";
import { formatSqliteReadOnlyInspectionFailure } from "../infra/sqlite-error-diagnostics.js";
import type { AgentSchemaInspection } from "./openclaw-agent-schema-inspection.js";
import type { StateSchemaInspection } from "./openclaw-state-schema-preflight.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

type InspectionError = NativeErrorResponse & { stateError?: unknown };

/** Private IPC between the bundled inspection child and its scheduler. */
export type AgentSchemaInspectionResponse =
  | { requestId: number; ok: false; error: InspectionError }
  | {
      requestId: number;
      ok: true;
      inspection: (Omit<AgentSchemaInspection, "failure"> & { failure?: InspectionError }) | null;
      stateInspection?: Omit<StateSchemaInspection, "inspectionErrors"> & {
        inspectionErrors: InspectionError[];
      };
      schemaContracts?: StateSchemaInspection["schemaContracts"];
    };

export function serializeAgentSchemaInspectionError(value: unknown): InspectionError {
  const error = toStringifiedError(value);
  return {
    ...serializeNativeErrorResponse(error),
    message: formatSqliteReadOnlyInspectionFailure(error),
    stateError: encodeOpenClawStateWorkerError(error),
  };
}

export function restoreAgentSchemaInspectionError(value: InspectionError): Error {
  const error = restoreNativeErrorResponse(value);
  if (value.stateError) {
    retainOpenClawStateWorkerErrorPayload(error, value.stateError);
  }
  const restored = hydrateOpenClawStateWorkerError(error);
  restored.message = value.message;
  return restored;
}

import AjvPkg, { type ErrorObject } from "ajv";
import {
  AgentEventSchema,
  AgentParamsSchema,
  ErrorCodes,
  ErrorShapeSchema,
  EventFrameSchema,
  HelloErrorSchema,
  HelloOkSchema,
  HelloSchema,
  PresenceEntrySchema,
  ProtocolSchemas,
  RequestFrameSchema,
  ResponseFrameSchema,
  SendParamsSchema,
  SnapshotSchema,
  StateVersionSchema,
  errorShape,
  type AgentEvent,
  type ErrorShape,
  type EventFrame,
  type Hello,
  type HelloError,
  type HelloOk,
  type PresenceEntry,
  type RequestFrame,
  type ResponseFrame,
  type Snapshot,
  type StateVersion,
} from "./schema.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateHello = ajv.compile<Hello>(HelloSchema);
export const validateRequestFrame = ajv.compile<RequestFrame>(RequestFrameSchema);
export const validateSendParams = ajv.compile(SendParamsSchema);
export const validateAgentParams = ajv.compile(AgentParamsSchema);

export function formatValidationErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors) return "unknown validation error";
  return ajv.errorsText(errors, { separator: "; " });
}

export {
  HelloSchema,
  HelloOkSchema,
  HelloErrorSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  PresenceEntrySchema,
  SnapshotSchema,
  ErrorShapeSchema,
  StateVersionSchema,
  AgentEventSchema,
  SendParamsSchema,
  AgentParamsSchema,
  ProtocolSchemas,
  ErrorCodes,
  errorShape,
};

export type {
  Hello,
  HelloOk,
  HelloError,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  PresenceEntry,
  Snapshot,
  ErrorShape,
  StateVersion,
  AgentEvent,
};

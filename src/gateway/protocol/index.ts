import AjvPkg, { type ErrorObject } from "ajv";
import {
  type AgentEvent,
  AgentEventSchema,
  AgentParamsSchema,
  type ChatEvent,
  ChatEventSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  type ConnectParams,
  ConnectParamsSchema,
  ErrorCodes,
  type ErrorShape,
  ErrorShapeSchema,
  type EventFrame,
  EventFrameSchema,
  errorShape,
  type GatewayFrame,
  GatewayFrameSchema,
  type HelloOk,
  HelloOkSchema,
  PROTOCOL_VERSION,
  type PresenceEntry,
  PresenceEntrySchema,
  ProtocolSchemas,
  type RequestFrame,
  RequestFrameSchema,
  type ResponseFrame,
  ResponseFrameSchema,
  SendParamsSchema,
  type ShutdownEvent,
  ShutdownEventSchema,
  type Snapshot,
  SnapshotSchema,
  type StateVersion,
  StateVersionSchema,
  type TickEvent,
  TickEventSchema,
} from "./schema.js";

const ajv = new (
  AjvPkg as unknown as new (
    opts?: object,
  ) => import("ajv").default
)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateConnectParams =
  ajv.compile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame =
  ajv.compile<RequestFrame>(RequestFrameSchema);
export const validateSendParams = ajv.compile(SendParamsSchema);
export const validateAgentParams = ajv.compile(AgentParamsSchema);
export const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
export const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
export const validateChatEvent = ajv.compile(ChatEventSchema);

export function formatValidationErrors(
  errors: ErrorObject[] | null | undefined,
) {
  if (!errors) return "unknown validation error";
  return ajv.errorsText(errors, { separator: "; " });
}

export {
  ConnectParamsSchema,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  PresenceEntrySchema,
  SnapshotSchema,
  ErrorShapeSchema,
  StateVersionSchema,
  AgentEventSchema,
  ChatEventSchema,
  SendParamsSchema,
  AgentParamsSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  TickEventSchema,
  ShutdownEventSchema,
  ProtocolSchemas,
  PROTOCOL_VERSION,
  ErrorCodes,
  errorShape,
};

export type {
  GatewayFrame,
  ConnectParams,
  HelloOk,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  PresenceEntry,
  Snapshot,
  ErrorShape,
  StateVersion,
  AgentEvent,
  ChatEvent,
  TickEvent,
  ShutdownEvent,
};

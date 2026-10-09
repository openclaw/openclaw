import { z } from "zod";
import type { AsyncDebugProxyCaptureStore } from "./store.types.js";

const text = z.string();
const event = z
  .object({
    sessionId: text.min(1),
    ts: z.number().finite(),
    sourceScope: z.literal("openclaw"),
    sourceProcess: text,
    protocol: z.enum(["http", "https", "sse", "ws", "wss", "connect"]),
    direction: z.enum(["outbound", "inbound", "local"]),
    kind: z.enum([
      "connect",
      "tls-handshake",
      "request",
      "response",
      "ws-open",
      "ws-frame",
      "ws-close",
      "error",
      "retry-link",
    ]),
    flowId: text,
    method: text.optional(),
    host: text.optional(),
    path: text.optional(),
    status: z.number().optional(),
    closeCode: z.number().optional(),
    contentType: text.optional(),
    headersJson: text.optional(),
    dataText: text.optional(),
    dataBlobId: text.optional(),
    dataSha256: text.optional(),
    errorText: text.optional(),
    metaJson: text.optional(),
  })
  .strict();

export const debugProxyCaptureWriteCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("capture.upsertSession"),
      input: z
        .object({
          id: text.min(1),
          startedAt: z.number().finite(),
          endedAt: z.number().finite().optional(),
          mode: text,
          sourceScope: z.literal("openclaw"),
          sourceProcess: text,
          proxyUrl: text.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture.endSession"),
      input: z.object({ sessionId: text.min(1), endedAt: z.number().finite() }).strict(),
    })
    .strict(),
  z.object({ type: z.literal("capture.recordEvent"), input: event }).strict(),
  z
    .object({
      type: z.literal("capture.recordEventWithPayload"),
      input: z
        .object({
          event,
          payload: z
            .object({
              data: text.nullable().optional(),
              base64: z.boolean().optional(),
              contentType: text.optional(),
              previewLimit: z.number().int().nonnegative().optional(),
            })
            .strict()
            .transform(({ data, base64, ...rest }) => ({
              ...rest,
              data: base64 && data != null ? Buffer.from(data, "base64") : data,
            })),
        })
        .strict(),
    })
    .strict(),
]);

export const debugProxyCliCommandSchema = z.discriminatedUnion("type", [
  ...debugProxyCaptureWriteCommandSchema.options,
  z
    .object({
      type: z.literal("capture.listSessions"),
      input: z.object({ limit: z.number().int().positive().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture.readBlob"),
      input: z.object({ blobId: text.min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture.queryPreset"),
      input: z
        .object({
          preset: z.enum([
            "double-sends",
            "retry-storms",
            "cache-busting",
            "ws-duplicate-frames",
            "missing-ack",
            "error-bursts",
          ]),
          sessionId: text.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("capture.purgeAll"), input: z.undefined().optional() }).strict(),
]);

export type DebugProxyCliStore = Pick<
  AsyncDebugProxyCaptureStore,
  | "dbPath"
  | "upsertSession"
  | "endSession"
  | "recordEvent"
  | "recordEventWithPayload"
  | "listSessions"
  | "readBlob"
  | "queryPreset"
  | "purgeAll"
>;

export function encodeDebugProxyPayload(
  payload: import("./store.worker-contract.js").CapturePayloadInput,
) {
  return {
    ...payload,
    ...(Buffer.isBuffer(payload.data)
      ? { data: payload.data.toString("base64"), base64: true }
      : {}),
  };
}

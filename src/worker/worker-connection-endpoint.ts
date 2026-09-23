import path from "node:path";
import type { ClientOptions } from "ws";
import { z } from "zod";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import { buildCloudflareAccessHeaders } from "../../packages/gateway-client/src/cloudflare-access.js";
import {
  GatewayWebSocketTransportConfigurationError,
  resolveGatewayWebSocketTransport,
} from "../../packages/gateway-client/src/websocket-transport.js";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { workerProtocolObject } from "./protocol-record.js";

const ENDPOINT_FIELD_MAX_LENGTH = 4_096;
// JSON needs at most six bytes per UTF-16 code unit (control/lone-surrogate escapes).
// These closed shapes cover both endpoints; parsed TLS pins are 64 ASCII hex digits.
export const WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES = Math.max(
  Buffer.byteLength(
    JSON.stringify({
      kind: "unix",
      socketPath: "\0".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH),
    }),
  ),
  Buffer.byteLength(
    JSON.stringify({
      kind: "websocket",
      url: "\0".repeat(ENDPOINT_FIELD_MAX_LENGTH),
      tlsFingerprint: "0".repeat(64),
      cloudflareAccess: {
        clientId: "\0".repeat(ENDPOINT_FIELD_MAX_LENGTH),
        clientSecret: "\0".repeat(ENDPOINT_FIELD_MAX_LENGTH),
      },
    }),
  ),
);

export class WorkerConnectionEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConnectionEndpointError";
  }
}

const AccessCredential = z
  .string()
  .refine((value) => Boolean(value.trim()) && value.length <= ENDPOINT_FIELD_MAX_LENGTH);
const EndpointSchema = z.union([
  workerProtocolObject({
    kind: z.literal("unix"),
    socketPath: z
      .string()
      .refine(
        (value) =>
          value.length <= WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH &&
          path.isAbsolute(value) &&
          !value.includes(":"),
      ),
  }),
  workerProtocolObject({
    kind: z.literal("websocket"),
    url: z.string().refine((value) => value.length <= ENDPOINT_FIELD_MAX_LENGTH),
    tlsFingerprint: z.string().transform(normalizeTlsFingerprint).refine(Boolean).optional(),
    cloudflareAccess: workerProtocolObject({
      clientId: AccessCredential,
      clientSecret: AccessCredential,
    }).optional(),
  })
    .refine((value) => {
      const url = URL.parse(value.url);
      return (
        url !== null &&
        (url.protocol === "ws:" || url.protocol === "wss:") &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        url.pathname.endsWith(WORKER_PUBLIC_INGRESS_PATH) &&
        ((value.tlsFingerprint === undefined && value.cloudflareAccess === undefined) ||
          url.protocol === "wss:")
      );
    })
    .transform(({ tlsFingerprint, cloudflareAccess, ...endpoint }) => ({
      ...endpoint,
      ...(tlsFingerprint ? { tlsFingerprint } : {}),
      ...(cloudflareAccess ? { cloudflareAccess } : {}),
    })),
]);

export type WorkerConnectionEndpoint = z.infer<typeof EndpointSchema>;

export function parseWorkerConnectionEndpoint(
  value: unknown,
): WorkerConnectionEndpoint | undefined {
  const parsed = EndpointSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

type WorkerConnectionTarget = {
  url: string;
  options: ClientOptions;
};

export function resolveWorkerConnectionTarget(
  endpoint: WorkerConnectionEndpoint,
  env: NodeJS.ProcessEnv = process.env,
): WorkerConnectionTarget {
  if (endpoint.kind === "unix") {
    return {
      url: `ws+unix://${endpoint.socketPath}:/`,
      options: {},
    };
  }
  if (endpoint.cloudflareAccess && new URL(endpoint.url).protocol !== "wss:") {
    throw new WorkerConnectionEndpointError(
      "Cloudflare Access credentials require a wss:// worker endpoint",
    );
  }
  try {
    const transport = resolveGatewayWebSocketTransport({
      url: endpoint.url,
      tlsFingerprint: endpoint.tlsFingerprint,
      env,
      options: endpoint.cloudflareAccess
        ? {
            followRedirects: false,
            headers: buildCloudflareAccessHeaders(endpoint.cloudflareAccess),
          }
        : {},
    });
    return { url: endpoint.url, ...transport };
  } catch (error) {
    if (error instanceof GatewayWebSocketTransportConfigurationError) {
      throw new WorkerConnectionEndpointError(error.message);
    }
    throw error;
  }
}

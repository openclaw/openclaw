import { z } from "zod";
import { clawMonitorSnapshotSchema } from "./monitor-cleanup-contract.js";
import { clawPackageRemovalGatewayRequestSchema } from "./package-remove-contract.js";

export const CLAW_REMOVE_GATEWAY_BRIDGE_ENV = "OPENCLAW_CLAW_REMOVE_GATEWAY_BRIDGE";
export const CLAW_REMOVE_AUTHORITY_REQUEST = 0x3f;
export const CLAW_REMOVE_AUTHORITY_GRANTED = 0x47;
export const CLAW_REMOVE_AUTHORITY_DENIED = 0x44;

const requestId = z.number().int().positive();
const text = z.string().min(1).max(4096);
const configRevision = z.string().min(1).max(128);
const baseRequest = { kind: z.literal("claw.remove.request"), id: requestId };

export const clawRemoveBridgeRequestSchema = z.discriminatedUnion("op", [
  z.object({ ...baseRequest, op: z.literal("monitor.inspect"), agentId: text }).strict(),
  z
    .object({
      ...baseRequest,
      op: z.literal("monitor.quiesce"),
      agentId: text,
      operationId: text,
      monitors: z.array(clawMonitorSnapshotSchema).max(2),
    })
    .strict(),
  z
    .object({
      ...baseRequest,
      op: z.literal("monitor.drain"),
      agentId: text,
      operationId: text,
    })
    .strict(),
  z
    .object({
      ...baseRequest,
      op: z.literal("package.remove"),
      request: clawPackageRemovalGatewayRequestSchema,
    })
    .strict(),
  z.object({ ...baseRequest, op: z.literal("cron.get"), schedulerJobId: text }).strict(),
  z
    .object({
      ...baseRequest,
      op: z.literal("cron.remove"),
      schedulerJobId: text,
      expectedConfigRevision: configRevision,
    })
    .strict(),
]);

export const clawRemoveBridgeResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      kind: z.literal("claw.remove.response"),
      id: requestId,
      ok: z.literal(true),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("claw.remove.response"),
      id: requestId,
      ok: z.literal(false),
      error: z.string().max(8192),
    })
    .strict(),
]);

export type ClawRemoveBridgeRequest = z.infer<typeof clawRemoveBridgeRequestSchema>;
export type ClawRemoveBridgeResponse = z.infer<typeof clawRemoveBridgeResponseSchema>;

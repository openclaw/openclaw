import { z } from "zod";
import { GatewayOperatorRoleDefinitionSchema } from "../config/zod-schema.gateway.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { userChannelAuthorizationReferenceSchema } from "../state/user-channel-authorization-reference.js";

export const MAX_RECOVERY_SOURCE_BYTES = 65_536;
const boundedString = z.string().min(1).max(4096);
const refs = z.strictObject({
  exact: z.array(boundedString).max(4096),
  wildcards: z.array(boundedString).max(256),
});
export const operatorRunRecoverySnapshotSchema = z.strictObject({
  profileId: boundedString,
  scopes: z.array(boundedString).max(64),
  assignedRole: boundedString.nullable(),
  githubLogin: boundedString.nullable(),
  rolePolicy: GatewayOperatorRoleDefinitionSchema.omit({ modelPolicy: true }).optional(),
  modelPolicy: z
    .strictObject({
      models: z.array(z.strictObject({ provider: boundedString, model: boundedString })).max(4096),
      allowed: refs,
      denied: refs,
    })
    .optional(),
  grant: z.strictObject({ pluginId: boundedString, grantId: boundedString }).nullable(),
  aliasBindingIds: z.array(boundedString).max(256),
  authPolicy: z.strictObject({
    generation: z.literal(""),
    grantGeneration: boundedString,
    role: z.literal("operator"),
    authMethod: z.enum(["token", "password", "device-token", "tailscale", "trusted-proxy"]),
    authModeOverride: z.enum(["none", "token", "password", "trusted-proxy"]).optional(),
    verifiedIdentity: boundedString.optional(),
    browserOrigin: z
      .strictObject({
        requestHost: boundedString.optional(),
        origin: boundedString.optional(),
        isLocalClient: z.boolean().optional(),
      })
      .optional(),
  }),
  sharedGeneration: boundedString.optional(),
  device: z
    .strictObject({ deviceId: boundedString, key: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
  controlUiAdmin: z.boolean(),
  localOperator: z.boolean(),
  sourceIngress: z.enum(["control-ui", "internal"]),
});
const sourceSchema = z.strictObject({
  version: z.literal(1),
  agentId: boundedString,
  sessionKey: boundedString,
  sessionId: boundedString,
  lifecycleRevision: boundedString.optional(),
  sourceRunId: boundedString,
  snapshot: operatorRunRecoverySnapshotSchema,
});

const channelSnapshotSchema = z.strictObject({
  reference: userChannelAuthorizationReferenceSchema,
  profileId: boundedString,
  scopes: operatorRunRecoverySnapshotSchema.shape.scopes,
  modelPolicy: operatorRunRecoverySnapshotSchema.shape.modelPolicy,
});
const queuedSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("gateway"), snapshot: operatorRunRecoverySnapshotSchema }),
  z.strictObject({ kind: z.literal("channel"), snapshot: channelSnapshotSchema }),
  z.strictObject({ kind: z.literal("unavailable") }),
]);

/** Retained only by the native queued launch; acceptance or settlement clears it. */
export type QueuedOperatorRecoverySource = z.infer<typeof queuedSourceSchema>;

export function decodeQueuedOperatorRecoverySource(value: unknown): QueuedOperatorRecoverySource {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, "utf8") > MAX_RECOVERY_SOURCE_BYTES) {
    throw new Error("Queued operator recovery source exceeds its storage bound.");
  }
  const parsed = queuedSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Queued operator recovery source is invalid; submit a new request.");
  }
  return freezeJsonSnapshot(parsed.data);
}

/** Original authenticated basis, not an executable grant or a transport credential. */
export type OperatorRunRecoverySnapshot = z.infer<typeof operatorRunRecoverySnapshotSchema>;

/** Private input custody; copied attribution or another session cannot authorize recovery. */
export type RestartRecoveryOperatorSource = z.infer<typeof sourceSchema>;

export function decodeGatewayOperatorRecoverySource(value: unknown): RestartRecoveryOperatorSource {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, "utf8") > MAX_RECOVERY_SOURCE_BYTES) {
    throw new Error("Restart recovery operator source exceeds its storage bound.");
  }
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Restart recovery operator source is invalid; start a new user turn.");
  }
  return freezeJsonSnapshot(parsed.data);
}

/** Canonical bounded evidence shared by admission and durable recovery. */
export function normalizeGatewayOperatorRecoverySnapshot(
  value: unknown,
): OperatorRunRecoverySnapshot | undefined {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, "utf8") > MAX_RECOVERY_SOURCE_BYTES) {
    return undefined;
  }
  // Admission must capture the same optional-field shape the durable claim
  // reloads; canonicalization belongs here, not in a permissive comparison.
  const parsed = operatorRunRecoverySnapshotSchema.safeParse(JSON.parse(json));
  return parsed.success ? freezeJsonSnapshot(parsed.data) : undefined;
}

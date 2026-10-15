import { z } from "zod";
import { GatewayOperatorRoleDefinitionSchema } from "../config/zod-schema.gateway.js";

const boundedString = z.string().min(1).max(4096);
const refs = z.strictObject({
  exact: z.array(boundedString).max(4096),
  wildcards: z.array(boundedString).max(256),
});
export const snapshotSchema = z.strictObject({
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
export const sourceSchema = z.strictObject({
  version: z.literal(1),
  agentId: boundedString,
  sessionKey: boundedString,
  sessionId: boundedString,
  lifecycleRevision: boundedString.optional(),
  sourceRunId: boundedString,
  snapshot: snapshotSchema,
});

/** Original authenticated basis, not an executable grant or a transport credential. */
export type OperatorRunRecoverySnapshot = z.infer<typeof snapshotSchema>;

/** Private input custody; copied attribution or another session cannot authorize recovery. */
export type RestartRecoveryOperatorSource = z.infer<typeof sourceSchema>;

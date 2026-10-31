// Recovery consumes the same role schema without initializing unrelated Gateway schemas.
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  CRON_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  SESSION_READ_SCOPE,
  SESSION_WRITE_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
} from "../gateway/operator-scopes.js";

export const OperatorScopeSchema = z.enum([
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  CRON_SCOPE,
  SESSION_READ_SCOPE,
  SESSION_WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  PAIRING_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
]);
export const GatewayOperatorRoleDefinitionSchema = z.strictObject({
  sessions: z.strictObject({
    /** Maximum access to another person's sessions without explicit membership. */
    others: z.enum(["none", "view", "suggest", "write"]),
  }),
  /** Require sandbox isolation for newly created sessions, or inherit agent policy by default. */
  sandbox: z.enum(["inherit", "required"]).optional(),
  /** Agent IDs available for session creation and runs, or all agents when set to "*". */
  agents: z.union([
    z.literal("*"),
    z
      .array(z.string().trim().min(1).refine(isValidAgentId, "Invalid agent id"))
      .transform((agents) => uniqueValues(agents.map(normalizeAgentId))),
  ]),
  /** Cloud profiles this role may explicitly dispatch its own sessions to. */
  workerProfiles: z.array(z.string().trim().min(1)).transform(uniqueValues).optional(),
  /** Optional model ceiling for this role; defaults to the source agent's primary and fallbacks. */
  modelPolicy: z
    .strictObject({
      sourceAgent: z
        .string()
        .trim()
        .min(1)
        .refine(isValidAgentId, "Invalid agent id")
        .transform(normalizeAgentId)
        .optional(),
      allow: z.array(z.string().trim().min(1)).optional(),
      deny: z.array(z.string().trim().min(1)).optional(),
    })
    .optional(),
  /** Nonstandard Access requires an explicit grant, independent of model membership. */
  accessPrograms: z
    .strictObject({
      cyber: z
        .array(z.enum(["daybreak_blue", "daybreak_red"]))
        .transform((programs) => uniqueValues(programs)),
    })
    .optional(),
  /** Ceiling applied to the authenticated profile's granted operator scopes. */
  scopes: z.array(OperatorScopeSchema).transform((scopes) => uniqueValues(scopes)),
  /** Required access-policy plugin; availability is checked at admission, not config parsing. */
  accessPolicyPlugin: z.string().trim().min(1).max(128).optional(),
});

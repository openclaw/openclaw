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
  PUBLICATION_READ_SCOPE,
  PUBLICATION_STEER_SCOPE,
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
  PUBLICATION_READ_SCOPE,
  PUBLICATION_STEER_SCOPE,
  SESSION_WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  PAIRING_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
]);

export const GatewayOperatorRoleDefinitionSchema = z.strictObject({
  sessions: z
    .strictObject({
      /** Maximum access to another person's sessions without explicit membership. */
      others: z.enum(["none", "invited", "view", "suggest", "write"]),
      maxInvitedAccess: z.enum(["read", "suggest", "send"]).optional(),
      invitedPermission: z.enum(["read-only", "guarded", "workspace", "full"]).optional(),
      invitedTools: z.array(z.string().trim().min(1)).transform(uniqueValues).optional(),
      invitedAlsoAllow: z.array(z.string().trim().min(1)).transform(uniqueValues).optional(),
    })
    .refine(
      (sessions) => sessions.invitedPermission === undefined || sessions.others === "invited",
      {
        message: 'invitedPermission requires sessions.others to be "invited"',
        path: ["invitedPermission"],
      },
    )
    .refine(
      (sessions) => sessions.maxInvitedAccess === undefined || sessions.others === "invited",
      {
        message: 'maxInvitedAccess requires sessions.others to be "invited"',
        path: ["maxInvitedAccess"],
      },
    )
    .refine(
      (sessions) => sessions.invitedTools === undefined || sessions.maxInvitedAccess !== undefined,
      {
        message: "invitedTools requires sessions.maxInvitedAccess",
        path: ["invitedTools"],
      },
    )
    .refine(
      (sessions) =>
        sessions.invitedAlsoAllow === undefined || sessions.maxInvitedAccess !== undefined,
      {
        message: "invitedAlsoAllow requires sessions.maxInvitedAccess",
        path: ["invitedAlsoAllow"],
      },
    )
    .refine(
      (sessions) => sessions.invitedTools === undefined || sessions.invitedAlsoAllow === undefined,
      {
        message:
          "sessions policy cannot set both invitedTools and invitedAlsoAllow in the same scope (merge invitedAlsoAllow into invitedTools, or remove invitedTools and use defaults + invitedAlsoAllow)",
      },
    ),
  /** Require sandbox isolation for newly created sessions, or inherit agent policy by default. */
  sandbox: z.enum(["inherit", "required"]).optional(),
  /** Agent IDs available for session creation and runs, or all agents when set to "*". */
  agents: z.union([
    z.literal("*"),
    z
      .array(z.string().trim().min(1).refine(isValidAgentId, "Invalid agent id"))
      .transform((agents) => uniqueValues(agents.map(normalizeAgentId))),
  ]),
  /** Registered project IDs this role may use beyond public repositories, or every project with "*". */
  projects: z
    .union([z.literal("*"), z.array(z.string().trim().min(1)).transform(uniqueValues)])
    .optional(),
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
  /** Explicit Access ceiling; omission uses admin authority or Standard for restricted roles. */
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

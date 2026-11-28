import { parseAgentSessionKey } from "@openclaw/session-url-contract/session-key-normalization";
import { z } from "zod";
import { resolveUserPath } from "../../utils.js";
import { sessionCreatorProfileId, type SessionCreatedActor } from "./session-entry-provenance.js";

const boundedString = z.string().min(1).max(4096);
const nonEmptyString = z.string().min(1);

function sourceSchema(string: z.ZodString) {
  return z.strictObject({
    agentId: string,
    sessionId: string,
    lifecycleRevision: string.nullable(),
    creatorProfileId: string,
    root: string,
  });
}

/** Durable restriction evidence, never a live writer lease or an authorization grant. */
export type SessionParticipationSource = Readonly<z.infer<ReturnType<typeof sourceSchema>>>;

const execPolicySchema = z.strictObject({
  security: z.enum(["deny", "allowlist", "full"]),
  ask: z.enum(["off", "on-miss", "always"]),
  denyMisses: z.literal(true).optional(),
});
const permissionSchema = z.enum(["read-only", "guarded", "workspace", "full"]);

/** Queued and delegated inputs share this exact bounded durable invitation dialect. */
export const boundSessionParticipationSchema = z
  .strictObject({
    kind: z.literal("send"),
    profileId: boundedString,
    sessionKey: boundedString,
    tools: z.array(boundedString).max(256),
    toolConstraints: z.array(z.array(boundedString).max(256)).max(32).optional(),
    permission: permissionSchema,
    execPolicy: execPolicySchema.optional(),
    source: sourceSchema(boundedString),
  })
  .refine(
    (ceiling) => parseAgentSessionKey(ceiling.sessionKey)?.agentId === ceiling.source.agentId,
  );

/** Publication's retained wire contract keeps its own optional policy fields and bounds. */
export const publicationSessionParticipationSchema = z.strictObject({
  kind: z.literal("send"),
  profileId: nonEmptyString.max(128),
  sessionKey: nonEmptyString,
  tools: z.array(nonEmptyString).optional(),
  toolConstraints: z.array(z.array(nonEmptyString)).optional(),
  permission: permissionSchema.optional(),
  execPolicy: execPolicySchema.optional(),
  source: sourceSchema(nonEmptyString),
});

export const sessionParticipationTargetSchema = z.strictObject({
  agentId: nonEmptyString,
  sessionKey: nonEmptyString,
  sessionId: nonEmptyString,
  lifecycleRevision: nonEmptyString.nullable(),
});
export type SessionParticipationTarget = Readonly<z.infer<typeof sessionParticipationTargetSchema>>;

type EntryTarget = {
  agentId: string;
  canonicalKey: string;
  entry: {
    sessionId: string;
    lifecycleRevision?: string;
    createdActor?: SessionCreatedActor;
    sessionRoot?: string;
    spawnedWorkspaceDir?: string;
  };
};
type Invitation = { sessionKey: string; source?: SessionParticipationSource };

/** Capture after the admitted input's initial transcript transition, before durable retention. */
export function captureSessionParticipationSource(
  sessionKey: string,
  target: EntryTarget,
  workspaceDir: string,
): SessionParticipationSource {
  const creatorProfileId = sessionCreatorProfileId(target.entry.createdActor);
  if (!creatorProfileId || target.canonicalKey !== sessionKey) {
    throw new Error("Participation requires its original session incarnation and creator.");
  }
  return Object.freeze({
    agentId: target.agentId,
    sessionId: target.entry.sessionId,
    lifecycleRevision: target.entry.lifecycleRevision ?? null,
    creatorProfileId,
    root: resolveUserPath(
      target.entry.sessionRoot ?? target.entry.spawnedWorkspaceDir ?? workspaceDir,
    ),
  });
}

/** Intersect durable restrictions without adopting a different source from a continuation. */
export function intersectSessionParticipationSources(
  retained: SessionParticipationSource | undefined,
  current: SessionParticipationSource | undefined,
): SessionParticipationSource | undefined {
  if (
    retained &&
    current &&
    (retained.agentId !== current.agentId ||
      retained.sessionId !== current.sessionId ||
      retained.lifecycleRevision !== current.lifecycleRevision ||
      retained.creatorProfileId !== current.creatorProfileId ||
      retained.root !== current.root)
  ) {
    throw new Error("Participation continuations must retain one original invitation.");
  }
  const source = retained ?? current;
  return source && Object.freeze({ ...source });
}

/** Current sharing facts must still name the original invitation, including creator and root. */
export function matchesSessionParticipationSource(
  invitation: Invitation,
  target: EntryTarget,
  workspaceDir: string,
): boolean {
  const source = invitation.source;
  return Boolean(
    source &&
    target.canonicalKey === invitation.sessionKey &&
    target.agentId === source.agentId &&
    target.entry.sessionId === source.sessionId &&
    (target.entry.lifecycleRevision ?? null) === source.lifecycleRevision &&
    sessionCreatorProfileId(target.entry.createdActor) === source.creatorProfileId &&
    resolveUserPath(
      target.entry.sessionRoot ?? target.entry.spawnedWorkspaceDir ?? workspaceDir,
    ) === source.root,
  );
}

/** Route only the original source; child routes require their separately restored envelope. */
export function isSessionParticipationSourceTarget(
  invitation: Invitation,
  target: EntryTarget,
): boolean {
  return Boolean(
    invitation.source &&
    invitation.sessionKey === target.canonicalKey &&
    invitation.source.agentId === target.agentId &&
    invitation.source.sessionId === target.entry.sessionId,
  );
}

export function captureSessionParticipationTarget(target: EntryTarget): SessionParticipationTarget {
  return Object.freeze({
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    sessionId: target.entry.sessionId,
    lifecycleRevision: target.entry.lifecycleRevision ?? null,
  });
}

export function matchesSessionParticipationTarget(
  retained: SessionParticipationTarget,
  current: SessionParticipationTarget,
): boolean {
  return (
    retained.agentId === current.agentId &&
    retained.sessionKey === current.sessionKey &&
    retained.sessionId === current.sessionId &&
    retained.lifecycleRevision === current.lifecycleRevision
  );
}

/** Match persisted queued custody against a committed membership reduction. */
export function matchesSessionParticipationRevocation(
  invitation: { profileId: string; sessionKey: string; source: SessionParticipationSource },
  target: { profileId: string; sessionKey: string; sessionId: string },
): boolean {
  return (
    invitation.profileId === target.profileId &&
    invitation.sessionKey === target.sessionKey &&
    invitation.source.sessionId === target.sessionId
  );
}

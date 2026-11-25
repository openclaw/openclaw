import type { SessionMember } from "./session-membership-facts.types.js";

type Level = NonNullable<SessionMember["access"]>;

/** SQL CHECK constrains stored levels; JSON aggregates retain the same optional column. */
export function readSessionMemberAccess(value: unknown): Level | undefined {
  if (value == null) {
    return undefined;
  }
  if (value !== "read" && value !== "suggest" && value !== "send") {
    throw new Error("Invalid stored session member access");
  }
  return value;
}

export function sessionMemberAccessFacts(members: readonly SessionMember[]): Record<string, Level> {
  return Object.fromEntries(
    members.flatMap(({ identityId, access }) => (access ? [[identityId, access]] : [])),
  );
}

export function sessionMemberWithAccess(member: SessionMember, value: unknown): SessionMember {
  const access = readSessionMemberAccess(value);
  if (access !== undefined) {
    member.access = access;
  }
  return member;
}

export function sessionMemberSideTableFacts(members: readonly SessionMember[]) {
  return {
    memberIdsJson: JSON.stringify(members.map((member) => member.identityId)),
    ...(members.some((member) => member.access !== undefined)
      ? { memberAccessJson: JSON.stringify(sessionMemberAccessFacts(members)) }
      : {}),
  };
}

export function sessionMemberSharingFacts(sessionKey: string, members: readonly SessionMember[]) {
  return {
    sessionKey,
    identityIds: members.map((member) => member.identityId),
    ...(members.some((member) => member.access !== undefined)
      ? { memberAccess: sessionMemberAccessFacts(members) }
      : {}),
  };
}

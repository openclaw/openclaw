import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { CommandOwnerReference } from "../state/user-channel-authorization-reference.js";
import type { UserChannelIdentity } from "../state/user-profiles.types.js";

const COMMAND_OWNER_AUTHORITY = Symbol("openclaw.commandOwnerAuthority");
type CommandOwnerAuthority = Readonly<{
  isCurrent: () => boolean;
  /** Exact native identity accepted by the host ingress, never a delivery projection. */
  channelPrincipal?: Readonly<UserChannelIdentity>;
  recoveryReference?: CommandOwnerReference;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** The requester's own live check for work that outlives this source occurrence. */
  successor?: CommandOwnerAuthority;
}>;
export type CommandOwnerAssertion = SessionSourceAssertion & {
  readonly recoveryReference?: CommandOwnerReference | null;
};

const capabilities = new WeakMap<object, CommandOwnerAuthority>();

/** Host ingress binds a live check; ordinary context copies retain it, wire data cannot. */
export function bindCommandOwnerAuthority(context: object, authority: CommandOwnerAuthority): void {
  const checkCurrent = authority.isCurrent.bind(authority);
  const operatorAuthority = authority.operatorAuthority;
  const recoveryReference =
    authority.recoveryReference && Object.freeze({ ...authority.recoveryReference });
  const capability = {
    recoveryReference,
    channelPrincipal:
      authority.channelPrincipal && Object.freeze({ ...authority.channelPrincipal }),
    operatorAuthority,
    successor: authority.successor,
    isCurrent: checkCurrent,
  };
  Object.setPrototypeOf(capability, null);
  Object.freeze(capability);
  capabilities.set(capability, capability);
  Object.assign(context, { [COMMAND_OWNER_AUTHORITY]: capability });
}

export function getCommandOwnerAuthority(context: object): CommandOwnerAuthority | undefined {
  const value: unknown = Reflect.get(context, COMMAND_OWNER_AUTHORITY);
  return typeof value === "object" && value !== null ? capabilities.get(value) : undefined;
}

/**
 * Moves inherited owner authority into a successor that outlives its source occurrence.
 * Only a source-provided requester check transfers; otherwise the successor holds none.
 */
export function transferCommandOwnerAuthorityToSuccessor(
  context: object,
): "transferred" | "removed" | "none" {
  const authority = getCommandOwnerAuthority(context);
  if (!authority) {
    return "none";
  }
  Reflect.deleteProperty(context, COMMAND_OWNER_AUTHORITY);
  if (!authority.successor) {
    return "removed";
  }
  bindCommandOwnerAuthority(context, authority.successor);
  return "transferred";
}

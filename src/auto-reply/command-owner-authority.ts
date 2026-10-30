import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { CommandOwnerReference } from "../state/user-channel-authorization-reference.js";

const COMMAND_OWNER_AUTHORITY = Symbol("openclaw.commandOwnerAuthority");
type CommandOwnerAuthority = Readonly<{
  isCurrent: () => boolean;
  recoveryReference?: CommandOwnerReference;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** The requester's own live check for work that outlives this source occurrence. */
  successor?: CommandOwnerAuthority;
}>;
export type CommandOwnerAssertion = (() => void) & {
  readonly recoveryReference?: CommandOwnerReference | null;
};

export class CommandOwnerRevokedError extends Error {}

const capabilities = new WeakMap<object, CommandOwnerAuthority>();

/** Host ingress binds a live check; ordinary context copies retain it, wire data cannot. */
export function bindCommandOwnerAuthority(context: object, authority: CommandOwnerAuthority): void {
  const checkCurrent = authority.isCurrent.bind(authority);
  const operatorAuthority = authority.operatorAuthority;
  const recoveryReference =
    authority.recoveryReference && Object.freeze({ ...authority.recoveryReference });
  const capability = {
    recoveryReference,
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

/** Fence a turn that admitted owner tools against later identity or role revocation. */
export function captureCommandOwnerAssertion(context: object): CommandOwnerAssertion | undefined {
  const authority = getCommandOwnerAuthority(context);
  if (!authority) {
    return undefined;
  }
  return Object.assign(
    () => {
      if (!authority.isCurrent()) {
        throw new CommandOwnerRevokedError(
          "Channel operator authority changed; send a new request.",
        );
      }
    },
    { recoveryReference: authority.recoveryReference ?? null },
  );
}

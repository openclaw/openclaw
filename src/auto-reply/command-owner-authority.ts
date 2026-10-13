import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { CommandOwnerReference } from "../state/user-channel-identities.js";

const COMMAND_OWNER_AUTHORITY = Symbol("openclaw.commandOwnerAuthority");
type CommandOwnerAuthority = Readonly<{
  isCurrent: () => boolean;
  recoveryReference?: CommandOwnerReference;
  operatorAuthority?: AdmittedRunOperatorAuthority;
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
    isCurrent: () => checkCurrent(),
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

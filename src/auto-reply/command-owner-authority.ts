import type { CommandOwnerReference } from "../state/user-channel-identities.js";

const COMMAND_OWNER_AUTHORITY = Symbol("openclaw.commandOwnerAuthority");
type CommandOwnerAuthority = Readonly<{
  isCurrent: () => boolean;
  recoveryReference?: CommandOwnerReference;
}>;
export type CommandOwnerAssertion = (() => void) & {
  readonly recoveryReference?: CommandOwnerReference | null;
};

export class CommandOwnerRevokedError extends Error {}

class CommandOwnerCapability implements CommandOwnerAuthority {
  readonly #checkCurrent: () => boolean;
  readonly recoveryReference?: CommandOwnerReference;

  constructor(authority: CommandOwnerAuthority) {
    this.#checkCurrent = authority.isCurrent.bind(authority);
    this.recoveryReference =
      authority.recoveryReference && Object.freeze({ ...authority.recoveryReference });
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(this: void, value: unknown): CommandOwnerCapability | undefined {
    return typeof value === "object" && value !== null && #checkCurrent in value
      ? value
      : undefined;
  }

  readonly isCurrent = (): boolean => this.#checkCurrent();
}

const readCapability = CommandOwnerCapability.read;

/** Host ingress binds a live check; ordinary context copies retain it, wire data cannot. */
export function bindCommandOwnerAuthority(context: object, authority: CommandOwnerAuthority): void {
  Object.assign(context, { [COMMAND_OWNER_AUTHORITY]: new CommandOwnerCapability(authority) });
}

export function getCommandOwnerAuthority(context: object): CommandOwnerAuthority | undefined {
  return readCapability(Reflect.get(context, COMMAND_OWNER_AUTHORITY));
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

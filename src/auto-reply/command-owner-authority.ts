const COMMAND_OWNER_AUTHORITY = Symbol("openclaw.commandOwnerAuthority");
type CommandOwnerAuthority = Readonly<{ isCurrent: () => boolean }>;

class CommandOwnerCapability implements CommandOwnerAuthority {
  readonly #checkCurrent: () => boolean;

  constructor(authority: CommandOwnerAuthority) {
    this.#checkCurrent = authority.isCurrent.bind(authority);
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
export function captureCommandOwnerAssertion(context: object): (() => void) | undefined {
  const authority = getCommandOwnerAuthority(context);
  if (!authority) {
    return undefined;
  }
  return () => {
    if (!authority.isCurrent()) {
      throw new Error("Channel operator authority changed; send a new request.");
    }
  };
}

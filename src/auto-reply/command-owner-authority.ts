import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { readSessionInputProfileId } from "../sessions/session-participant-input.js";
import type { MsgContext } from "./templating.js";

const COMMAND_OWNER_AUTHORITY = Symbol("openclaw.commandOwnerAuthority");
type CommandOwnerAuthority = Readonly<{
  owner?: boolean;
  isCurrent: () => boolean;
  captureOperator?: () =>
    | { authority: AdmittedRunOperatorAuthority; release: () => void }
    | undefined;
  directHumanRequesterProfileId?: () => string | undefined;
}>;

class CommandOwnerCapability implements CommandOwnerAuthority {
  readonly #authority: CommandOwnerAuthority;
  readonly owner: boolean;

  constructor(authority: CommandOwnerAuthority) {
    this.#authority = authority;
    this.owner = authority.owner !== false;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(this: void, value: unknown): CommandOwnerCapability | undefined {
    return typeof value === "object" && value !== null && #authority in value ? value : undefined;
  }

  readonly isCurrent = (): boolean => this.#authority.isCurrent();
  readonly captureOperator = () => this.#authority.captureOperator?.();
  readonly directHumanRequesterProfileId = (): string | undefined =>
    this.#authority.directHumanRequesterProfileId?.();
}

const readCapability = CommandOwnerCapability.read;

/** Host ingress binds a live check; ordinary context copies retain it, wire data cannot. */
export function bindCommandOwnerAuthority(context: object, authority: CommandOwnerAuthority): void {
  Object.assign(context, { [COMMAND_OWNER_AUTHORITY]: new CommandOwnerCapability(authority) });
}

export function getCommandOwnerAuthority(context: object): CommandOwnerCapability | undefined {
  const capability = readCapability(Reflect.get(context, COMMAND_OWNER_AUTHORITY));
  return capability?.owner ? capability : undefined;
}

export function captureChannelOperatorRunAuthority(context: object) {
  return readCapability(Reflect.get(context, COMMAND_OWNER_AUTHORITY))?.captureOperator();
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

/** Attribution for this accepted human turn never follows an inherited execution capability. */
export function resolveDirectHumanRequesterProfileId(
  context: MsgContext,
  operatorAuthority: AdmittedRunOperatorAuthority | undefined,
): string | undefined {
  if (
    !operatorAuthority ||
    context.InternalTurnSource !== undefined ||
    context.InboundEventKind === "room_event" ||
    (context.InputProvenance && context.InputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  operatorAuthority.assertCurrent();
  const profileId =
    readCapability(
      Reflect.get(context, COMMAND_OWNER_AUTHORITY),
    )?.directHumanRequesterProfileId() ?? readSessionInputProfileId(context);
  return profileId === operatorAuthority.profileId ? profileId : undefined;
}

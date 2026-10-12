import type { MsgContext } from "./templating.js";

const REQUESTER_PROFILE = Symbol("openclaw.requesterProfile");

export type PreparedRequesterProfile = Readonly<{
  id: string;
  displayName: string | null;
  isCurrent: () => boolean;
}>;

function requesterBinding(context: MsgContext) {
  return [
    context.SenderId,
    context.AccountId,
    context.Provider,
    context.Surface,
    context.OriginatingChannel,
  ] as const;
}

class RequesterProfile {
  readonly #profile: PreparedRequesterProfile;
  readonly #binding: ReturnType<typeof requesterBinding>;

  constructor(context: MsgContext, profile: PreparedRequesterProfile) {
    this.#profile = Object.freeze({ ...profile });
    this.#binding = Object.freeze(requesterBinding(context));
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(value: unknown, context: MsgContext): PreparedRequesterProfile | undefined {
    if (typeof value !== "object" || value === null || !(#profile in value)) {
      return undefined;
    }
    const binding = requesterBinding(context);
    return value.#binding.every((part, index) => part === binding[index]) &&
      value.#profile.isCurrent()
      ? value.#profile
      : undefined;
  }
}

/** Host-only, live identity fact: survives context copies, never JSON or plugin-authored fields. */
export function bindRequesterProfile(context: MsgContext, profile: PreparedRequesterProfile): void {
  Object.assign(context, { [REQUESTER_PROFILE]: new RequesterProfile(context, profile) });
}

export function getRequesterProfile(context: MsgContext): PreparedRequesterProfile | undefined {
  return RequesterProfile.read(Reflect.get(context, REQUESTER_PROFILE), context);
}

import { AsyncLocalStorage } from "node:async_hooks";
import { getCommandSenderAuthority } from "./command-sender-authority.js";
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
  // Only the primitive hook observation reads in ingress context; authority readers stay ambient.
  readonly #sourceContext = AsyncLocalStorage.snapshot();

  constructor(context: MsgContext, profile: PreparedRequesterProfile) {
    this.#profile = Object.freeze({ ...profile });
    this.#binding = requesterBinding(context);
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static captureId(value: unknown, context: MsgContext): (() => string | undefined) | undefined {
    if (typeof value !== "object" || value === null || !(#profile in value)) {
      return undefined;
    }
    const commandSender = getCommandSenderAuthority(context);
    return () =>
      value.#sourceContext(() => {
        const id = RequesterProfile.read(value, context)?.id;
        return !commandSender || commandSender() === id ? id : undefined;
      });
  }

  static read(value: unknown, context?: MsgContext): PreparedRequesterProfile | undefined {
    if (typeof value !== "object" || value === null || !(#profile in value)) {
      return undefined;
    }
    const binding = context && requesterBinding(context);
    return (!binding || value.#binding.every((part, index) => part === binding[index])) &&
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

/** Preserve the existing host binding and its live checks across non-message projections. */
export function captureRequesterProfileId(
  context: MsgContext,
): (() => string | undefined) | undefined {
  return RequesterProfile.captureId(Reflect.get(context, REQUESTER_PROFILE), context);
}

/** Transfer verified ingress identity to its runtime carrier, never serialized requester facts. */
export function transferRequesterProfile(context: MsgContext, carrier: object): void {
  if (getRequesterProfile(context)) {
    Object.assign(carrier, { [REQUESTER_PROFILE]: Reflect.get(context, REQUESTER_PROFILE) });
  }
}

export function readTransferredRequesterProfile(
  carrier: object,
): PreparedRequesterProfile | undefined {
  return RequesterProfile.read(Reflect.get(carrier, REQUESTER_PROFILE));
}

import type {
  AdmittedRunOperatorAuthority,
  OperationalRunInstanceRef,
} from "../agents/admitted-run-context.js";
import type { MsgContext } from "./templating.js";

const REQUESTER_PROFILE = Symbol("openclaw.requesterProfile");
const unlinkedChannelRuns = new WeakMap<OperationalRunInstanceRef, () => void>();

export type PreparedRequesterProfile = Readonly<{
  id: string;
  displayName: string | null;
  operatorAuthority?: AdmittedRunOperatorAuthority;
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

type PreparedRequesterIdentity =
  | PreparedRequesterProfile
  | Readonly<{ originallyUnlinked: true; isCurrent: () => boolean }>;

class RequesterProfile {
  readonly #profile: PreparedRequesterIdentity;
  readonly #binding: ReturnType<typeof requesterBinding>;
  #run?: OperationalRunInstanceRef;

  constructor(context: MsgContext, profile: PreparedRequesterIdentity) {
    this.#profile = Object.freeze({ ...profile });
    this.#binding = requesterBinding(context);
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(value: unknown, context?: MsgContext): PreparedRequesterIdentity | undefined {
    if (typeof value !== "object" || value === null || !(#profile in value)) {
      return undefined;
    }
    const binding = context && requesterBinding(context);
    return (!binding || value.#binding.every((part, index) => part === binding[index])) &&
      value.#profile.isCurrent()
      ? value.#profile
      : undefined;
  }

  static transferUnlinked(context: MsgContext, carrier: object): void {
    const value: unknown = Reflect.get(context, REQUESTER_PROFILE);
    const identity = RequesterProfile.read(value, context);
    if (
      !identity ||
      !("originallyUnlinked" in identity) ||
      context.SenderIsBot === true ||
      context.InternalTurnSource !== undefined ||
      (context.InputProvenance && context.InputProvenance.kind !== "external_user")
    ) {
      return;
    }
    Object.assign(carrier, { [REQUESTER_PROFILE]: value });
  }

  static admitUnlinked(
    carrier: object,
    run: OperationalRunInstanceRef,
    assertRunCurrent: () => void,
  ) {
    const value: unknown = Reflect.get(carrier, REQUESTER_PROFILE);
    if (value === null || typeof value !== "object" || !(#profile in value)) {
      return;
    }
    const identity = value.#profile;
    if (
      !("originallyUnlinked" in identity) ||
      !identity.isCurrent() ||
      (value.#run && value.#run !== run)
    ) {
      return;
    }
    value.#run = run;
    unlinkedChannelRuns.set(run, () => {
      assertRunCurrent();
      if (!identity.isCurrent()) {
        throw new Error("Original channel requester is no longer current.");
      }
    });
  }
}

/** Host-only, live identity fact: survives context copies, never JSON or plugin-authored fields. */
export function bindRequesterProfile(context: MsgContext, profile: PreparedRequesterProfile): void {
  Object.assign(context, { [REQUESTER_PROFILE]: new RequesterProfile(context, profile) });
}

export function getRequesterProfile(context: MsgContext): PreparedRequesterProfile | undefined {
  const identity = RequesterProfile.read(Reflect.get(context, REQUESTER_PROFILE), context);
  return identity && "id" in identity ? identity : undefined;
}

/** Transfer ingress identity to its runtime carriers, never serialized requester facts. */
export function transferRequesterProfile(
  context: MsgContext,
  carrier: object,
  unlinkedRun?: object,
): void {
  if (getRequesterProfile(context)) {
    Object.assign(carrier, { [REQUESTER_PROFILE]: Reflect.get(context, REQUESTER_PROFILE) });
  }
  if (unlinkedRun) {
    RequesterProfile.transferUnlinked(context, unlinkedRun);
  }
}

export function readTransferredRequesterProfile(
  carrier: object,
): PreparedRequesterProfile | undefined {
  const identity = RequesterProfile.read(Reflect.get(carrier, REQUESTER_PROFILE));
  return identity && "id" in identity ? identity : undefined;
}

/** Ingress resolved this exact authenticated sender/account and found no linked profile. */
export function bindUnlinkedChannelRequester(context: MsgContext, isCurrent: () => boolean): void {
  Object.assign(context, {
    [REQUESTER_PROFILE]: new RequesterProfile(context, { originallyUnlinked: true, isCurrent }),
  });
}

/** The finding belongs to one admitted run, never its children or later system turns. */
export function admitUnlinkedChannelRequester(
  carrier: object,
  run: OperationalRunInstanceRef,
  assertRunCurrent: () => void,
): void {
  RequesterProfile.admitUnlinked(carrier, run, assertRunCurrent);
}

export function readAdmittedUnlinkedChannelRequester(
  run: OperationalRunInstanceRef | undefined,
): (() => void) | undefined {
  return run ? unlinkedChannelRuns.get(run) : undefined;
}

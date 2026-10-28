import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { ChannelRunAuthorizationError } from "./run-authorization-error.js";

const PUBLICATION = Symbol("openclaw.childSessionPublication");
const runs = new WeakMap<OperationalRunInstanceRef, ChildSessionPublication>();

/** Host-only, single-run intent for fresh immediate children; never serialized into a session. */
export class ChildSessionPublication {
  #run?: OperationalRunInstanceRef;
  #assertRunCurrent?: () => void;
  #preparation?: Promise<void>;
  constructor(
    readonly requesterSessionKey: string,
    private assertSourceCurrent: () => void,
    private readonly prepareSource?: () => Promise<(() => void) | null>,
  ) {}

  prepare(): Promise<void> {
    return (this.#preparation ??= this.prepareSourceAuthorization());
  }

  private async prepareSourceAuthorization(): Promise<void> {
    try {
      if (this.#run) {
        throw new Error("An admitted publication cannot renew its source authority");
      }
      if (this.prepareSource) {
        let assertion: (() => void) | null;
        try {
          assertion = await this.prepareSource();
        } catch (error) {
          throw new ChannelRunAuthorizationError(error, "unavailable");
        }
        if (!assertion) {
          throw new ChannelRunAuthorizationError(
            new Error("Channel source authorization was rejected"),
          );
        }
        this.assertSourceCurrent = assertion;
      }
      this.assertSourceCurrent();
    } catch (error) {
      throw error instanceof ChannelRunAuthorizationError
        ? error
        : new ChannelRunAuthorizationError(error);
    }
  }

  bind(run: OperationalRunInstanceRef, assertRunCurrent: () => void): void {
    if (this.#run && this.#run !== run) {
      return;
    }
    this.assertSourceCurrent();
    this.#run = run;
    this.#assertRunCurrent = assertRunCurrent;
    runs.set(run, this);
  }

  assertCurrent(): void {
    if (!this.#run || !this.#assertRunCurrent) {
      throw new Error("Child publication requires an admitted source run.");
    }
    this.assertSourceCurrent();
    this.#assertRunCurrent();
  }

  claim(params: {
    sessionKey: string;
    entry: SessionEntry;
    parentSessionKey?: string;
    parent?: SessionEntry;
    isNew: boolean;
    fork?: boolean;
  }): void {
    this.assertCurrent();
    if (
      !params.isNew ||
      params.fork ||
      params.parentSessionKey !== this.requesterSessionKey ||
      params.sessionKey === this.requesterSessionKey ||
      !params.parent ||
      params.parent.incognito ||
      params.parent.visibility === "draft" ||
      isIncognitoSessionKey(this.requesterSessionKey) ||
      params.entry.incognito ||
      params.entry.visibility === "draft" ||
      isIncognitoSessionKey(params.sessionKey)
    ) {
      throw new Error("Public ingress can publish only its fresh isolated, non-private child.");
    }
  }
}

export function bindChildSessionPublication(
  context: object,
  requesterSessionKey: string,
  assertCurrent: () => void,
  prepare?: () => Promise<(() => void) | null>,
): void {
  Object.assign(context, {
    [PUBLICATION]: new ChildSessionPublication(requesterSessionKey, assertCurrent, prepare),
  });
}

export async function prepareChildSessionPublication(context: object): Promise<void> {
  const publication: unknown = Reflect.get(context, PUBLICATION);
  if (publication instanceof ChildSessionPublication) {
    await publication.prepare();
  }
}

export function copyChildSessionPublication(source: object, destination: object): void {
  const publication: unknown = Reflect.get(source, PUBLICATION);
  if (publication instanceof ChildSessionPublication) {
    Object.assign(destination, { [PUBLICATION]: publication });
  }
}

export function admitChildSessionPublication(
  context: object,
  run: OperationalRunInstanceRef,
  assertRunCurrent: () => void,
): void {
  const publication: unknown = Reflect.get(context, PUBLICATION);
  if (publication instanceof ChildSessionPublication) {
    publication.bind(run, assertRunCurrent);
  }
}

export function readChildSessionPublication(
  run: OperationalRunInstanceRef | undefined,
): ChildSessionPublication | undefined {
  return run ? runs.get(run) : undefined;
}

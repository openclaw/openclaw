import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";

const PUBLICATION = Symbol("openclaw.childSessionPublication");
const runs = new WeakMap<OperationalRunInstanceRef, ChildSessionPublication>();

/** Host-only, single-run intent for fresh immediate children; never serialized into a session. */
export class ChildSessionPublication {
  #run?: OperationalRunInstanceRef;
  #assertRunCurrent?: () => void;
  constructor(
    readonly requesterSessionKey: string,
    private readonly assertSourceCurrent: () => void,
  ) {}

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
): void {
  Object.assign(context, {
    [PUBLICATION]: new ChildSessionPublication(requesterSessionKey, assertCurrent),
  });
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

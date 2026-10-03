import type { SqliteWorkerEphemeralTarget } from "../../infra/sqlite-worker-contract.js";
import { forkCliSessionBindings } from "./cli-session-binding.js";
import type { createIncognitoSessionFacts } from "./session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoLifecycleEntry } from "./session-incognito-lifecycle-contract.js";
import type { SessionEntry } from "./types.js";

type IncognitoForkActor = {
  readonly identity: Readonly<SqliteWorkerEphemeralTarget>;
  readonly sessions: Pick<
    ReturnType<ReturnType<typeof createIncognitoSessionFacts>["bind"]>,
    "captureCurrent" | "read" | "lifecycle"
  >;
  assertCurrent(): void;
};

/** Source preparation settles before reserving the destination actor, including cross-agent forks. */
export async function forkIncognitoSessionFromParent(params: {
  source: IncognitoForkActor;
  destination: IncognitoForkActor;
  sourceAuthority: IncognitoSessionAuthority;
  destinationAuthority: IncognitoSessionAuthority;
  parent: IncognitoLifecycleEntry;
  childSessionKey: string;
  forkFrom?: "last-completed";
  supportsCliSessionFork: (provider: string) => boolean;
  buildEntry: (parent: SessionEntry, current: SessionEntry | undefined) => Promise<SessionEntry>;
  signal?: AbortSignal;
}): Promise<SessionEntry | undefined> {
  const { source, destination, sourceAuthority, destinationAuthority, signal } = params;
  source.assertCurrent();
  destination.assertCurrent();
  sourceAuthority.assertCurrent();
  destinationAuthority.assertCurrent();
  const parent = structuredClone(params.parent);
  const childSessionKey = params.childSessionKey;
  const sourceClaim = source.sessions.captureCurrent(parent.sessionKey);
  const sameActor =
    source.identity.handle === destination.identity.handle &&
    source.identity.incarnation === destination.identity.incarnation;
  const prepared = await source.sessions.lifecycle(
    sourceAuthority,
    {
      type: "session.lifecycle.fork.prepare",
      input: { parent, forkFrom: params.forkFrom },
    },
    signal,
  );
  sourceClaim.assertCurrent();
  destination.assertCurrent();
  if (!prepared) {
    return undefined;
  }
  const child = await destination.sessions.read(
    destinationAuthority,
    { sessionKey: childSessionKey },
    signal,
  );
  sourceClaim.assertCurrent();
  const entry = await params.buildEntry(
    structuredClone(parent.entry),
    structuredClone(child.entry),
  );
  const cliSessionBindings = forkCliSessionBindings(parent.entry, params.supportsCliSessionFork);
  sourceClaim.assertCurrent();
  child.claim.assertCurrent();
  // Same-actor row/version checks execute in its transaction. Asking the host's
  // pending projection to authorize that transaction would deadlock/refuse itself.
  const authority: IncognitoSessionAuthority = {
    assertCurrent() {
      source.assertCurrent();
      destination.assertCurrent();
      sourceAuthority.assertCurrent();
      destinationAuthority.assertCurrent();
      if (!sameActor) {
        sourceClaim.assertCurrent();
      }
    },
    authorize(stage, facts) {
      if (!sameActor) {
        sourceClaim.authorize(sourceAuthority, stage);
      }
      if (sameActor && facts.sessionKey === parent.sessionKey) {
        return sourceAuthority.authorize?.(stage, facts);
      }
      return destinationAuthority.authorize?.(stage, facts);
    },
  };
  return destination.sessions.lifecycle(
    authority,
    {
      type: "session.lifecycle.fork",
      input: {
        parent: prepared,
        child: { sessionKey: childSessionKey, entry, expectedEntry: child.entry },
        cliSessionBindings,
      },
    },
    signal,
  );
}

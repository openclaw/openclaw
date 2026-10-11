import { randomUUID } from "node:crypto";
import type { SqliteSourceFenceIdentity } from "../infra/sqlite-source-fence-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type { GitHubPublicationSourceSelector } from "../state/github-publication-source.types.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { observeUserGitHubConnectionAuthority } from "../state/user-github-connection-events.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";

const { destinationIncarnations } = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPublicationSourceCapabilities"),
  () => ({
    destinationIncarnations: new WeakMap<object, string>(),
  }),
);

/** A host-minted capability; serialized predicates alone never authorize publication. */
export type GitHubPublicationSourceCapability = Readonly<{
  version: 1;
  release(): Promise<void>;
}>;

/** Host policy executes before reservation; the worker rechecks every durable source fact. */
export async function prepareGitHubPublicationSource(params: {
  sourcePath: string;
  selector: GitHubPublicationSourceSelector;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<GitHubPublicationSourceCapability> {
  params.signal.throwIfAborted();
  params.assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  const physical = readDatabasePathIdentitySync(params.sourcePath);
  if (!physical.key.startsWith("file:") || physical.birthtime === undefined) {
    throw new Error("GitHub publication requires an admitted durable source.");
  }
  const closed = new AbortController();
  const signal = AbortSignal.any([params.signal, closed.signal]);
  const releases: Array<() => void> = [];
  let releasing: Promise<void> | undefined;
  const revoke = () => closed.abort(new Error("GitHub publication source authority changed."));
  const drain = async () => {
    revoke();
  };
  const release = () =>
    (releasing ??= (async () => {
      await drain();
      for (const stop of releases.splice(0).toReversed()) {
        stop();
      }
    })());
  const assertCurrent = () => {
    signal.throwIfAborted();
    context.admission.assertCurrent();
    assertExistingDatabaseIdentity(params.sourcePath, physical.key, physical.birthtime);
  };
  const sourceIdentity: SqliteSourceFenceIdentity = { physical, incarnation: randomUUID() };
  releases.push(
    registerOpenClawAgentDatabaseAsyncResource({
      agentId: params.selector.agentId,
      path: params.sourcePath,
      revoke,
      close: drain,
    }),
    registerOpenClawStateDatabaseAsyncResource({ close: drain }),
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind !== "opened" && event.path === context.admission.databasePath) {
        revoke();
      }
    }),
    onUserProfilesChanged(revoke),
    observeUserGitHubConnectionAuthority(({ databasePath, changedOwners }) => {
      if (
        databasePath === context.admission.databasePath &&
        params.selector.personalOwnerProfileId !== undefined &&
        changedOwners.includes(params.selector.personalOwnerProfileId)
      ) {
        revoke();
      }
    }),
    githubPublicationReceipts.subscribeFacts((change) => {
      if (
        (change.kind === "unknown" && change.identity === context.admission.identity.key) ||
        (change.kind === "committed" &&
          change.receipt.source.identity === context.admission.identity.key &&
          [...change.receipt.facts.values()].some((fact) => fact.kind !== "postimage"))
      ) {
        revoke();
      }
    }),
    sessionChanges.subscribeFacts((change) => {
      if ("all" in change || change.sessionKey === params.selector.sessionKey) {
        revoke();
      }
    }),
  );
  try {
    let incarnation = destinationIncarnations.get(context.admission);
    if (!incarnation) {
      incarnation = randomUUID();
      destinationIncarnations.set(context.admission, incarnation);
    }
    const sourceRead = {
      source: sourceIdentity,
      destination: { physical: context.admission.identity, incarnation },
      selector: structuredClone(params.selector),
    };
    await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({ type: "githubPublication.sourceFacts", input: { source: sourceRead } }),
      { signal, assertCurrent },
    );
    // Policy callbacks may write SQLite. Such a write revokes this captured basis.
    params.assertCurrent();
    assertCurrent();
    const capability: GitHubPublicationSourceCapability = Object.freeze({ version: 1, release });
    return capability;
  } catch (error) {
    await release();
    throw error;
  }
}

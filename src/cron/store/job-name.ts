import { toUSVString } from "node:util";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { resolveCronJobsStorePath } from "./paths.js";

type PreparedNames = {
  context: OpenClawStateWorkerContext;
  storeKey?: string;
  jobIds: string[];
  revision: number;
  names?: ReadonlyMap<string, string | undefined>;
};

// Live views retain their resolver; the mutation owner does not retain completed requests.
const preparedNames = new Set<WeakRef<PreparedNames>>();
const releasedNames = new FinalizationRegistry<WeakRef<PreparedNames>>((reference) => {
  preparedNames.delete(reference);
});

function* retainedNames(storeKey?: string) {
  for (const reference of preparedNames) {
    const prepared = reference.deref();
    if (!prepared) {
      preparedNames.delete(reference);
    } else if (
      storeKey === undefined ||
      prepared.storeKey === undefined ||
      prepared.storeKey === storeKey
    ) {
      yield prepared;
    }
  }
}

/** All cron commit notifications invalidate names, including uncertain outcomes and repairs. */
export function invalidateCronJobNames(storeKey?: string): void {
  for (const prepared of retainedNames(storeKey)) {
    prepared.revision++;
    prepared.names = undefined;
  }
}

/** Publish only acknowledged postimages belonging to a resolver's original physical generation. */
export function publishCronJobNames(
  storeKey: string,
  context: OpenClawStateWorkerContext,
  names: ReadonlyMap<string, string | undefined>,
): void {
  for (const prepared of retainedNames(storeKey)) {
    if (prepared.storeKey !== storeKey) {
      continue;
    }
    try {
      context.admission.assertCurrent();
      prepared.context.admission.assertCurrent();
    } catch {
      // Retired views remain unusable; a committed result never revives their admission.
      continue;
    }
    const source = context.admission.identity;
    const target = prepared.context.admission.identity;
    if (source.key !== target.key || source.birthtime !== target.birthtime) {
      continue;
    }
    prepared.revision++;
    prepared.names = new Map(prepared.jobIds.map((id) => [id, names.get(id)]));
  }
}

export async function prepareCronJobNameResolver(jobIds: string[], storePath?: string) {
  const ids = [...new Set(jobIds.map(toUSVString))];
  if (ids.length === 0) {
    return () => {
      throw new Error("Cron job names were not prepared; await prepareCronJobNameResolver");
    };
  }
  const prepared: PreparedNames = {
    context: captureOpenClawStateReadWorkerContext(),
    // Default selection reads machine state in the worker; explicit paths need no SQL.
    storeKey: storePath?.trim() ? resolveCronJobsStorePath(storePath) : undefined,
    jobIds: ids,
    revision: 0,
  };
  const reference = new WeakRef(prepared);
  preparedNames.add(reference);
  releasedNames.register(prepared, reference);
  try {
    const reply = await executeExistingOpenClawStateRead(
      { path: prepared.context.admission.databasePath },
      { type: "cron.jobNames", jobIds: ids, storePath: prepared.storeKey },
      { context: prepared.context, current: true },
    );
    if (reply && (!reply.ok || reply.type !== "cron.jobNames")) {
      throw new Error("Unexpected cron job names result");
    }
    prepared.context.admission.assertCurrent();
    prepared.storeKey = reply?.storeKey ?? prepared.storeKey;
    if (prepared.revision === 0) {
      prepared.names = new Map(ids.map((id) => [id, reply?.names.get(id)]));
    }
    return (jobId: string) => {
      prepared.context.admission.assertCurrent();
      const id = toUSVString(jobId);
      if (!prepared.names?.has(id)) {
        throw new Error("Cron job names need refresh; await prepareCronJobNameResolver");
      }
      return prepared.names.get(id);
    };
  } catch (error) {
    preparedNames.delete(reference);
    throw error;
  }
}

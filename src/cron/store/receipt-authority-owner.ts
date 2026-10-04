import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { acquireFileLock, type FileLockHandle } from "../../infra/file-lock.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { AsyncWorkScope, runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { CronReceiptAuthorityRefusal } from "./receipt-authority-error.js";
import type {
  CronReceiptAuthorityAttachment,
  CronReceiptAuthorityPublication,
} from "./receipt-authority.types.js";
import type {
  CronRunReceiptCurrentFacts,
  CronRunReceiptCurrentReadCommand,
} from "./run-receipt.types.js";

type Observation = {
  command: CronRunReceiptCurrentReadCommand;
  facts: CronRunReceiptCurrentFacts;
  admittedEnabled: boolean;
  messageRevoked: boolean;
  sourceRevoked: boolean;
  retired: boolean;
  ready: boolean;
};
type AuthorityOwner = {
  context: Pick<OpenClawStateWorkerContext, "admission" | "assertPublicationCurrent">;
  custody: Promise<FileLockHandle>;
  work: AsyncWorkScope;
  closing: boolean;
  closed: boolean;
  tail: Promise<void>;
  pending: Set<string>;
  observations: Set<Observation>;
  uses: Set<{ observation: Observation; retire: () => void }>;
  failure?: unknown;
};

export type CronReceiptAuthorityUse = {
  assertCurrent: () => void;
  /** Invoke only the synchronous native initiation, never an async preparation wrapper. */
  initiate: <T>(effect: () => T) => T;
  release: () => void;
  /** Other database owners keep this interval until their accepted write settles. */
  persist: <T>(run: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
  /** Borrow this exact gate for consumption; accepted persistence settles before release. */
  mutate: <T>(run: (mutation: CronReceiptAuthorityMutation) => Promise<T>) => Promise<T>;
};

type UseOptions = {
  permission: "message" | "source" | "execution";
  assertCurrent: (facts: CronRunReceiptCurrentFacts) => void;
  signal?: AbortSignal;
};
const lifetime = resolveGlobalSingleton(Symbol.for("openclaw.cron.receiptAuthority"), () => ({
  owners: new Map<string, AuthorityOwner>(),
  closing: false,
}));
const { owners } = lifetime;

function unavailable(): Error {
  return new Error(
    "Cron receipt authority is unavailable; wait for Gateway settlement or restart.",
  );
}

function assertOwner(owner: AuthorityOwner, context?: OpenClawStateWorkerContext): void {
  (owner.context.assertPublicationCurrent ?? owner.context.admission.assertCurrent)();
  context?.admission.assertCurrent();
  if (
    owner.closed ||
    owner.failure ||
    (context && context.admission.coordinationKey !== owner.context.admission.coordinationKey)
  ) {
    throw unavailable();
  }
}

function ownerFor(context: OpenClawStateWorkerContext): AuthorityOwner {
  context.admission.assertCurrent();
  const key = context.admission.coordinationKey;
  const previous = owners.get(key);
  if (previous) {
    assertOwner(previous, context);
    return previous;
  }
  if (lifetime.closing) {
    throw unavailable();
  }
  if (
    (statSync(context.admission.identity.canonicalPath, { throwIfNoEntry: false })?.nlink ?? 0) > 1
  ) {
    throw new Error(
      "Cron authority does not support hardlinked databases; remove aliases during offline maintenance.",
    );
  }
  const admittedSource = context.admission;
  const owner: AuthorityOwner = {
    context: {
      admission: admittedSource,
      assertPublicationCurrent: context.assertPublicationCurrent,
    },
    custody: acquireFileLock(`${context.admission.identity.canonicalPath}.cron-authority`, {
      retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
      stale: 0,
      staleRecovery: "remove-if-definitely-stale",
    }),
    work: new AsyncWorkScope(),
    closing: false,
    closed: false,
    tail: Promise.resolve(),
    pending: new Set(),
    observations: new Set(),
    uses: new Set(),
  };
  // Custody belongs to this host, so losing a SQLite worker cannot release it.
  void owner.custody.catch((error: unknown) => {
    owner.failure = error;
  });
  owners.set(key, owner);
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (identity && identity.key !== admittedSource.identity.key) {
        return;
      }
      owner.closing = true;
      for (const use of owner.uses) {
        use.retire();
      }
      await owner.work.drain();
      if (owner.pending.size > 0) {
        throw unavailable();
      }
      // Failed acquisition never entered a writer; only release custody we actually obtained.
      const custody = await owner.custody.catch(() => undefined);
      await custody?.release();
      owner.closed = true;
      owner.observations.clear();
      if (owners.get(key) === owner) {
        owners.delete(key);
      }
      unregister();
    },
  });
  return owner;
}

/** Seal effects synchronously before the Gateway scheduler aborts its own work scope. */
export function beginCronReceiptAuthorityClose(): void {
  lifetime.closing = true;
  for (const owner of owners.values()) {
    owner.closing = true;
    for (const use of owner.uses) {
      use.retire();
    }
  }
}

/** A new serving lifetime follows complete retirement of the previous authority host. */
export function startCronReceiptAuthorityHost(): void {
  if (lifetime.closing && owners.size > 0) {
    throw unavailable();
  }
  lifetime.closing = false;
}

/** The database resource owner releases physical custody only after this drain. */
export async function drainCronReceiptAuthority(): Promise<void> {
  for (const owner of owners.values()) {
    if (!owner.closing) {
      continue;
    }
    await AsyncWorkScope.runWhenAllIdle(
      () => [owner.work],
      () => undefined,
    );
    if (owner.pending.size > 0) {
      throw unavailable();
    }
  }
}

function queue<T>(owner: AuthorityOwner, operation: () => Promise<T>): Promise<T> {
  const previous = owner.tail;
  const released = createDeferredCore();
  owner.tail = previous.then(() => released.promise);
  // Accepted persistence owns settlement independently of its scheduler's abort signal.
  return runOutsideAsyncWorkScope(() =>
    owner.work.track(async () => {
      try {
        await previous;
        await owner.custody;
        assertOwner(owner);
        return await operation();
      } finally {
        released.resolve();
      }
    }),
  );
}

function install(observation: Observation, facts: CronRunReceiptCurrentFacts): void {
  const expected = observation.command.handle;
  const receipt = facts.receipt;
  const oldJob = observation.facts.job;
  const job = facts.job;
  observation.retired ||=
    !receipt ||
    receipt.receiptId !== expected.receiptId ||
    receipt.ownerPid !== expected.ownerPid ||
    receipt.ownerStartTime !== expected.ownerStartTime ||
    receipt.storeKey !== expected.storeKey ||
    receipt.jobId !== expected.jobId ||
    receipt.agentId !== expected.agentId ||
    facts.deletionBlocked ||
    !job;
  observation.messageRevoked ||=
    observation.retired ||
    (observation.admittedEnabled && !job?.enabled) ||
    !isDeepStrictEqual(oldJob?.messageToolAuthorityInputs, job?.messageToolAuthorityInputs);
  observation.sourceRevoked ||=
    observation.messageRevoked ||
    !isDeepStrictEqual(oldJob?.messageActionAuthorityInputs, job?.messageActionAuthorityInputs);
  observation.facts = facts;
}

function acquireUse(
  owner: AuthorityOwner,
  context: OpenClawStateWorkerContext,
  observation: Observation,
  expectedReceipt: CronRunReceiptCurrentFacts["receipt"],
  options: UseOptions,
): Promise<CronReceiptAuthorityUse> {
  if (owner.closing || observation.retired) {
    return Promise.reject(new CronReceiptAuthorityRefusal("retired"));
  }
  const acquired = createDeferredCore<CronReceiptAuthorityUse>();
  const released = createDeferredCore();
  let ended: CronReceiptAuthorityRefusal | undefined;
  let borrowing = false;
  const finish = () => {
    if (!borrowing) {
      released.resolve();
    }
  };
  const retire = () => {
    ended ??= new CronReceiptAuthorityRefusal("retired");
    finish();
  };
  const entry = { observation, retire };
  owner.uses.add(entry);
  options.signal?.addEventListener("abort", retire, { once: true });
  const assertAuthority = () => {
    if (ended) {
      throw ended;
    }
    try {
      assertOwner(owner, context);
      options.signal?.throwIfAborted();
      if (owner.closing || observation.retired) {
        throw new CronReceiptAuthorityRefusal("retired");
      }
      const facts = observation.facts;
      if (
        !expectedReceipt ||
        !isDeepStrictEqual(facts.receipt, expectedReceipt) ||
        !facts.job ||
        facts.job.id !== expectedReceipt.jobId ||
        !facts.job.hasCanonicalDeliveryMode ||
        facts.deletionBlocked
      ) {
        throw new CronReceiptAuthorityRefusal("retired");
      }
      if (
        (options.permission !== "execution" &&
          (observation.messageRevoked || !facts.job.messageToolAuthorityInputs)) ||
        (options.permission === "source" &&
          (observation.sourceRevoked || !facts.job.messageActionAuthorityInputs))
      ) {
        throw new CronReceiptAuthorityRefusal("permission");
      }
      options.assertCurrent(facts);
    } catch (error) {
      ended =
        error instanceof CronReceiptAuthorityRefusal
          ? error
          : new CronReceiptAuthorityRefusal("unavailable", { cause: error });
      finish();
      throw ended;
    }
  };
  const assertCurrent = () => {
    assertAuthority();
    if (borrowing || owner.pending.size > 0) {
      throw new CronReceiptAuthorityRefusal("busy");
    }
  };
  const release = () => {
    ended ??= new CronReceiptAuthorityRefusal("spent");
    finish();
  };
  const use: CronReceiptAuthorityUse = {
    assertCurrent,
    release,
    async persist(run) {
      assertCurrent();
      borrowing = true;
      try {
        return await runOutsideAsyncWorkScope(() => owner.work.track(() => run(assertAuthority)));
      } finally {
        borrowing = false;
        release();
      }
    },
    initiate(effect) {
      try {
        assertCurrent();
        // Spend before invoking user code, including reentrant initiation and thrown launches.
        ended = new CronReceiptAuthorityRefusal("spent");
        return effect();
      } finally {
        release();
      }
    },
    async mutate(run) {
      assertCurrent();
      borrowing = true;
      try {
        return await runOutsideAsyncWorkScope(() =>
          executeMutation(owner, context, async (mutation) =>
            run({
              ...mutation,
              assertCurrent() {
                assertAuthority();
                mutation.assertCurrent();
              },
            }),
          ),
        );
      } catch (error) {
        retire();
        throw error;
      } finally {
        borrowing = false;
        if (ended) {
          finish();
        }
      }
    },
  };
  void queue(owner, async () => {
    assertAuthority();
    await rebuild(owner, context, [observation]);
    assertCurrent();
    acquired.resolve(use);
    await released.promise;
  })
    .catch((error: unknown) => {
      acquired.reject(
        error instanceof CronReceiptAuthorityRefusal
          ? error
          : new CronReceiptAuthorityRefusal("unavailable", { cause: error }),
      );
    })
    .finally(() => {
      owner.uses.delete(entry);
      options.signal?.removeEventListener("abort", retire);
    });
  return acquired.promise;
}

/** Bind only a newly committed local occurrence; startup snapshots never recreate capabilities. */
export function observeCronReceiptAuthority(
  context: OpenClawStateWorkerContext,
  command: CronRunReceiptCurrentReadCommand,
  facts: CronRunReceiptCurrentFacts,
) {
  const owner = ownerFor(context);
  let observation = [...owner.observations].find((entry) =>
    isDeepStrictEqual(entry.command.handle, command.handle),
  );
  const admitted = observation !== undefined;
  observation ??= {
    command: structuredClone(command),
    facts: structuredClone(facts),
    admittedEnabled: facts.job?.enabled === true,
    messageRevoked: false,
    sourceRevoked: false,
    retired: false,
    ready: false,
  };
  owner.observations.add(observation);
  const selected = observation;
  const expectedReceipt = structuredClone(facts.receipt);
  const prepared = admitted
    ? Promise.resolve()
    : queue(owner, async () => {
        await rebuild(owner, context, [selected]);
        selected.ready = true;
      });
  void prepared.catch(() => {
    observation.retired = true;
  });
  return {
    prepared,
    release() {
      observation.retired = true;
      for (const use of owner.uses) {
        if (use.observation === observation) {
          use.retire();
        }
      }
      owner.observations.delete(observation);
    },
    acquireUse(options: UseOptions) {
      return acquireUse(owner, context, selected, expectedReceipt, options);
    },
    readForPreparation() {
      assertOwner(owner);
      (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
      if (!observation.ready || owner.closing || owner.pending.size > 0 || observation.retired) {
        throw unavailable();
      }
      return {
        facts: observation.facts,
        messageRevoked: observation.messageRevoked,
        sourceRevoked: observation.sourceRevoked,
      };
    },
  };
}

/** Called by activation publication while its writer still owns the authority gate. */
export function publishCronReceiptAuthorityAdmission(
  context: OpenClawStateWorkerContext,
  command: CronRunReceiptCurrentReadCommand,
  facts: CronRunReceiptCurrentFacts,
): void {
  const owner = ownerFor(context);
  if (owner.pending.size === 0) {
    throw new Error("Cron receipt admission requires its held publication gate");
  }
  owner.observations.add({
    command: structuredClone(command),
    facts: structuredClone(facts),
    admittedEnabled: facts.job?.enabled === true,
    messageRevoked: false,
    sourceRevoked: false,
    retired: false,
    ready: true,
  });
}

async function rebuild(
  owner: AuthorityOwner,
  context: OpenClawStateWorkerContext,
  observations: Observation[],
): Promise<void> {
  for (const observation of observations) {
    const result = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      observation.command,
      { context, current: true },
    );
    assertOwner(owner, context);
    if (!result?.ok || result.type !== "cron.currentReceipt") {
      throw unavailable();
    }
    install(observation, result.facts);
    if (observation.retired) {
      owner.observations.delete(observation);
    }
  }
}

export type CronReceiptAuthorityMutation = {
  context: OpenClawStateWorkerContext;
  attachment: CronReceiptAuthorityAttachment;
  assertCurrent: () => void;
  observe: (
    admission: SqliteWorkerOperationAdmission,
    retained: RetainedWorkerTransactionAdmission,
  ) => void;
  publish: (facts: CronReceiptAuthorityPublication) => void;
};

/** All authority writers enroll before entering the shared-state broker or a native transaction. */
export function withCronReceiptAuthorityMutation<T>(
  context: OpenClawStateWorkerContext,
  run: (mutation: CronReceiptAuthorityMutation) => Promise<T>,
  options?: { settlement?: boolean },
): Promise<T> {
  const owner = ownerFor(context);
  if (owner.closing && !options?.settlement) {
    return Promise.reject(unavailable());
  }
  return queue(owner, () => executeMutation(owner, context, run, options));
}

function executeMutation<T>(
  owner: AuthorityOwner,
  context: OpenClawStateWorkerContext,
  run: (mutation: CronReceiptAuthorityMutation) => Promise<T>,
  options?: { settlement?: boolean },
): Promise<T> {
  const nonce = randomUUID();
  const capturedScope = context.runInCapturedSchemaScope;
  const persistenceContext = capturedScope
    ? {
        ...context,
        runInCapturedSchemaScope: <Value>(operation: () => Value): Value =>
          capturedScope(() => runOutsideAsyncWorkScope(() => owner.work.run(operation))),
      }
    : context;
  return owner.work.track(async () => {
    assertOwner(owner, context);
    const observations = [...owner.observations];
    const attachment = { nonce, reads: observations.map((entry) => entry.command) };
    const retained: Array<{
      admission: SqliteWorkerOperationAdmission;
      owner: RetainedWorkerTransactionAdmission;
    }> = [];
    let sequence = 0;
    let needsRebuild = false;
    owner.pending.add(nonce);
    const publish = (facts: CronReceiptAuthorityPublication) => {
      if (facts.nonce !== nonce || facts.sequence <= sequence) {
        return;
      }
      if (
        (facts.receipts && facts.receipts.length !== observations.length) ||
        facts.sequence !== sequence + 1
      ) {
        throw unavailable();
      }
      // Committed facts settle even after close sealed new effects.
      needsRebuild = true;
      assertOwner(owner);
      (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
      if (facts.receipts) {
        for (let index = 0; index < observations.length; index++) {
          install(observations[index]!, facts.receipts[index]!);
          if (observations[index]!.retired) {
            owner.observations.delete(observations[index]!);
          }
        }
        needsRebuild = false;
      }
      sequence = facts.sequence;
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = {
        ok: true,
        value: await run({
          context: persistenceContext,
          attachment,
          assertCurrent() {
            assertOwner(owner, context);
            if (owner.closing && !options?.settlement) {
              throw unavailable();
            }
          },
          publish,
          observe(admission, settlement) {
            retained.push({ admission, owner: settlement });
            observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
              if (!isRecord(facts) || !isRecord(facts.receiptAuthority)) {
                throw unavailable();
              }
              // SAFETY: The private command's canonical worker producer owns this envelope.
              publish(facts.receiptAuthority as CronReceiptAuthorityPublication);
            });
          },
        }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let nativeSettled = false;
    try {
      for (const operation of retained) {
        const settled = await operation.owner.settled;
        if (
          settled.kind === "unknown" &&
          !settled.nativeStopped &&
          operation.admission.settlement?.kind !== "completed"
        ) {
          throw new SqliteWorkerError(
            "Cron receipt writer has not confirmed native settlement or exit",
            "outcome-unknown",
          );
        }
        needsRebuild ||=
          settled.kind === "unknown" ||
          Boolean(operation.admission.failure) ||
          Boolean(operation.admission.committed && sequence === 0);
      }
      nativeSettled = true;
      if (needsRebuild) {
        // Native settlement/worker exit precedes this read. Never replay the mutation.
        await rebuild(owner, persistenceContext, observations);
      }
      owner.pending.delete(nonce);
    } catch (error) {
      const failure = Object.assign(
        new SqliteWorkerError("Cron receipt authority reconciliation failed", "outcome-unknown"),
        { cause: error },
      );
      owner.failure = failure;
      // Sealed read admission cannot rebuild, but settled writers still permit custody to close.
      if (nativeSettled) {
        owner.pending.delete(nonce);
      }
      throw failure;
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { captureOpenClawDatabaseMaintenanceAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { admitUpdateInitialStores } from "./update-initial-store-admission.js";

const text = z.string().min(1).max(4096);
const directory = z.strictObject({ path: text, identity: text });
const database = z.strictObject({
  databasePath: text,
  databaseIdentity: text,
  parentIdentity: text,
});
const invocationSchema = z.strictObject({
  version: z.literal(1),
  selection: z.strictObject({
    privateRoot: directory,
    installation: directory,
    handoff: database,
    state: database,
  }),
});

/** Internal explicit invocation input, never an executor or publication grant. */
export type UpdateInitialStoreInvocation = z.infer<typeof invocationSchema>;
type Admission = ReturnType<typeof admitUpdateInitialStores>;
const invocation = new AsyncLocalStorage<{
  admission: Admission;
  active: boolean;
  publishing?: boolean;
}>();

export function currentUpdateInitialStoreAdmission(): Admission | undefined {
  const current = invocation.getStore();
  if (current && !current.active) {
    throw new Error("Update initial store invocation has settled.");
  }
  if (current?.publishing) {
    throw new Error("Update store generation publication has not settled.");
  }
  return current?.admission;
}

/** Existing state selectors must agree; never silently redirect or restat a generation. */
export function assertUpdateInitialStoreInvocation(
  installationRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const admission = currentUpdateInitialStoreAdmission();
  if (!admission) {
    return;
  }
  admission.assertCurrent({
    installationRoot: installationRoot ?? admission.selection.installation.path,
    handoffPath: admission.selection.handoff.databasePath,
    statePath: resolveOpenClawStateSqlitePath(env),
  });
}

/** Scope only explicitly selected private invocations. Ordinary installs retain their selectors.
 * Processes/Workers must separately receive and admit their own input; this is not their proof.
 * The publication owner must retire the initial guard before issuing a successor generation.
 */
export async function withUpdateInitialStoreInvocation<T>(
  input: UpdateInitialStoreInvocation | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (input === undefined) {
    return run();
  }
  // Shape validation and the existing kernel both run before any callback/import/open.
  const parsed = invocationSchema.parse(input);
  const scope = { admission: admitUpdateInitialStores(parsed.selection), active: true };
  return invocation.run(scope, async () => {
    try {
      assertUpdateInitialStoreInvocation();
      return await run();
    } finally {
      scope.active = false;
      scope.admission.close();
    }
  });
}

/** Bridge the lexical caller to the publication owner's verified generation.
 * The executor owns exclusion and the retained native handoff; this scope neither
 * grants publication authority nor infers a generation from a filesystem restat. */
export async function publishUpdateInitialStoreGeneration(
  params: Parameters<
    typeof import("./update-recovery-generation-consumer.js").publishUpdateRecoveryGeneration
  >[0],
  lifecycle: { beforeRetire?: () => Promise<void>; onRetired: () => void },
) {
  const scope = invocation.getStore();
  const lexical = currentUpdateInitialStoreAdmission();
  const initial = params.initialStores;
  initial.assertCurrent();
  lexical?.assertCurrent();
  if (lexical && !isDeepStrictEqual(lexical.selection, initial.selection)) {
    throw new Error("Publication does not own the current invocation selection.");
  }
  const transaction = params.transaction;
  const publication = transaction.reversePublication;
  const assertAuthority = params.authority.assertCurrent.bind(params.authority);
  const assertMaintenance = captureOpenClawDatabaseMaintenanceAdmission(params.maintenance);
  const captured = {
    ...params,
    binding: structuredClone(params.binding),
    transaction: {
      ...transaction,
      reversePublication: publication && {
        resourceCustody: publication.resourceCustody.bind(publication),
        selection: publication.selection.bind(publication),
        prepare: publication.prepare.bind(publication),
        publish: publication.publish.bind(publication),
        settle: publication.settle.bind(publication),
        verifyCompletion: publication.verifyCompletion.bind(publication),
        commitCompletion: publication.commitCompletion.bind(publication),
      },
    },
    authority: {
      assertCurrent() {
        assertAuthority();
        assertMaintenance();
      },
      assertWritersSettled: params.authority.assertWritersSettled.bind(params.authority),
      validateTarget: params.authority.validateTarget.bind(params.authority),
      assertCapturedSource: params.authority.assertCapturedSource?.bind(params.authority),
    },
    beforeRetire: lifecycle.beforeRetire?.bind(lifecycle),
  };
  if (scope) {
    scope.publishing = true;
  }
  const { publishUpdateRecoveryGeneration } =
    await import("./update-recovery-generation-consumer.js");
  const result = await publishUpdateRecoveryGeneration({
    ...captured,
    initialStores: {
      ...initial,
      close() {
        initial.close();
        lexical?.close();
        lifecycle.onRetired();
      },
    },
  });
  try {
    if (scope) {
      if (!scope.active || scope.admission !== lexical) {
        throw new Error("Publication outlived its original invocation.");
      }
      scope.admission = admitUpdateInitialStores(result.admission.selection);
      scope.publishing = false;
    }
    return result;
  } catch (error) {
    result.admission.close();
    throw error;
  }
}

/** Original executor's forward package transition. The provider is selected here
 * from its real journal, never supplied as a caller-authored completion callback.
 * State and handoff identities are preserved; only the recorded candidate package
 * may replace the installation. This does not qualify reverse/state recovery. */
export async function publishUpdateInitialPackageGeneration(params: {
  initialStores: Admission;
  authority: import("./update-managed-service-handoff-database.js").ManagedUpdateLeaseDatabaseIdentity &
    Readonly<{ installKey: string; owner: string }>;
  runId: string;
  operationId: string;
  assertCurrent: () => void;
  onRetired: () => void;
  beforeRetire?: () => Promise<void>;
}) {
  const scope = invocation.getStore();
  const lexical = currentUpdateInitialStoreAdmission();
  const initial = params.initialStores;
  const authority = Object.freeze({ ...params.authority });
  const runId = params.runId;
  const operationId = params.operationId;
  const assertCurrent = params.assertCurrent.bind(params);
  const onRetired = params.onRetired.bind(params);
  const beforeRetire = params.beforeRetire?.bind(params);
  initial.assertCurrent();
  lexical?.assertCurrent();
  if (lexical && !isDeepStrictEqual(lexical.selection, initial.selection)) {
    throw new Error("Publication does not own the current invocation selection.");
  }
  assertCurrent();
  if (scope) {
    scope.publishing = true;
  }
  const { openPackageActivationJournal, resolvePackageActivationAnchor } =
    await import("./package-update-activation-journal.js");
  const { createPublicationOwner } = await import("./package-update-activation-owner.js");
  assertCurrent();
  const anchor = resolvePackageActivationAnchor(authority.installKey);
  const journal = openPackageActivationJournal(anchor);
  const record = journal.read();
  const descriptor = record.descriptor;
  if (
    record.phase !== "prepared" ||
    descriptor.reverse ||
    descriptor.operationId !== operationId ||
    descriptor.originalRunId !== runId ||
    !isDeepStrictEqual(descriptor.authority, authority) ||
    initial.selection.installation.path !== authority.installKey ||
    initial.selection.installation.identity !== descriptor.previous.identity
  ) {
    throw new Error("Forward publication does not own the prepared original generation.");
  }
  const owner = createPublicationOwner(anchor, journal, assertCurrent, record);
  await owner.preflight("repair");
  assertCurrent();
  initial.assertCurrent();
  lexical?.assertCurrent();
  journal.assertCurrent(record);
  await beforeRetire?.();
  assertCurrent();
  initial.assertCurrent();
  lexical?.assertCurrent();
  journal.assertCurrent(record);
  // Retire both old guards before any package effect. Native authority continues
  // against the exact original handoff inode/row throughout the displacement gap.
  initial.close();
  lexical?.close();
  onRetired();
  const completion = await owner.publish(false);
  await owner.preflight("repair");
  assertCurrent();
  const final = journal.read();
  if (
    completion.phase !== "publication-complete" ||
    final.phase !== "publication-complete" ||
    !isDeepStrictEqual(final.descriptor, descriptor)
  ) {
    throw new Error("Forward publication did not complete its recorded generation.");
  }
  owner.assertCurrent();
  const admission = admitUpdateInitialStores({
    ...initial.selection,
    installation: {
      path: authority.installKey,
      identity: descriptor.candidate.identity,
    },
  });
  try {
    assertCurrent();
    return {
      admission,
      completion,
      // The executor installs and validates its selected native store before
      // reopening lexical readers. No await separates that commit from ready.
      commitInvocation() {
        assertCurrent();
        admission.assertCurrent();
        if (scope) {
          if (!scope.active || scope.admission !== lexical || !scope.publishing) {
            throw new Error("Publication outlived its original invocation.");
          }
          scope.admission = admitUpdateInitialStores(admission.selection);
          scope.publishing = false;
        }
      },
    };
  } catch (error) {
    admission.close();
    throw error;
  }
}

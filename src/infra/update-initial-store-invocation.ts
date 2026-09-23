import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
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
const invocation = new AsyncLocalStorage<{ admission: Admission; active: boolean }>();

export function currentUpdateInitialStoreAdmission(): Admission | undefined {
  const current = invocation.getStore();
  if (current && !current.active) {
    throw new Error("Update initial store invocation has settled.");
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

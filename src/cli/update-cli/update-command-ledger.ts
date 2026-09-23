import { resolveConfigPath } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import {
  assertUpdateWriteAuthority,
  type FreeBsdUpdateWriteAdmission,
} from "../../infra/update-freebsd-write-admission.js";
import type { UpdateRunLedgerOptions } from "../../infra/update-run-codec.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

export type UpdateCommandLedgerRun = {
  runId: string;
  env: NodeJS.ProcessEnv;
  /** Local filesystem admission, retained through failure and terminal reporting. */
  freebsdWriteAdmission?: FreeBsdUpdateWriteAdmission;
  /** Invocation-owned database generation. Never serialized or reused by a receiver. */
  ledgerAdmission?: UpdateCommandLedgerAdmission;
};

type UpdateCommandLedgerAdmission = {
  options: (run: UpdateCommandLedgerRun) => UpdateRunLedgerOptions;
};

/** Capture this invocation's generation after adoption, before yielding to callers.
 * A fresh candidate captures its own binding; Doctor success never rebinds a parent. */
export function admitUpdateCommandLedger(run: UpdateCommandLedgerRun): void {
  const admission = run.freebsdWriteAdmission;
  if (!admission) {
    return;
  }
  assertUpdateWriteAuthority(admission, () => {
    if (run.ledgerAdmission) {
      throw new Error("Update ledger admission cannot be replaced.");
    }
    const runId = run.runId;
    const sourceEnv = run.env;
    const env = Object.freeze({ ...sourceEnv });
    const pathname = resolveOpenClawStateSqlitePath(env);
    const configPath = resolvePathViaExistingAncestorSync(resolveConfigPath(env));
    const identity = readDatabasePathIdentitySync(pathname);
    assertExistingDatabaseIdentity(pathname, identity.key);
    const options: UpdateRunLedgerOptions = {
      env,
      path: pathname,
      assertWriteAdmission: (selectedRunId, selected) =>
        assertUpdateWriteAuthority(admission, () => {
          if (
            run.runId !== runId ||
            selectedRunId !== runId ||
            run.env !== sourceEnv ||
            run.freebsdWriteAdmission !== admission ||
            selected.env !== env ||
            selected.path !== pathname ||
            resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(run.env)) !==
              identity.canonicalPath ||
            resolvePathViaExistingAncestorSync(resolveConfigPath(run.env)) !== configPath
          ) {
            throw new Error("Update ledger lost its admitted run or state selectors.");
          }
          assertExistingDatabaseIdentity(pathname, identity.key);
        }),
    };
    Object.freeze(options);
    run.ledgerAdmission = {
      options: (selectedRun) => {
        if (selectedRun !== run) {
          throw admission.revoke(new Error("Update ledger admission belongs to another run."));
        }
        return options;
      },
    };
  });
}

/** Only FreeBSD's admitted owner adds a fence; ordinary ledger callers stay unbound.
 * Keep the check in the writer as well, since prepared options can cross an await. */
export function updateCommandLedgerOptions(run: UpdateCommandLedgerRun): UpdateRunLedgerOptions {
  if (run.ledgerAdmission) {
    return run.ledgerAdmission.options(run);
  }
  if (run.freebsdWriteAdmission) {
    throw run.freebsdWriteAdmission.revoke(new Error("Update ledger admission is missing."));
  }
  return { env: run.env };
}

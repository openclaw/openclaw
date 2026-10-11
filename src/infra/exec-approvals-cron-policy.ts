// Retains cron policy eligibility through policy publication and native launch settlement.
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  requireOpenClawStateDatabaseIdentity,
} from "../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { resolveExecApprovalsDisplayPath } from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecAsk, ExecSecurity } from "./exec-approvals-core.js";
import { assertNoPendingLegacyExecApprovals } from "./exec-approvals-migration-gate.js";
import { maxAsk, minSecurity } from "./exec-approvals-policy.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";
import { snapshotFromExecApprovalsRow } from "./exec-approvals-sqlite.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";

type CronExecHostPolicyUse = {
  ready: boolean;
  retired: boolean;
  pending: number;
  initiating: boolean;
  accepts: (file: ExecApprovalsFile) => boolean;
};
const cronPolicyUses = resolveGlobalSingleton(
  Symbol.for("openclaw.execApprovalsCronPolicyUses"),
  () => new Map<string, Set<CronExecHostPolicyUse>>(),
);

const pendingPolicyPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.execApprovalsPendingPolicyPublications"),
  () => new Map<string, Set<ExecApprovalsFile>>(),
);

export function retainCronPolicyPublication(key: string, file: ExecApprovalsFile): () => void {
  const affected = [...(cronPolicyUses.get(key) ?? [])].filter((use) => !use.accepts(file));
  if (affected.some((use) => use.initiating)) {
    throw new Error(
      "Exec policy change refused while cron native launch acknowledgement is pending; retry after command startup settles.",
    );
  }
  const pending = pendingPolicyPublications.get(key) ?? new Set<ExecApprovalsFile>();
  pendingPolicyPublications.set(key, pending);
  pending.add(file);
  for (const use of affected) {
    // Rollback and an unknown write outcome cannot revive an already revoked use.
    use.retired = true;
  }
  let unregister = () => {};
  const release = () => {
    pending.delete(file);
    if (!pending.size && pendingPolicyPublications.get(key) === pending) {
      pendingPolicyPublications.delete(key);
    }
    unregister();
  };
  unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (!identity || identity.key === key) {
        release();
      }
    },
  });
  return release;
}

/** Live uses retain eligibility, not policy snapshots; native writers publish before returning. */
export async function prepareCronExecHostPolicyUse(
  context: OpenClawStateWorkerContext,
  params: {
    agentId: string;
    security: ExecSecurity;
    ask: ExecAsk;
    bypassHostApprovalFloors?: boolean;
  },
): Promise<{
  assertCurrent: () => void;
  release: () => void;
  initiate: <T>(effect: () => T, settlement?: Promise<unknown>) => T;
}> {
  context.admission.assertCurrent();
  const requested = { ...params };
  const key = context.admission.identity.key;
  const uses = cronPolicyUses.get(key) ?? new Set<CronExecHostPolicyUse>();
  cronPolicyUses.set(key, uses);
  const use: CronExecHostPolicyUse = {
    ready: false,
    retired: false,
    pending: 0,
    initiating: false,
    accepts(file) {
      const current = resolveExecApprovalsFromFileInternal({
        file,
        agentId: requested.agentId,
        overrides: requested,
      }).agent;
      const security = requested.bypassHostApprovalFloors
        ? requested.security
        : minSecurity(requested.security, current.security);
      const ask = requested.bypassHostApprovalFloors
        ? requested.ask
        : maxAsk(requested.ask, current.ask);
      return security !== "deny" && ask !== "always";
    },
  };
  use.retired = [...(pendingPolicyPublications.get(key) ?? [])].some((file) => !use.accepts(file));
  uses.add(use);
  let unregister = () => {};
  const release = () => {
    use.retired = true;
    if (use.initiating) {
      return;
    }
    uses.delete(use);
    if (uses.size === 0 && cronPolicyUses.get(key) === uses) {
      cronPolicyUses.delete(key);
    }
    unregister();
  };
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (!use.ready || use.retired || use.pending > 0) {
      throw new Error("Exec approval policy changed before cron execution");
    }
  };
  try {
    unregister = registerOpenClawStateDatabaseAsyncResource({
      async close(identity) {
        if (!identity || identity.key === key) {
          use.initiating = false;
          release();
        }
      },
    });
    assertNoPendingLegacyExecApprovals({ env: context.environment });
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "exec-approvals.read" },
      { context, current: true },
    );
    if (!reply?.ok || reply.type !== "exec-approvals.read") {
      throw new Error("Exec approval policy snapshot is unavailable");
    }
    const file = snapshotFromExecApprovalsRow({
      path: resolveExecApprovalsDisplayPath(context.environment),
      row: reply.row,
    }).file;
    // A commit during this read permanently retires the old use, even after policy restoration.
    use.retired ||= !use.accepts(file);
    use.ready = true;
    assertCurrent();
    return {
      assertCurrent,
      release,
      initiate(effect, settlement) {
        assertCurrent();
        use.retired = true;
        use.initiating = true;
        if (settlement) {
          void settlement.then(
            () => {
              use.initiating = false;
              release();
            },
            () => {
              // Unknown native initiation retains the mutation fence until source retirement.
            },
          );
        }
        try {
          return effect();
        } finally {
          if (!settlement) {
            use.initiating = false;
          }
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

export function stageCronExecHostPolicyPublication(
  db: DatabaseSync,
  file: ExecApprovalsFile,
): void {
  if (cronPolicyUses.size === 0) {
    return;
  }
  const key = requireOpenClawStateDatabaseIdentity({ db }).key;
  const affected = [...(cronPolicyUses.get(key) ?? [])].filter((use) => !use.accepts(file));
  if (affected.length === 0) {
    return;
  }
  if (affected.some((use) => use.initiating)) {
    throw new Error(
      "Exec policy change refused while cron native launch acknowledgement is pending; retry after command startup settles.",
    );
  }
  const retire = () => {
    for (const use of affected) {
      use.pending--;
      use.retired = true;
    }
  };
  if (
    !stageSqliteTransactionState(db, {
      stage() {
        for (const use of affected) {
          use.pending++;
        }
      },
      commit: retire,
      // A failed/uncertain write cannot revive this use; a fresh read may prepare another.
      rollback: retire,
    })
  ) {
    throw new Error("Exec approval policy publication requires its native transaction owner");
  }
}

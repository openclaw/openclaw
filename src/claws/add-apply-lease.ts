import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { AGENT_LIFECYCLE_MUTATION_LEASE_SCOPE } from "../agents/agent-lifecycle-lease.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";

const CLAW_ADD_LEASE_MS = 5 * 60_000;
const CLAW_ADD_WAIT_MS = 10 * 60_000;

type ClawAddLeaseOptions = Pick<OpenClawStateDatabaseOptions, "env" | "path" | "database"> & {
  signal?: AbortSignal;
};

export type ClawAgentMutationLeaseContext = {
  signal: AbortSignal;
  assertOwned: () => void;
};

/** Exclude add/update from each other and from the canonical agent deletion owner. */
export async function withClawAgentMutationLease<T>(
  agentId: string,
  options: ClawAddLeaseOptions,
  run: (lease: ClawAgentMutationLeaseContext) => Promise<T>,
): Promise<T> {
  // Planning can be state-free for a brand-new agent. Admit the shared schema before asking the
  // lease to use existing-only storage; this does not create or reuse any Claw ownership row.
  openOpenClawStateDatabase(options);
  return await withOpenClawStateLease(
    {
      scope: AGENT_LIFECYCLE_MUTATION_LEASE_SCOPE,
      key: normalizeAgentId(agentId),
      database: {
        scope: "shared",
        schemaPolicy: "existing",
        options: {
          ...(options.env ? { env: options.env } : {}),
          ...(options.path ? { path: options.path } : {}),
          ...(options.database ? { database: options.database } : {}),
        },
      },
      leaseMs: CLAW_ADD_LEASE_MS,
      waitMs: CLAW_ADD_WAIT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      leaseLabel: "Claw agent mutation lease",
      operationLabel: "claws.agent.mutation.lease",
    },
    async (lease) => {
      lease.assertOwned();
      const result = await run({ signal: lease.signal, assertOwned: () => lease.assertOwned() });
      lease.assertOwned();
      return result;
    },
  );
}

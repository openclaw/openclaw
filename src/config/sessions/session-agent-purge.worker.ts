import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import { applySessionEntryMaintenanceInDatabase } from "./session-accessor.sqlite-maintenance-store.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import {
  commitSessionAgentPurgeInDatabase,
  prepareSessionAgentPurgeInDatabase,
} from "./session-agent-purge.kernel.js";
import type {
  SessionAgentPurgeCommit,
  SessionAgentPurgeCommitted,
  SessionAgentPurgeSelection,
} from "./session-agent-purge.types.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";
import type { SessionEntry } from "./types.js";

export function prepareSessionAgentPurge(
  input: SessionAgentPurgeSelection,
  { open }: AgentWorkerOperationContext,
) {
  return prepareSessionAgentPurgeInDatabase(open(), input);
}

export function commitSessionAgentPurge(
  input: SessionAgentPurgeCommit,
  context: AgentWorkerOperationContext,
) {
  const mutate = <Receipt>(
    database: OpenClawAgentDatabase,
    wrapReceipt: (receipt: SessionEntryPatchReceipt) => Receipt,
  ): Receipt => {
    assertSessionSubagentRunsCurrent(input, context.options.env ?? process.env);
    const result = commitSessionAgentPurgeInDatabase(database, input, (current) =>
      applySessionEntryMaintenanceInDatabase(current, input.maintenance, () => {
        if (!input.maintenance.preservation) {
          throw new Error("Agent purge omitted its maintenance protection");
        }
        return input.maintenance.preservation;
      }),
    );
    const candidate: SessionAgentPurgeCommitted = {
      kind: "session-agent-purge",
      result,
      publication: prepareSessionEntryReplacementPublication(
        {
          previous: new Map(
            input.entryRemovals.flatMap(({ sessionKey, expectedEntry }) =>
              expectedEntry ? [[sessionKey, expectedEntry] as const] : [],
            ),
          ),
          current: new Map<string, SessionEntry>(),
          pendingArchiveRecovery: true,
          membershipInvalidatedKeys: input.entryRemovals.map(({ sessionKey }) => sessionKey),
          maintenancePlans: result.maintenancePlans,
        },
        database,
      ),
    };
    const receipt = transferSessionEntryWorkerCandidate(
      database,
      context.admit,
      candidate,
      wrapReceipt,
    );
    assertSessionSubagentRunsCurrent(input, context.options.env ?? process.env);
    return receipt;
  };
  return input.nativeBindings
    ? runSessionNativeBindingTransaction(
        input.nativeBindings,
        context,
        "session.entry.purge-deleted-agent",
        "Agent session purge",
        mutate,
      )
    : context.writeTransaction(
        "session.entry.purge-deleted-agent",
        "Agent session purge",
        (database) => mutate(database, (receipt) => receipt),
      );
}

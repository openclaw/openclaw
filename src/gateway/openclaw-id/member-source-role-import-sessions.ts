import { applySessionEntryExactReplacements } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { prepareSessionStoreTargetInventory } from "../../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../../config/sessions/session-store-target-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  importLegacyMemberQueuedSource,
  importLegacyMemberSnapshot,
  type LegacyOpenClawIdMemberRoleImport,
} from "./member-source-role-import.js";

/** Migrate every retained session carrier before publishing the imported profile assignment. */
export async function migrateLegacyMemberSessionSources(
  input: LegacyOpenClawIdMemberRoleImport,
  config: OpenClawConfig,
  assertCurrent: () => void,
): Promise<void> {
  const inventory = prepareSessionStoreTargetInventoryRead(
    prepareSessionStoreTargetInventory(
      config,
      listConfiguredSessionStoreAgentIds(config),
      process.env,
      "recovery",
    ),
  );
  await inventory.withRead(async (snapshot, assertInventoryCurrent) => {
    const assertImportCurrent = () => {
      assertCurrent();
      assertInventoryCurrent();
    };
    for (const agent of snapshot.agents) {
      if (!agent.result.available) {
        if (agent.result.reason === "database-missing") {
          continue;
        }
        throw new Error("Member role import requires its saved session sources to be available.");
      }
      for (const { target, database } of agent.reads) {
        await applySessionEntryExactReplacements({
          agentId: target.agentId,
          storePath: database.path,
          memberSourceRoleImport: input,
          assertCommitAllowed: assertImportCurrent,
          requireWriteSuccess: true,
          skipMaintenance: true,
          update: (entries) => ({
            result: undefined,
            replacements: entries.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: {
                ...entry,
                ...(entry.operatorSources
                  ? {
                      operatorSources: Object.fromEntries(
                        Object.entries(entry.operatorSources).map(([profileId, source]) => [
                          profileId,
                          importLegacyMemberSnapshot(source, input),
                        ]),
                      ),
                    }
                  : {}),
                ...(entry.resumeAfterRestart?.operatorSource
                  ? {
                      resumeAfterRestart: {
                        ...entry.resumeAfterRestart,
                        operatorSource: importLegacyMemberQueuedSource(
                          entry.resumeAfterRestart.operatorSource,
                          input,
                        ),
                      },
                    }
                  : {}),
              },
            })),
          }),
        });
      }
    }
  }, assertCurrent);
}

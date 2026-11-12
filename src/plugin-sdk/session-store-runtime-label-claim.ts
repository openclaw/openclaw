import { preserveGenerationPrivateFields } from "../config/sessions/session-entry-public-patch.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
} from "./session-store-runtime-internal.js";

/** Atomically claim a unique label while applying a guarded presentation patch. */
export async function prepareSessionEntryLabelClaim(params: {
  agentId: string;
  storePath: string;
  sessionKey: string;
  label: string;
  authority: { kind: "host"; assertCurrent(): void };
  prepare: (entry: SessionEntry) => Partial<SessionEntry> | null;
}): Promise<boolean> {
  const { applySessionEntryCanonicalReplacements } =
    await import("../config/sessions/session-accessor.sqlite-replacement-projection.js");
  const { SessionLabelOwnerIndex } = await import("../config/sessions/session-entry-selection.js");
  params.authority.assertCurrent();
  return await applySessionEntryCanonicalReplacements({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKeys: [params.sessionKey],
    includeLabelOwners: params.label,
    labelClaim: { sessionKey: params.sessionKey, label: params.label },
    requireWriteSuccess: true,
    assertCommitAllowed: () => params.authority.assertCurrent(),
    update: (entries) => {
      params.authority.assertCurrent();
      const current = entries.find(({ sessionKey }) => sessionKey === params.sessionKey)?.entry;
      const owners = new SessionLabelOwnerIndex(
        Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
      );
      if (!current || owners.isLabelInUse(params.label, [params.sessionKey])) {
        return { result: false };
      }
      const patch = params.prepare(projectPluginSessionEntry(current));
      if (!patch || patch.label !== params.label) {
        return { result: false };
      }
      return {
        result: true,
        replacements: [
          {
            sessionKey: params.sessionKey,
            previousSessionKeys: [],
            entry: {
              ...current,
              ...preserveGenerationPrivateFields(current, projectPluginSessionEntryPatch(patch)),
            },
          },
        ],
      };
    },
  });
}

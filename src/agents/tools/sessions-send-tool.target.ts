import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";

export async function readSessionSendTarget(
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId: string,
) {
  const prepared = await prepareSessionMutationFacts({
    cfg,
    sessionKey,
    agentId,
    allowMissing: true,
  });
  try {
    const initial = prepared.readCurrent(cfg).target;
    const [acp] = await readAcpSessionMetaForEntries({
      cfg,
      entries: [
        {
          sessionKey: initial?.canonicalKey ?? sessionKey,
          agentId: initial?.agentId ?? agentId,
          entry: initial?.entry ?? {},
        },
      ],
    });
    const current = prepared.readCurrent(cfg);
    return {
      ...current.location,
      entry: current.target?.entry,
      acp: acp ?? undefined,
    };
  } finally {
    prepared.release();
  }
}

import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { PluginRuntime } from "./types.js";

/** The session reader owns source admission; this adapter preserves the public runtime shape. */
export async function getSessionEntryAsync(
  params: Parameters<PluginRuntime["agent"]["session"]["getSessionEntry"]>[0] & {
    assertCurrent: () => void;
  },
) {
  const assertCurrent = params.assertCurrent;
  const scope = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    env: cloneEnvWithPlatformSemantics(params.env ?? process.env),
    storePath: params.storePath ? path.resolve(params.storePath) : undefined,
    hydrateSkillPromptRefs: params.hydrateSkillPromptRefs,
    readConsistency: params.readConsistency,
  };
  assertCurrent();
  const entry = await withSessionEntryReadOnlyInWorker(scope, assertCurrent, async (read) => {
    if (!read.ok) {
      throw read.error;
    }
    return read.value ? projectPublicSessionEntry(read.value) : undefined;
  });
  assertCurrent();
  return entry;
}

import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { waitForReplyRunSuccessorAdmission } from "./reply-run-registry.js";

export function createReplyAgentSessionFixture() {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  const sessionKeys = new Set<string>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        // Reply completion starts asynchronous recovery-owner release. Join it before
        // deleting stores so late cleanup cannot recreate a previous case's database.
        await Promise.all(
          [...sessionKeys].map((sessionKey) => waitForReplyRunSuccessorAdmission(sessionKey, null)),
        );
        for (const dir of tempDirs.dirs) {
          await closeOpenClawAgentDatabasesAsync(dir);
        }
        sessionKeys.clear();
        cleanup();
      } finally {
        clearRuntimeConfigSnapshot();
      }
    }),
  );
  return {
    sessionKeys,
    tempDirs,
    async createSessionStoreFile(
      this: void,
      entry: SessionEntry,
      sessionKey = "main",
    ): Promise<string> {
      sessionKeys.add(sessionKey);
      const dir = tempDirs.make("openclaw-agent-runner-");
      const storePath = join(dir, "sessions.json");
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      return storePath;
    },
  };
}

export async function runSuccessfulReplyModelFixture(
  params: RunEmbeddedAgentParams,
): Promise<EmbeddedAgentRunResult> {
  return {
    payloads: [{ text: "final" }],
    meta: {
      durationMs: 0,
      agentMeta: {
        sessionId: params.sessionId,
        provider: expectDefined(params.provider, "attempt provider"),
        model: expectDefined(params.model, "attempt model"),
      },
    },
  };
}

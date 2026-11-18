import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionTranscriptAppendResult } from "../../config/sessions/transcript.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { makeContext } from "./send.test-support.js";
import type { GatewayRequestContext } from "./types.js";

export async function withTempOpenClawStateDir<T>(
  test: (stateDir: string) => Promise<T>,
): Promise<T> {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-send-state-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  try {
    return await test(stateDir);
  } finally {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

export function fixedStoreContext(): GatewayRequestContext {
  return makeContext(() => ({
    session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      defaults: { sessionStore: { agentId: "ops" } },
    },
  }));
}

export function transcriptResult(messageId: string): SessionTranscriptAppendResult {
  return {
    ok: true,
    target: { sessionId: "x", sessionKey: "x", storePath: "/tmp/sessions.json" },
    messageId,
  };
}

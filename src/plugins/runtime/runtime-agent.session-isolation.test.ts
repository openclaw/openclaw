import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions/main-session-recovery.types.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime session isolation", () => {
  it("hides, preserves, and clears core recovery state through the injected facade", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-session-isolation-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:plugin-runtime-isolation";
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "runtime-cycle",
      reservation: {
        attempt: 1,
        lifecycleGeneration: "runtime-generation",
        runId: "runtime-run",
      },
      revision: 1,
    };
    const restartRecoveryState = {
      restartRecoveryDeliveryReceiptState: "terminal-pending" as const,
      restartRecoveryDeliveryToolCallId: "runtime-message-call",
      restartRecoveryRequesterAccountId: "runtime-account",
      restartRecoverySourceIngress: "channel" as const,
    };

    try {
      await replaceInternalSessionEntry({ sessionKey, storePath }, {
        mainRestartRecovery,
        ...restartRecoveryState,
        model: "gpt-5.5",
        sessionId: "runtime-session-before",
        updatedAt: 10,
      } as InternalSessionEntry);
      const runtime = createRuntimeAgent();

      expect(runtime.session.getSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
        "mainRestartRecovery",
      );
      expect(runtime.session.listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty(
        "mainRestartRecovery",
      );
      expect(runtime.session.getSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
        "restartRecoveryDeliveryReceiptState",
      );

      let callbackSawPrivateState = false;
      await runtime.session.patchSessionEntry({
        sessionKey,
        storePath,
        update: (entry) => {
          callbackSawPrivateState = Object.hasOwn(entry, "mainRestartRecovery");
          return {
            mainRestartRecovery: {
              chargedAttempts: 99,
              cycleId: "runtime-injection",
              revision: 99,
            },
            model: "gpt-5.6",
            restartRecoveryDeliveryReceiptState: "delivered-terminal",
          } as unknown as Partial<SessionEntry>;
        },
      });
      expect(callbackSawPrivateState).toBe(false);
      expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
        mainRestartRecovery,
        ...restartRecoveryState,
        model: "gpt-5.6",
      });

      await runtime.session.upsertSessionEntry({
        entry: {
          sessionId: "runtime-session-before",
          updatedAt: 20,
        },
        sessionKey,
        storePath,
      });
      expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
        mainRestartRecovery,
        ...restartRecoveryState,
        sessionId: "runtime-session-before",
      });

      await runtime.session.updateSessionStoreEntry({
        sessionKey,
        skipMaintenance: true,
        storePath,
        update: () => ({
          sessionId: "runtime-session-after",
          updatedAt: 30,
        }),
      });
      expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
        sessionId: "runtime-session-after",
      });
      expect(loadInternalSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
        "mainRestartRecovery",
      );
      for (const field of Object.keys(restartRecoveryState)) {
        expect(loadInternalSessionEntry({ sessionKey, storePath })).not.toHaveProperty(field);
      }
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

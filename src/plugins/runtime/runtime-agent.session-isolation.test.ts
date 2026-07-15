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

    try {
      await replaceInternalSessionEntry({ sessionKey, storePath }, {
        mainRestartRecovery,
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
          } as unknown as Partial<SessionEntry>;
        },
      });
      expect(callbackSawPrivateState).toBe(false);
      expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
        mainRestartRecovery,
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
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

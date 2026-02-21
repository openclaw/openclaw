import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import { handleActivationCommand } from "./commands-session.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

describe("handleActivationCommand persistence", () => {
  it("merges activation updates with fresher persisted session fields", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commands-session-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;

    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "s1",
          updatedAt: Date.now() - 1_000,
          lastTo: "fresh-recipient",
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: sessionEntry,
      };
      const params = buildCommandTestParams("/activation always", cfg);
      params.isGroup = true;
      params.sessionKey = sessionKey;
      params.sessionEntry = sessionEntry;
      params.sessionStore = sessionStore;
      params.storePath = storePath;

      const result = await handleActivationCommand(params, true);

      expect(result?.reply?.text).toContain("Group activation set to always.");
      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.groupActivation).toBe("always");
      expect(persisted?.groupActivationNeedsSystemIntro).toBe(true);
      expect(persisted?.lastTo).toBe("fresh-recipient");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

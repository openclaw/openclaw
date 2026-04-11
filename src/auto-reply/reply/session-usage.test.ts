import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

describe("persistSessionUsageUpdate", () => {
  let tmpDir = "";
  let storePath = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-usage-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("clears reset CLI import suppression when persisting a fresh CLI binding", async () => {
    const sessionKey = "agent:main:usage:test-codex-cli";
    const sessionId = "test-openclaw-session";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
        suppressCliHistoryImport: true,
        cliSessionBindings: {
          "codex-cli": {
            sessionId: "stale-session",
          },
        },
        cliSessionIds: {
          "codex-cli": "stale-session",
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2));

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      cfg: {} as OpenClawConfig,
      usage: {
        input: 10,
        output: 5,
      },
      providerUsed: "codex-cli",
      modelUsed: "gpt-5.4",
      contextTokensUsed: 128_000,
      cliSessionBinding: {
        sessionId: "fresh-session",
      },
    });

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.suppressCliHistoryImport).toBeUndefined();
    expect(persisted[sessionKey]?.cliSessionBindings?.["codex-cli"]).toEqual({
      sessionId: "fresh-session",
    });
    expect(persisted[sessionKey]?.cliSessionIds?.["codex-cli"]).toBe("fresh-session");
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, saveSessionStore } from "../config/sessions.js";
import { runAgentContextMigrationWithBarrier } from "./server-startup-agent-context.js";

describe("runAgentContextMigrationWithBarrier", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    await Promise.all(
      cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("is idempotent across concurrent and repeated startup runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migration-"));
    cleanupDirs.push(root);
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath, mainKey: "main" },
      agents: { list: [{ id: "main" }] },
    } as OpenClawConfig;
    await saveSessionStore(storePath, {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
        totalTokens: 150_000,
      },
    });
    await fs.writeFile(
      path.join(root, "sess-main.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "sess-main",
          timestamp: new Date().toISOString(),
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Investigate OPENAI_API_KEY in src/app.ts and commit deadbeef",
              },
            ],
            timestamp: Date.now(),
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await Promise.all([
      runAgentContextMigrationWithBarrier({ cfg, log: { warn: () => undefined } }),
      runAgentContextMigrationWithBarrier({ cfg, log: { warn: () => undefined } }),
    ]);
    await runAgentContextMigrationWithBarrier({ cfg, log: { warn: () => undefined } });

    const store = loadSessionStore(storePath) as Record<
      string,
      { sessionId: string; archivedAt?: number }
    >;
    const archivedKeys = Object.keys(store).filter((key) =>
      key.startsWith("agent:main:main:archived:"),
    );
    expect(archivedKeys).toHaveLength(1);
    expect(store["agent:main:main"]).toBeTruthy();
    expect(store[archivedKeys[0]]?.archivedAt).toBeTypeOf("number");

    const summaryDir = path.join(
      process.env.OPENCLAW_STATE_DIR,
      "agents",
      "main",
      "memory",
      "mid_term_summaries",
    );
    const files = await fs.readdir(summaryDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

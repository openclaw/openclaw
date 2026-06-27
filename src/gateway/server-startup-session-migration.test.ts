/**
 * Gateway startup session migration tests.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeCfg() {
  return { agents: { defaults: {} }, session: {} } as Parameters<
    typeof runStartupSessionMigration
  >[0]["cfg"];
}

function firstLogMessage(log: ReturnType<typeof vi.fn>, label: string): string {
  const [message] = log.mock.calls[0] ?? [];
  if (typeof message !== "string") {
    throw new Error(`expected ${label} message`);
  }
  return message;
}

describe("runStartupSessionMigration", () => {
  it("discovers plugin-owned agents during direct gateway startup", async () => {
    await withTempDir({ prefix: "openclaw-startup-migration-" }, async (tempDir) => {
      const storeTemplate = path.join(tempDir, "stores", "{agentId}", "sessions.json");
      const voiceStorePath = path.join(tempDir, "stores", "voice", "sessions.json");
      fs.mkdirSync(path.dirname(voiceStorePath), { recursive: true });
      fs.writeFileSync(
        voiceStorePath,
        JSON.stringify({
          "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 1 },
        }),
      );
      const cfg = {
        session: { store: storeTemplate },
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: { "voice-call": { config: { agentId: "voice" } } },
        },
      } as ReturnType<typeof makeCfg>;
      const log = makeLog();

      await runStartupSessionMigration({
        cfg,
        env: {
          ...process.env,
          HOME: tempDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_STATE_DIR: path.join(tempDir, "state"),
        },
        log,
      });

      const store = JSON.parse(fs.readFileSync(voiceStorePath, "utf8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(store["agent:voice:voice:15550001111"]?.sessionId).toBe("legacy-voice");
      expect(store["voice:15550001111"]).toBeUndefined();
      expect(log.info).toHaveBeenCalledOnce();
    });
  });

  it("logs changes when orphaned keys are canonicalized", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({
      changes: ["Canonicalized 2 orphaned session key(s) in /tmp/store.json"],
      warnings: [],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(migrate).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledOnce();
    expect(firstLogMessage(log.info, "startup migration info")).toContain(
      "canonicalized orphaned session keys",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs warnings from migration", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({
      changes: [],
      warnings: ["Could not read /bad/path: ENOENT"],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(firstLogMessage(log.warn, "startup migration warning")).toContain(
      "session key migration warnings",
    );
  });

  it("silently continues when no changes needed", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({ changes: [], warnings: [] });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("catches and logs migration errors without throwing", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockRejectedValue(new Error("disk full"));
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(log.warn).toHaveBeenCalledOnce();
    const warning = firstLogMessage(log.warn, "startup migration failure warning");
    expect(warning).toContain("migration failed during startup");
    expect(warning).toContain("disk full");
  });
});

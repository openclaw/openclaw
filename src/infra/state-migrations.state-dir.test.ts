import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "./state-migrations.js";

let tempRoot: string | null = null;

async function makeTempRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-state-dir-"));
  tempRoot = root;
  return root;
}

afterEach(async () => {
  resetAutoMigrateLegacyStateDirForTest();
  if (!tempRoot) {
    return;
  }
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe("legacy state dir auto-migration", () => {
  it("follows legacy symlink when it points at another legacy dir (clawdbot -> moltbot)", async () => {
    const root = await makeTempRoot();
    const legacySymlink = path.join(root, ".clawdbot");
    const legacyDir = path.join(root, ".moltbot");

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf-8");

    const dirLinkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(legacyDir, legacySymlink, dirLinkType);

    const result = await autoMigrateLegacyStateDir({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(result.migrated).toBe(true);
    expect(result.warnings).toEqual([]);

    const targetMarker = path.join(root, ".openclaw", "marker.txt");
    expect(fs.readFileSync(targetMarker, "utf-8")).toBe("ok");
    expect(fs.readFileSync(path.join(root, ".moltbot", "marker.txt"), "utf-8")).toBe("ok");
    expect(fs.readFileSync(path.join(root, ".clawdbot", "marker.txt"), "utf-8")).toBe("ok");
  });

  it("rewrites migrated sessionFile paths away from the legacy state dir", async () => {
    const root = await makeTempRoot();
    const legacyDir = path.join(root, ".clawdbot");
    const legacySessionsDir = path.join(legacyDir, "agents", "main", "sessions");
    const legacyTranscript = path.join(legacySessionsDir, "legacy-session.jsonl");

    fs.mkdirSync(legacySessionsDir, { recursive: true });
    fs.writeFileSync(legacyTranscript, '{"type":"session"}\n', "utf-8");
    fs.writeFileSync(
      path.join(legacySessionsDir, "sessions.json"),
      JSON.stringify({
        main: {
          sessionId: "sess-1",
          updatedAt: 1,
          sessionFile: legacyTranscript,
        },
      }),
      "utf-8",
    );

    const result = await autoMigrateLegacyStateDir({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(result.migrated).toBe(true);

    const migratedStorePath = path.join(
      root,
      ".openclaw",
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const migratedStore = JSON.parse(fs.readFileSync(migratedStorePath, "utf-8")) as Record<
      string,
      { sessionFile?: string }
    >;
    const migratedEntry = Object.values(migratedStore)[0];

    expect(migratedEntry?.sessionFile).toBe(
      path.join(root, ".openclaw", "agents", "main", "sessions", "legacy-session.jsonl"),
    );
    expect(migratedEntry?.sessionFile).not.toContain(".clawdbot");
    expect(
      fs.existsSync(
        path.join(root, ".openclaw", "agents", "main", "sessions", "legacy-session.jsonl"),
      ),
    ).toBe(true);
    expect(result.changes).toContain(
      `Rewrote 1 migrated sessionFile path(s) in ${migratedStorePath}`,
    );
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore } from "../config/sessions.js";
import { __testing } from "./server-startup.js";

describe("startup user-archive empty session pruning", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("removes freshly created empty shells and prunes store entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-prune-"));
    tmpDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const shutdownAt = Date.now() - 500;

    const emptyFile = path.join(sessionsDir, "empty-session.jsonl");
    const activeFile = path.join(sessionsDir, "active-session.jsonl");
    await fs.writeFile(
      emptyFile,
      `${JSON.stringify({ type: "session", id: "empty-session" })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      activeFile,
      [
        JSON.stringify({ type: "session", id: "active-session" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n"),
      "utf-8",
    );
    await fs.utimes(emptyFile, new Date(), new Date());
    await fs.utimes(activeFile, new Date(), new Date());

    const storePath = path.join(sessionsDir, "sessions.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:empty"] = {
        sessionId: "empty-session",
        updatedAt: Date.now(),
        sessionFile: emptyFile,
      };
      store["agent:main:active"] = {
        sessionId: "active-session",
        updatedAt: Date.now(),
        sessionFile: activeFile,
      };
    });

    const logWarn = vi.fn();
    await __testing.pruneUserArchiveEmptySessionShells({
      sessionDirs: [sessionsDir],
      shutdownAt,
      log: { warn: logWarn },
    });

    await expect(fs.stat(emptyFile)).rejects.toThrow();
    await expect(fs.stat(activeFile)).resolves.toBeDefined();
    const storeRaw = await fs.readFile(storePath, "utf-8");
    expect(storeRaw).not.toContain("agent:main:empty");
    expect(storeRaw).toContain("agent:main:active");
    expect(logWarn).toHaveBeenCalled();
  });
});

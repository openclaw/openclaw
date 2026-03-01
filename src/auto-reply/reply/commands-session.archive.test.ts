import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { handleArchiveSessionCommand } from "./commands-session.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const { requestGatewayStopMock } = vi.hoisted(() => ({
  requestGatewayStopMock: vi.fn(),
}));
vi.mock("../../gateway/shutdown-state.js", async () => {
  const actual = await vi.importActual<typeof import("../../gateway/shutdown-state.js")>(
    "../../gateway/shutdown-state.js",
  );
  return {
    ...actual,
    requestGatewayStop: requestGatewayStopMock,
  };
});

describe("/archive-session command", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    requestGatewayStopMock.mockReset();
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("archives the active transcript and suppresses success chat reply", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-command-"));
    tmpDirs.push(tmpDir);
    const cfg = { commands: { text: true } } as OpenClawConfig;
    const params = buildCommandTestParams("/archive-session", cfg);
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionId = "session-archive-command";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: sessionId }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n"),
      "utf-8",
    );
    await updateSessionStore(storePath, (store) => {
      store[params.sessionKey] = {
        sessionId,
        updatedAt: Date.now(),
        sessionFile,
      };
    });
    params.storePath = storePath;
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile,
      },
    };
    params.sessionEntry = params.sessionStore[params.sessionKey];

    const result = await handleArchiveSessionCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    await expect(fs.stat(sessionFile)).rejects.toThrow();
    const archiveRoot = path.join(tmpDir, "archive");
    const archiveEntries = await fs.readdir(archiveRoot);
    expect(archiveEntries.length).toBeGreaterThan(0);
    const persistedStore = loadSessionStore(storePath, { skipCache: true });
    expect(persistedStore[params.sessionKey]).toBeUndefined();
    expect(requestGatewayStopMock).toHaveBeenCalledTimes(1);
    expect(requestGatewayStopMock.mock.calls[0]?.[0]).toMatchObject({
      reason: "user-archive",
      delayMs: 0,
    });
  });
});

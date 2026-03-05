import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import {
  readScheduledTaskCommand,
  resolveTaskScriptPath,
  restartScheduledTask,
} from "./schtasks.js";

const schtasksCalls: string[][] = [];

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  },
}));

beforeEach(() => {
  schtasksCalls.length = 0;
});

async function withTaskScript(
  scriptLines: string[],
  run: (env: Record<string, string>) => Promise<void>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-restart-"));
  const env = {
    USERPROFILE: tmpDir,
    OPENCLAW_PROFILE: "default",
  };
  try {
    const scriptPath = resolveTaskScriptPath(env);
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, scriptLines.join("\r\n"), "utf8");
    await run(env);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

describe("restartScheduledTask", () => {
  it("updates stale OPENCLAW_SERVICE_VERSION before restarting", async () => {
    await withTaskScript(
      ["@echo off", "set OPENCLAW_SERVICE_VERSION=2026.2.26", "node gateway.js"],
      async (env) => {
        await restartScheduledTask({ env, stdout: new PassThrough() });

        const parsed = await readScheduledTaskCommand(env);
        expect(parsed?.environment?.OPENCLAW_SERVICE_VERSION).toBe(VERSION);
        expect(schtasksCalls).toEqual([
          ["/Query"],
          ["/End", "/TN", "OpenClaw Gateway"],
          ["/Run", "/TN", "OpenClaw Gateway"],
        ]);
      },
    );
  });

  it("injects OPENCLAW_SERVICE_VERSION when missing", async () => {
    await withTaskScript(
      ["@echo off", "set OPENCLAW_GATEWAY_PORT=18789", "node gateway.js"],
      async (env) => {
        await restartScheduledTask({ env, stdout: new PassThrough() });

        const parsed = await readScheduledTaskCommand(env);
        expect(parsed?.environment?.OPENCLAW_SERVICE_VERSION).toBe(VERSION);
      },
    );
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveScheduledTaskRuntimeStatus,
  parseSchtasksQuery,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
} from "./schtasks.js";

describe("schtasks runtime parsing", () => {
  it.each(["Ready", "Running"])("parses %s status", (status) => {
    const output = [
      "TaskName: \\Bot Gateway",
      `Status: ${status}`,
      "Last Run Time: 1/8/2026 1:23:45 AM",
      "Last Run Result: 0x0",
    ].join("\r\n");
    expect(parseSchtasksQuery(output)).toEqual({
      status,
      lastRunTime: "1/8/2026 1:23:45 AM",
      lastRunResult: "0x0",
    });
  });
});

describe("scheduled task runtime derivation", () => {
  it("treats Running + 0x41301 as running", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
        lastRunResult: "0x41301",
      }),
    ).toEqual({ status: "running" });
  });

  it("treats Running + decimal 267009 as running", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
        lastRunResult: "267009",
      }),
    ).toEqual({ status: "running" });
  });

  it("treats Running without last result as running", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
      }),
    ).toEqual({ status: "running" });
  });

  it("downgrades stale Running status when last result is not a running code", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
        lastRunResult: "0x0",
      }),
    ).toEqual({
      status: "stopped",
      detail: "Task reports Running but Last Run Result=0x0; treating as stale runtime state.",
    });
  });
});

describe("resolveTaskScriptPath", () => {
  it.each([
    {
      name: "uses default path when BOT_PROFILE is unset",
      env: { USERPROFILE: "C:\\Users\\test" },
      expected: path.join("C:\\Users\\test", ".bot", "gateway.cmd"),
    },
    {
      name: "uses profile-specific path when BOT_PROFILE is set to a custom value",
      env: { USERPROFILE: "C:\\Users\\test", BOT_PROFILE: "jbphoenix" },
      expected: path.join("C:\\Users\\test", ".bot-jbphoenix", "gateway.cmd"),
    },
    {
      name: "prefers BOT_STATE_DIR over profile-derived defaults",
      env: {
        USERPROFILE: "C:\\Users\\test",
        BOT_PROFILE: "rescue",
        BOT_STATE_DIR: "C:\\State\\bot",
      },
      expected: path.join("C:\\State\\bot", "gateway.cmd"),
    },
    {
      name: "falls back to HOME when USERPROFILE is not set",
      env: { HOME: "/home/test", BOT_PROFILE: "default" },
      expected: path.join("/home/test", ".bot", "gateway.cmd"),
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveTaskScriptPath(env)).toBe(expected);
  });
});

describe("readScheduledTaskCommand", () => {
  async function withScheduledTaskScript(
    options: {
      scriptLines?: string[];
      env?:
        | Record<string, string | undefined>
        | ((tmpDir: string) => Record<string, string | undefined>);
    },
    run: (env: Record<string, string | undefined>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bot-schtasks-test-"));
    try {
      const extraEnv = typeof options.env === "function" ? options.env(tmpDir) : options.env;
      const env = {
        USERPROFILE: tmpDir,
        BOT_PROFILE: "default",
        ...extraEnv,
      };
      if (options.scriptLines) {
        const scriptPath = resolveTaskScriptPath(env);
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        await fs.writeFile(scriptPath, options.scriptLines.join("\r\n"), "utf8");
      }
      await run(env);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("parses script with quoted arguments containing spaces", async () => {
    await withScheduledTaskScript(
      {
        // Use forward slashes which work in Windows cmd and avoid escape parsing issues.
        scriptLines: ["@echo off", '"C:/Program Files/Node/node.exe" gateway.js'],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["C:/Program Files/Node/node.exe", "gateway.js"],
        });
      },
    );
  });

  it("returns null when script does not exist", async () => {
    await withScheduledTaskScript({}, async (env) => {
      const result = await readScheduledTaskCommand(env);
      expect(result).toBeNull();
    });
  });

  it("returns null when script has no command", async () => {
    await withScheduledTaskScript(
      { scriptLines: ["@echo off", "rem This is just a comment"] },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toBeNull();
      },
    );
  });

  it("parses full script with all components", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          "rem Bot Gateway",
          "cd /d C:\\Projects\\bot",
          "set NODE_ENV=production",
          "set BOT_PORT=18789",
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--verbose"],
          workingDirectory: "C:\\Projects\\bot",
          environment: {
            NODE_ENV: "production",
            BOT_PORT: "18789",
          },
        });
      },
    );
  });

  it("parses command with Windows backslash paths", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\bot\\dist\\index.js gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\bot\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
        });
      },
    );
  });

  it("preserves UNC paths in command arguments", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"\\\\fileserver\\Bot Share\\node.exe" "\\\\fileserver\\Bot Share\\dist\\index.js" gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "\\\\fileserver\\Bot Share\\node.exe",
            "\\\\fileserver\\Bot Share\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
        });
      },
    );
  });

  it("reads script from BOT_STATE_DIR override", async () => {
    await withScheduledTaskScript(
      {
        env: (tmpDir) => ({ BOT_STATE_DIR: path.join(tmpDir, "custom-state") }),
        scriptLines: ["@echo off", "node gateway.js --from-state-dir"],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--from-state-dir"],
        });
      },
    );
  });

  it("parses quoted set assignments with escaped metacharacters", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          'set "OC_AMP=left & right"',
          'set "OC_PIPE=a | b"',
          'set "OC_CARET=^^"',
          'set "OC_PERCENT=%%TEMP%%"',
          'set "OC_BANG=^!token^!"',
          'set "OC_QUOTE=he said ^"hi^""',
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result?.environment).toEqual({
          OC_AMP: "left & right",
          OC_PIPE: "a | b",
          OC_CARET: "^",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_QUOTE: 'he said "hi"',
        });
      },
    );
  });
});

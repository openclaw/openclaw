import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { runUtf8CommandWithTimeout } from "../../src/process/exec.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

export type ClaudeCliSpawnProofKind = "native" | "node-leading" | "npm-shim";

export type ClaudeCliSpawnProof = {
  kind: ClaudeCliSpawnProofKind;
  platform: NodeJS.Platform;
  command: string;
  entrypoint: string;
  code: number | null;
  stdout: string;
  stderr: string;
  launches: unknown[];
};

// A controlled external CLI speaks the same initialize/user/result protocol as
// the Anthropic transport fixtures. No provider request or real credential is used.
const CLAUDE_CLI = String.raw`
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const argv = process.argv.slice(2);
const phase = argv.includes("--version") ? "version" : argv[0] === "auth" ? "auth" : "run";
fs.appendFileSync(process.env.CLAUDE_SPAWN_PROOF_LOG, JSON.stringify({
  phase, platform: process.platform, pid: process.pid, executable: process.execPath,
  entrypoint: process.argv[1], execArgv: process.execArgv,
}) + "\n");
if (phase === "version") { console.log("2.1.205 (Claude Code)"); process.exit(0); }
if (phase === "auth") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "fixture@example.test" }));
  process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const sessionIndex = argv.indexOf("--session-id");
const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : randomUUID();
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id,
      response: message.request.subtype === "initialize" ? { commands: [], models: [] } : {},
    } });
  } else if (message.type === "user") {
    send({ type: "system", subtype: "init", session_id: sessionId,
      model: "claude-sonnet-4-6", tools: [], cwd: process.cwd() });
    send({ type: "assistant", session_id: sessionId, message: {
      id: "fixture-message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "PONG" }],
    } });
    send({ type: "result", subtype: "success", is_error: false, result: "PONG",
      session_id: sessionId, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
`;

const NPM_CMD = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
`;

const NATIVE_LAUNCHER = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
class ClaudeFixture {
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      result.Append(c);
      slashes = 0;
    }
    result.Append('\\', slashes * 2);
    return result.Append('"').ToString();
  }
  static int Main(string[] args) {
    File.AppendAllText(Environment.GetEnvironmentVariable("CLAUDE_SPAWN_PROOF_LOG"),
      "{\"phase\":\"native-launch\",\"platform\":\"win32\",\"pid\":" +
      Process.GetCurrentProcess().Id + "}\n");
    var argv = new List<string>();
    argv.Add(Quote(Environment.GetEnvironmentVariable("CLAUDE_SPAWN_PROOF_ENTRY")));
    foreach (string arg in args) argv.Add(Quote(arg));
    var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("CLAUDE_SPAWN_PROOF_NODE"),
      String.Join(" ", argv)) { UseShellExecute = false };
    using (var child = Process.Start(start)) {
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
`;

const PROCESS_ENV: Record<string, true> = {
  PATH: true,
  PATHEXT: true,
  SYSTEMROOT: true,
  WINDIR: true,
  COMSPEC: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  NUMBER_OF_PROCESSORS: true,
  PROCESSOR_ARCHITECTURE: true,
  PROCESSOR_IDENTIFIER: true,
  OS: true,
  PROGRAMFILES: true,
  "PROGRAMFILES(X86)": true,
  PROGRAMW6432: true,
  ALLUSERSPROFILE: true,
  CI: true,
  // The shared state fixture replaces these; extraEnv must not erase its replacements.
  HOME: true,
  USERPROFILE: true,
  HOMEDRIVE: true,
  HOMEPATH: true,
  OPENCLAW_HOME: true,
  OPENCLAW_STATE_DIR: true,
  OPENCLAW_CONFIG_PATH: true,
  OPENCLAW_AGENT_DIR: true,
  PI_CODING_AGENT_DIR: true,
};

/** Run the ordinary shipped agent command, not the auth-binding/isolated-exec path. */
export async function runClaudeCliNativeSpawnProof(
  kind: ClaudeCliSpawnProofKind,
): Promise<ClaudeCliSpawnProof> {
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => !Object.hasOwn(PROCESS_ENV, key.toUpperCase()))
      .map((key) => [key, undefined]),
  );
  const instance = await createOpenClawTestInstance({
    name: `claude-cli-spawn-${kind}`,
    entrypoint: ["scripts/run-node.mjs"],
    env: {
      ...env,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  try {
    if (
      instance.env.HOME !== instance.homeDir ||
      instance.env.OPENCLAW_STATE_DIR !== instance.stateDir ||
      instance.env.OPENCLAW_CONFIG_PATH !== instance.configPath
    ) {
      throw new Error("CLI proof environment lost its isolated state owner");
    }
    const prefix = instance.state.path("npm-prefix");
    const packageDir = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code");
    const entrypoint = path.join(packageDir, "cli.js");
    const logPath = instance.state.path("child-launches.jsonl");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(entrypoint, CLAUDE_CLI);
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@anthropic-ai/claude-code",
        version: "2.1.205",
        bin: { claude: "cli.js" },
      }),
    );
    if (kind !== "native") {
      await fs.writeFile(path.join(prefix, "claude.cmd"), NPM_CMD.replaceAll("\n", "\r\n"));
    }
    if (kind === "npm-shim") {
      await fs.writeFile(
        path.join(prefix, "claude"),
        '#!/bin/sh\nexec node "$(dirname "$0")/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n',
        { mode: 0o755 },
      );
    }
    const pathKey = Object.keys(instance.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    instance.env[pathKey] = `${prefix}${path.delimiter}${instance.env[pathKey] ?? ""}`;
    instance.env.CLAUDE_SPAWN_PROOF_LOG = logPath;
    instance.env.CLAUDE_SPAWN_PROOF_NODE = process.execPath;
    instance.env.CLAUDE_SPAWN_PROOF_ENTRY = entrypoint;
    instance.env.CLAUDE_CONFIG_DIR = instance.state.path("claude-home");
    instance.env.APPDATA = instance.state.path("appdata");
    instance.env.LOCALAPPDATA = instance.state.path("local-appdata");
    const command = "claude";
    if (kind === "native") {
      const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!windowsRoot) {
        throw new Error("Native Windows fixture requires SystemRoot");
      }
      const compiler = path.join(
        windowsRoot,
        "Microsoft.NET",
        "Framework64",
        "v4.0.30319",
        "csc.exe",
      );
      const source = instance.state.path("ClaudeFixture.cs");
      await fs.writeFile(source, NATIVE_LAUNCHER);
      const compiled = await runUtf8CommandWithTimeout(
        [compiler, "/nologo", "/target:exe", `/out:${path.join(prefix, "claude.exe")}`, source],
        { baseEnv: instance.env, timeoutMs: 30_000, killProcessTree: true },
      );
      if (compiled.code !== 0) {
        throw new Error(
          `Native fixture compilation failed: ${compiled.stdout}\n${compiled.stderr}`,
        );
      }
    }
    await instance.state.writeConfig({
      plugins: { entries: { anthropic: { enabled: true } } },
      agents: {
        defaults: {
          workspace: instance.state.workspaceDir,
          model: { primary: "claude-cli/claude-sonnet-4-6" },
          models: { "claude-cli/claude-sonnet-4-6": {} },
        },
      },
    });
    const prepared = await instance.cli(["--version"], {
      timeoutMs: 240_000,
      execPath: process.execPath,
    });
    if (prepared.code !== 0) {
      throw new Error(`CLI preparation failed: ${JSON.stringify(prepared)}`);
    }
    const result = await instance.cli(
      [
        "agent",
        "--local",
        "--session-id",
        randomUUID(),
        "--message",
        "Reply with exactly PONG",
        "--json",
        "--timeout",
        "60",
      ],
      { timeoutMs: 120_000, execPath: process.execPath },
    );
    const log = await fs.readFile(logPath, "utf8").catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return "";
      }
      throw error;
    });
    return {
      kind,
      platform: process.platform,
      command,
      entrypoint,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      launches: log
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line)),
    };
  } finally {
    await instance.cleanup();
  }
}

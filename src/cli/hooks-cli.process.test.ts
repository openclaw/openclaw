// Hooks CLI process tests cover plugin-owned handles that outlive command output.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  await Promise.all(Array.from(activeChildren, terminateChild));
});

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "close");
}

async function createLingeringPluginFixture(): Promise<{
  configPath: string;
  markerPath: string;
  stateDir: string;
}> {
  const root = tempDirs.make("openclaw-hooks-cli-");
  const stateDir = path.join(root, "state");
  const pluginDir = path.join(root, "linger-plugin");
  const markerPath = path.join(root, "registered");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "linger-plugin",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "linger",
      name: "Linger",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      'import fs from "node:fs";',
      "export default {",
      '  id: "linger",',
      '  name: "Linger",',
      "  register() {",
      '    fs.writeFileSync(process.env.LINGER_MARKER, "registered\\n");',
      "    setInterval(() => {}, 60_000);",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        load: { paths: [pluginDir] },
        entries: { linger: { enabled: true } },
      },
    }),
  );
  return { configPath, markerPath, stateDir };
}

async function createLingeringPreloadFixture(): Promise<{
  markerPath: string;
  preloadPath: string;
  stateDir: string;
}> {
  const root = tempDirs.make("openclaw-hooks-relay-");
  const markerPath = path.join(root, "loaded");
  const preloadPath = path.join(root, "linger.mjs");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.LINGER_MARKER, "loaded\\n");',
      "setInterval(() => {}, 60_000);",
      "",
    ].join("\n"),
  );
  return { markerPath, preloadPath, stateDir };
}

async function runHooksCli(params: {
  args: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMessage: string;
}) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/entry.ts", ...params.args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      NODE_ENV: undefined,
      VITEST: undefined,
      ...params.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(params.stdin ?? "");

  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (timedOut) {
        reject(new Error(`${params.timeoutMessage}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ code, signal, stderr, stdout });
    });
  });
}

async function runHooksRelay(params: { event: "post_tool_use" | "pre_tool_use"; stdin: string }) {
  const fixture = await createLingeringPreloadFixture();
  const result = await runHooksCli({
    args: [
      "hooks",
      "relay",
      "--provider",
      "codex",
      "--relay-id",
      "missing-relay",
      "--event",
      params.event,
      "--timeout",
      "50",
    ],
    env: {
      LINGER_MARKER: fixture.markerPath,
      NODE_OPTIONS: `--import=${fixture.preloadPath}`,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: fixture.stateDir,
    },
    stdin: params.stdin,
    timeoutMessage: `hooks relay ${params.event} did not exit after emitting output`,
  });
  await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("loaded\n");
  return result;
}

describe("hooks CLI process lifecycle", () => {
  it("exits after JSON output when plugin registration leaves a ref'd handle", async () => {
    const fixture = await createLingeringPluginFixture();

    const result = await runHooksCli({
      args: ["hooks", "list", "--json"],
      env: {
        LINGER_MARKER: fixture.markerPath,
        OPENCLAW_CONFIG_PATH: fixture.configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: fixture.stateDir,
      },
      timeoutMessage: "hooks list did not exit after emitting output",
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).not.toContain("Error:");
    expect(JSON.parse(result.stdout)).toMatchObject({ hooks: expect.any(Array) });
    await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("registered\n");
  }, 20_000);

  it("exits successfully after an observational relay result with a ref'd handle", async () => {
    const result = await runHooksRelay({ event: "post_tool_use", stdin: "{}" });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stdout: "" });
    expect(result.stderr).toMatch(/native hook relay (timed out|unavailable)/);
  }, 20_000);

  it("flushes fail-closed PreToolUse JSON before exiting with a ref'd handle", async () => {
    const result = await runHooksRelay({ event: "pre_tool_use", stdin: "{}" });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.any(String),
      },
    });
  }, 20_000);

  it("preserves a malformed-input exit code with a ref'd handle", async () => {
    const result = await runHooksRelay({ event: "post_tool_use", stdin: "{nope" });

    expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(result.stderr).toContain("failed to read native hook input");
  }, 20_000);
});

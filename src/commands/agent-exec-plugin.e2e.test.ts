import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { withinTest } from "../../test/helpers/promise.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";

const execFileAsync = promisify(execFile);
const TRANSPORT_CLEANUP_GUARD_MS = 5_000;
let cleanupFixture: (() => Promise<void>) | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirs) =>
  afterEach(async () => {
    try {
      // afterEach precedes onTestFinished; transport cleanup still needs its files.
      await cleanupFixture?.();
    } finally {
      cleanupFixture = undefined;
      cleanupDirs();
    }
  }),
);

async function writeHarnessPlugin(stateDir: string, workspace?: string): Promise<void> {
  const config: OpenClawConfig = {
    plugins: {
      allow: ["exec-proof"],
      entries: { "exec-proof": { enabled: true } },
    },
    models: {
      providers: {
        "exec-proof": {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              id: "proof-model",
              name: "Proof model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
              agentRuntime: { id: "exec-proof" },
            },
          ],
        },
      },
    },
    agents: { defaults: { model: { primary: "exec-proof/proof-model" } } },
  };
  if (workspace) {
    config.agents = { defaults: { ...config.agents?.defaults, workspace, skipBootstrap: true } };
  }
  await writeJson(path.join(stateDir, "openclaw.json"), config);
  const pluginDir = path.join(stateDir, "extensions", "exec-proof");
  await fs.mkdir(pluginDir, { recursive: true });
  await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: "exec-proof",
    name: "Agent exec proof harness",
    activation: { onStartup: false, onAgentHarnesses: ["exec-proof"] },
    configSchema: { type: "object", additionalProperties: false },
  });
  await writeJson(path.join(pluginDir, "package.json"), {
    name: "exec-proof",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `export default {
      id: "exec-proof",
      register(api) {
        api.registerAgentHarness({
          id: "exec-proof",
          label: "Agent exec proof harness",
          authBootstrap: "harness",
          supports: ({ provider }) => provider === "exec-proof"
            ? { supported: true, priority: 100 }
            : { supported: false },
          async runAttempt() {
            const text = "PLUGIN_HARNESS_OK";
            const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            const assistant = {
              role: "assistant",
              content: [{ type: "text", text }],
              api: "openai-responses",
              provider: "exec-proof",
              model: "proof-model",
              usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            };
            return {
              terminal: { kind: "ok" },
              sessionIdUsed: "exec-proof-session",
              messagesSnapshot: [assistant],
              assistantTexts: [text],
              toolMetas: [],
              lastAssistant: assistant,
              didSendViaMessagingTool: false,
              messagingToolSentTexts: [],
              messagingToolSentMediaUrls: [],
              messagingToolSentTargets: [],
              cloudCodeAssistFormatError: false,
              replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
              itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
            };
          },
        });
      },
    };\n`,
    "utf8",
  );
  await seedInstalledPluginIndex(
    {
      "exec-proof": {
        source: "path",
        sourcePath: pluginDir,
        installPath: pluginDir,
      },
    },
    {
      stateDir,
      config,
      candidates: [
        {
          idHint: "exec-proof",
          source: path.join(pluginDir, "index.js"),
          rootDir: pluginDir,
          origin: "global",
        },
      ],
    },
  );
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value), "utf8");
}

function buildChildEnv(stateDir: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete childEnv.NODE_ENV;
  delete childEnv.OPENCLAW_RUN_NODE_OUTPUT_LOG;
  delete childEnv.VITEST;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  return childEnv;
}

function runCli(stateDir: string, message: string, ...args: string[]) {
  return runBuiltScript(
    stateDir,
    `
    import { runMainOrRootHelp } from "./dist/entry.js";
    await runMainOrRootHelp(${JSON.stringify(["node", "openclaw", "agent", "exec", message, "--json", ...args])});
  `,
  );
}

function runBuiltScript(stateDir: string, source: string) {
  return execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: buildChildEnv(stateDir),
    timeout: 30_000,
  });
}

it.skipIf(process.platform === "win32")(
  "reclaims CLI transport descendants when the run times out",
  async ({ signal, onTestFinished }) => {
    const root = tempDirs.make("openclaw-agent-exec-auth-timeout-");
    const binDir = path.join(root, "bin");
    const processPath = path.join(root, "processes.jsonl");
    const stopPath = path.join(root, "stop");
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    await fs.mkdir(binDir);
    await fs.writeFile(
      path.join(binDir, "claude"),
      `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv[2] === "--version") {
  console.log("2.1.0 (Claude Code)");
} else {
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
    const fs = require("node:fs");
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(stopPath)})) process.exit(0);
    }, 25);
  `)}], { stdio: "inherit" });
  child.once("spawn", () => {
    fs.appendFileSync(${JSON.stringify(processPath)}, JSON.stringify({
      phase: process.argv[2] === "auth" ? "auth" : "agent",
      pids: [process.pid, child.pid, process.ppid],
    }) + "\\n");
  });
}
`,
      { mode: 0o755 },
    );
    await writeJson(path.join(root, "openclaw.json"), {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    });
    type ProcessReceipt = {
      phase: "auth" | "agent";
      pids: number[];
    };
    const readProcesses = async (): Promise<ProcessReceipt[]> =>
      (await fs.readFile(processPath, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ProcessReceipt);

    const controller = new AbortController();
    const operation = runNodeScript(
      [
        path.join(repoRoot, "openclaw.mjs"),
        "agent",
        "exec",
        "probe",
        "--config",
        path.join(root, "openclaw.json"),
        "--cwd",
        root,
        "--timeout",
        "1",
        "--json",
      ],
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: root,
        CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
        ANTHROPIC_API_KEY: "synthetic-proof-key",
        OPENCLAW_SERVICE_MARKER: "openclaw",
      },
      30_000,
      { cwd: root, signal: controller.signal },
    );
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        controller.abort();
        await operation;
        const pids = (await readProcesses()).flatMap((receipt) => receipt.pids);
        try {
          await fs.writeFile(stopPath, "");
        } catch (error) {
          // Even a failed stop marker must not strand fixture descendants.
          await Promise.all(pids.map(async (pid) => killPidIfAlive(pid)));
          throw error;
        } finally {
          // Cleanup hang guard after the owner signalled/killed transports, not a readiness race.
          await Promise.all(
            pids.map((pid) => waitForDead(pid, AbortSignal.timeout(TRANSPORT_CLEANUP_GUARD_MS))),
          );
        }
      })());
    cleanupFixture = cleanup;
    onTestFinished(cleanup);
    try {
      const result = await withinTest(operation, signal);
      expect(result, result.stderr).toMatchObject({ error: undefined, status: 2 });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "timeout" });
      const receipts = await readProcesses();
      expect(receipts.map(({ phase }) => phase)).toContain("agent");
      await Promise.all(
        receipts.flatMap(({ pids }) => pids.map((pid) => waitForDead(pid, signal))),
      );
    } finally {
      // Assert extinction before asking any leaked fixture children to exit.
      await cleanup();
    }
  },
);

it("runs an operator-installed harness without retaining run state", async () => {
  const stateDir = tempDirs.make("openclaw-agent-exec-plugin-e2e-");
  await writeHarnessPlugin(stateDir);
  const { stdout, stderr } = await runCli(stateDir, "prove plugin discovery");

  expect(stdout, stderr).not.toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    ok: true,
    status: "ok",
    final: "PLUGIN_HARNESS_OK",
    model: "proof-model",
    provider: "exec-proof",
  });
  await expect(
    runCli(stateDir, "prove isolated discovery", "--isolated", "--model", "exec-proof/proof-model"),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.not.stringContaining("PLUGIN_HARNESS_OK"),
  });
  expect((await fs.readdir(stateDir)).toSorted()).toEqual([
    "client",
    "extensions",
    "openclaw.json",
    "state",
  ]);
  const credentialFiles = await fs.readdir(path.join(stateDir, "client"));
  expect(credentialFiles).toContain("credentials.sqlite");
  expect(credentialFiles.every((file) => file.startsWith("credentials.sqlite"))).toBe(true);
  const registryFiles = await fs.readdir(path.join(stateDir, "state"));
  expect(registryFiles).toContain("openclaw.sqlite");
  expect(registryFiles.every((file) => file.startsWith("openclaw.sqlite"))).toBe(true);
  await expect(fs.stat(path.join(stateDir, "agents"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("exits naturally after a one-shot ingress turn with workspace skills", async () => {
  const stateDir = tempDirs.make("openclaw-agent-ingress-one-shot-");
  const workspace = path.join(stateDir, "workspace");
  const skillDir = path.join(workspace, "skills", "exit-proof");
  const outputPath = path.join(stateDir, "ingress-result.json");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: exit-proof\ndescription: One-shot ingress proof\n---\nUse the fixture.\n",
    "utf8",
  );
  await writeHarnessPlugin(stateDir, workspace);
  const source = `
      import fs from "node:fs";
      import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
      const result = await agentCommandFromIngress({
        agentId: "main",
        sessionId: "ingress-one-shot-session",
        message: "prove one-shot ingress completion",
        model: "exec-proof/proof-model",
        allowModelOverride: true,
        json: true,
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
        oneShotCliRun: true,
      }, {
        log() {},
        error: (...args) => console.error(...args),
        exit: (code) => { throw new Error("unexpected runtime exit " + code); },
      });
      fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(result));
    `;
  await runBuiltScript(stateDir, source);
  expect(JSON.parse(await fs.readFile(outputPath, "utf8"))).toMatchObject({
    payloads: [{ text: "PLUGIN_HARNESS_OK" }],
  });
});

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { loadExecApprovals } from "../infra/exec-approvals.js";
import * as logger from "../logger.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { ManagedRun, ProcessExtinctionResult } from "../process/supervisor/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { NodeHostClient } from "./client.js";
import { decodeClaudeCliNodeRunParams } from "./invoke-agent-cli-claude-params.js";
import { runClaudeCliNodeCommand } from "./invoke-agent-cli-claude.js";
import * as systemRun from "./invoke-system-run.js";
import type { RunResult } from "./invoke-types.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "./invoke.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Calls = Array<{ method: string; params: unknown }>;

function progressText(calls: Calls) {
  return calls
    .filter((call) => call.method === "node.invoke.progress")
    .map((call) => (call.params as { chunk: string }).chunk)
    .join("");
}

function invocationResult(calls: Calls) {
  return calls.find((call) => call.method === "node.invoke.result")?.params as
    | { ok?: boolean; payloadJSON?: string; error?: { code?: string; message?: string } }
    | undefined;
}

function decode(params: Record<string, unknown>) {
  return decodeClaudeCliNodeRunParams(
    JSON.stringify({ idleTimeoutMs: 1_000, timeoutMs: 2_000, ...params }),
  );
}

function frame(params: unknown): NodeInvokeRequestPayload {
  return {
    id: "invoke-1",
    nodeId: "node-1",
    command: "agent.cli.claude.run.v1",
    paramsJSON: JSON.stringify(params),
  };
}

function client(calls: Calls, onProgress?: () => void | Promise<void>): NodeHostClient {
  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "node.invoke.progress") {
        const pending = onProgress?.();
        if (pending) {
          await pending;
        }
      }
      return {} as T;
    },
  };
}

function observePromptRemoval(after: (target: string) => void, before?: () => Promise<void>) {
  const remove = fs.rm.bind(fs);
  return vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (!String(target).includes("openclaw-node-claude-prompt-")) {
      return await remove(target, options);
    }
    await before?.();
    try {
      await remove(target, options);
    } finally {
      after(String(target));
    }
  });
}

function observeSpawn(certification?: ProcessExtinctionResult) {
  const supervisor = getProcessSupervisor();
  const spawn = supervisor.spawn.bind(supervisor);
  let started: Promise<ManagedRun> | undefined;
  const spy = vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
    started = spawn(input);
    const run = await started;
    return certification
      ? {
          ...run,
          waitForExtinction: async () => {
            await Promise.all([run.wait(), run.waitForExtinction?.()]);
            return certification;
          },
        }
      : run;
  });
  return {
    async close() {
      vi.useRealTimers();
      try {
        await (await started)?.waitForExtinction?.();
      } finally {
        spy.mockRestore();
      }
    },
  };
}

async function invokeClaude(params: unknown, claudePath?: string, calls: Calls = []) {
  await handleInvoke(frame(params), client(calls), { current: async () => [] }, undefined, {
    claudePath,
  });
  return calls;
}

function expectSuccessfulRun(result: RunResult | undefined) {
  expect(result).toMatchObject({
    exitCode: 0,
    success: true,
    timedOut: false,
    noOutputTimedOut: false,
  });
}

async function invokeWithNativeAuth(
  source: string,
  inheritedEnv: Record<string, string>,
  params: Record<string, unknown> = {},
) {
  setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "off" } } });
  const { executable, runArgv } = await nativeCliFixture(source);
  let runResult: RunResult | undefined;
  const handleSystemRun = vi
    .spyOn(systemRun, "handleSystemRunInvoke")
    .mockImplementation(async (options) => {
      runResult = await options.runCommand(
        [...runArgv, ...options.params.command.slice(1)],
        undefined,
        { ...process.env, ...options.params.env, ...inheritedEnv } as Record<string, string>,
        options.params.timeoutMs ?? undefined,
      );
      await options.sendInvokeResult({ ok: true });
    });
  onTestFinished(() => handleSystemRun.mockRestore());
  const calls = await invokeClaude(
    { argv: ["-p"], idleTimeoutMs: 5_000, timeoutMs: 10_000, ...params },
    executable,
  );
  expectSuccessfulRun(runResult);
  return calls;
}

async function executableScript(source: string): Promise<string> {
  // realpath: macOS tmpdir is a /var -> /private/var symlink and the approval
  // plan canonicalizes argv[0]; raw mkdtemp paths pass on Linux but fail here.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-")));
  tempDirs.push(dir);
  const file = path.join(dir, "claude-test.cjs");
  await fs.writeFile(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return file;
}

async function nativeCliFixture(source: string) {
  const script = await executableScript(source);
  if (process.platform !== "win32") {
    // Keep the installed runtime's loader paths; POSIX can approve the script itself.
    return { executable: script, runArgv: [process.execPath, script] };
  }
  // Approval needs a distinct native CLI identity, but execution stays on the installed
  // runtime so teardown never races a launched copy that Windows still has locked.
  const executable = path.join(path.dirname(script), "claude-test.exe");
  await fs.copyFile(process.execPath, executable);
  return { executable, runArgv: [process.execPath, script] };
}

function runCommand(
  executable: string,
  input: Partial<Parameters<typeof runClaudeCliNodeCommand>[0]["request"]> = {},
  overrides: Partial<Parameters<typeof runClaudeCliNodeCommand>[0]> = {},
) {
  const request = { argv: ["-p"], idleTimeoutMs: 1_000, timeoutMs: 5_000, ...input };
  return runClaudeCliNodeCommand({
    client: client([]),
    frame: frame(request),
    request,
    // Run synthetic scripts with this runtime without relying on platform script dispatch.
    argv: [process.execPath, executable, ...request.argv],
    cwd: undefined,
    env: process.env as Record<string, string>,
    timeoutMs: request.timeoutMs,
    ...overrides,
  });
}

describe("Claude CLI node command", () => {
  it.runIf(process.platform !== "win32").each([true, false])(
    "rechecks node authorization after Claude prompt staging (revoke=%s)",
    async (revoke) => {
      const executable = await executableScript(
        'require("node:fs").writeFileSync("spawned.txt", "spawned"); process.stdout.write("approved\\n");',
      );
      const cwd = path.dirname(executable);
      const marker = path.join(cwd, "spawned.txt");
      const calls: Calls = [];
      let staged = 0;
      let stagedPrompt: string | undefined;
      const writeFile = fs.writeFile.bind(fs);
      await withEnvAsync({ OPENCLAW_HOME: cwd, PATH: "/usr/bin:/bin", HOME: cwd }, async () => {
        saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
        setRuntimeConfigSnapshot({ tools: { exec: { mode: "full" } } });
        const staging = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          await writeFile(...args);
          if (typeof args[0] !== "string" || path.basename(args[0]) !== "system-prompt.md") {
            return;
          }
          staged += 1;
          stagedPrompt = args[0];
          if (revoke) {
            const current = loadExecApprovals();
            current.defaults = { ...current.defaults, security: "deny", ask: "off" };
            saveExecApprovals(current);
          }
        });
        try {
          await invokeClaude(
            {
              argv: ["-p"],
              cwd,
              systemPrompt: "Synthetic authorization fixture",
              idleTimeoutMs: 5_000,
              timeoutMs: 10_000,
            },
            executable,
            calls,
          );
        } finally {
          staging.mockRestore();
        }
      });

      const reply = invocationResult(calls);
      const progress = progressText(calls);
      expect(staged).toBe(1);
      expect(existsSync(marker)).toBe(!revoke);
      expect(reply?.ok).toBe(!revoke);
      expect(progress).toBe(revoke ? "" : "approved\n");
      expect(calls.some((call) => call.method === "node.event")).toBe(false);
      if (revoke) {
        expect(reply?.error?.code).toBe("SYSTEM_RUN_DENIED");
        expect(reply?.error?.message).toContain("exec approval changed before execution");
        expect(stagedPrompt !== undefined && existsSync(stagedPrompt)).toBe(false);
      }
    },
  );

  it.each([
    { argv: ["--model"], error: "requires a value" },
    { argv: ["--mcp-config", "/tmp/mcp.json"], error: "unsupported Claude CLI argument" },
    { argv: ["--allowedTools", "Bash"], error: "unsupported Claude CLI argument" },
    // Tool policy must arrive as one comma-joined value; the multi-token
    // variadic form fails closed instead of parsing partially.
    { argv: ["--disallowedTools", "Bash", "Edit"], error: "unsupported Claude CLI argument" },
    {
      argv: ["-p", "--resume", "--dangerously-skip-permissions"],
      error: "requires a non-option value",
    },
    { argv: ["--permission-mode="], error: "requires a non-option value" },
    { argv: ["--permission-mode", "bypassPermissions"], error: "not allowed" },
    { argv: ["--permission-mode=bypassPermissions"], error: "not allowed" },
  ])("rejects unsafe argv $argv", async ({ argv, error }) => {
    await expect(decode({ argv })).rejects.toThrow(error);
  });

  it("rejects missing cwd and non-allowlisted environment", async () => {
    const forbiddenKey = ["OPENCLAW", "GATEWAY", "TOKEN"].join("_");
    for (const [params, error] of [
      [{ cwd: "/definitely/missing/openclaw-node-cwd" }, "cwd must be an existing directory"],
      [{ env: { [forbiddenKey]: "" } }, "environment key is not allowed"],
      [{ clearEnv: [forbiddenKey] }, "clearEnv key is not allowed"],
      [{ env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" } }, "environment key is not allowed"],
      [
        {
          env: {
            ANTHROPIC_API_KEY: "selected-api-key",
            CLAUDE_CODE_OAUTH_TOKEN: "selected-oauth-token",
          },
        },
        "exactly one Claude credential",
      ],
    ] as const) {
      await expect(decode({ argv: ["-p"], ...params })).rejects.toThrow(error);
    }
  });

  it("requires binary availability before consulting exec approval policy", async () => {
    const calls: Calls = [];
    const handleSystemRun = vi.spyOn(systemRun, "handleSystemRunInvoke");
    onTestFinished(() => handleSystemRun.mockRestore());
    await invokeClaude({ argv: ["-p"], idleTimeoutMs: 1_000, timeoutMs: 2_000 }, undefined, calls);

    expect(handleSystemRun).not.toHaveBeenCalled();
    expect(invocationResult(calls)).toMatchObject({
      ok: false,
      error: { message: "Claude CLI agent runs are unavailable" },
    });
  });

  it.each([
    { name: "unconfigured", config: {}, security: "full", ask: "off" },
    {
      name: "explicit ask",
      config: { tools: { exec: { mode: "ask" } } },
      security: "allowlist",
      ask: "on-miss",
    },
  ] as const)(
    "consults the system.run approval surface with a prompt-free command ($name)",
    async ({ config, security, ask }) => {
      setRuntimeConfigSnapshot(config);
      const { executable } = await nativeCliFixture("process.exit(0);");
      const argv = [
        "-p",
        "--output-format=stream-json",
        "--permission-mode=plan",
        "--resume",
        "session-1",
        "--fork-session",
      ];
      const calls: Calls = [];
      const handleSystemRun = vi
        .spyOn(systemRun, "handleSystemRunInvoke")
        .mockImplementation(async (options) => {
          expect(options.params.command).toEqual([executable, ...argv]);
          await options.sendInvokeResult({
            ok: false,
            error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
          });
        });
      onTestFinished(() => handleSystemRun.mockRestore());
      await invokeClaude(
        {
          argv,
          systemPrompt: "private prompt",
          idleTimeoutMs: 1_000,
          timeoutMs: 2_000,
        },
        executable,
        calls,
      );

      expect(calls.some((call) => call.method === "node.event")).toBe(false);
      expect(JSON.stringify(calls)).not.toContain("private prompt");
      const response = invocationResult(calls);
      expect(response?.ok).toBe(true);
      expect(JSON.parse(response?.payloadJSON ?? "{}")).toMatchObject({
        approvalRequired: true,
        security,
        ask,
        systemRunPlan: {
          argv: [executable, ...argv],
        },
      });
    },
  );

  it.each([
    { rawEnv: "CLAUDE_CODE_OAUTH_TOKEN", value: "selected-node-oauth" },
    { rawEnv: "ANTHROPIC_API_KEY", value: "selected-node-api-key" },
    { rawEnv: "CLAUDE_CODE_OAUTH_TOKEN", value: "" },
    { rawEnv: "ANTHROPIC_API_KEY", value: " \t " },
  ])(
    "forwards only nonblank $rawEnv through a child-only descriptor ($value)",
    async ({ rawEnv, value }) => {
      const calls = await invokeWithNativeAuth(
        `
const fs = require("node:fs");
const descriptor = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR ?? process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR;
const secret = descriptor ? fs.readFileSync(Number(descriptor), "utf8") : "native-login";
process.stdout.write(JSON.stringify({
  type: "result",
  result: secret,
  descriptor: descriptor ?? null,
  rawPresent: Object.hasOwn(process.env, "CLAUDE_CODE_OAUTH_TOKEN") || Object.hasOwn(process.env, "ANTHROPIC_API_KEY"),
  scrubPresent: Object.hasOwn(process.env, "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"),
  gitInstructionsDisabled: process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS,
}) + "\\n");`,
        {
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
          CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "8",
          CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "9",
        },
        {
          env: { [rawEnv]: value },
          clearEnv: [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
            "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
          ],
        },
      );
      const progress = progressText(calls);
      expect(JSON.parse(progress)).toMatchObject({
        result: value.trim() || "native-login",
        descriptor: value.trim() ? "3" : null,
        rawPresent: false,
        scrubPresent: false,
        gitInstructionsDisabled: "1",
      });
      expect(invocationResult(calls)).toMatchObject({
        ok: true,
        payloadJSON: expect.stringContaining('"exitCode":0'),
      });
    },
  );

  it.each([undefined, true] as const)(
    "uses native-only credential isolation only when requested (%s)",
    async (nativeAuthOnly) => {
      const calls = await invokeWithNativeAuth(
        `
process.stdout.write(JSON.stringify({
  type: "result",
  apiKey: process.env.ANTHROPIC_API_KEY,
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
  otherProvider: process.env.Openai_Api_Key,
  contextWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  color: process.env.NO_COLOR,
  longContext: process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
}) + "\\n");`,
        {
          ANTHROPIC_API_KEY: "node-native-api-key",
          CLAUDE_CODE_OAUTH_TOKEN: "node-native-oauth",
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
          Openai_Api_Key: "synthetic-other-provider",
        },
        {
          ...(nativeAuthOnly ? { nativeAuthOnly } : {}),
          env: {
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
            NO_COLOR: "1",
            CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
          },
        },
      );
      expect(invocationResult(calls)).toMatchObject({ ok: true });
      expect(JSON.parse(progressText(calls))).toEqual({
        type: "result",
        ...(nativeAuthOnly
          ? {}
          : {
              apiKey: "node-native-api-key",
              oauth: "node-native-oauth",
              otherProvider: "synthetic-other-provider",
            }),
        scrub: "1",
        contextWindow: "100000",
        color: "1",
        longContext: "1",
      });
    },
  );

  it("streams stdin-driven stdout and cleans up a node-local system prompt file", async () => {
    const executable = await executableScript(`
const fs = require("node:fs");
const promptFlag = process.argv.indexOf("--append-system-prompt-file");
const promptPath = process.argv[promptFlag + 1];
const systemPrompt = fs.readFileSync(promptPath, "utf8");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", session_id: "node-session", result: input }) + "\\n");
  process.stderr.write("node stderr\\nprompt=" + promptPath + "\\ncontent=" + systemPrompt);
});`);
    const calls: Calls = [];
    const result = await runCommand(
      executable,
      { stdin: "hello from gateway", systemPrompt: "node system prompt" },
      { client: client(calls) },
    );
    expectSuccessfulRun(result);
    const progress = progressText(calls);
    expect(progress).toContain('"session_id":"node-session"');
    expect(progress).toContain("hello from gateway");
    expect(result.stderr).toContain("node stderr");
    expect(result.stderr).toContain("content=node system prompt");
    const promptPath = result.stderr.match(/^prompt=(.+)$/mu)?.[1];
    expect(promptPath).toBeTruthy();
    await expect(fs.stat(promptPath ?? "")).rejects.toThrow();
  });

  it.for(["job-unavailable", "job-create-failed", "job-observation-failed"] as const)(
    "retains prompt artifacts and command success after %s certification",
    async (reason, { signal }) => {
      const executable = await executableScript(
        'process.stderr.write(process.argv[process.argv.indexOf("--append-system-prompt-file") + 1]);',
      );
      const certification: ProcessExtinctionResult =
        reason === "job-unavailable"
          ? { status: "uncertain", reason }
          : { status: "uncertain", reason, cause: new Error("Job certification unavailable") };
      const spawning = observeSpawn(certification);
      const decision = createDeferred();
      const warning = vi.spyOn(logger, "logWarn").mockImplementation((message) => {
        if (message.includes(reason)) {
          decision.resolve();
        }
      });
      const removal = observePromptRemoval(() => decision.resolve());
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = await withinTest(
          withEnvAsync({ OPENCLAW_SERVICE_MARKER: "openclaw" }, () =>
            runCommand(
              executable,
              { systemPrompt: "descendant-owned prompt", idleTimeoutMs: 5_000 },
              { signal },
            ),
          ),
          signal,
        );
        vi.useRealTimers();
        expect(result).toMatchObject({ exitCode: 0, success: true });
        const promptDir = path.dirname(result.stderr);
        expect(path.dirname(promptDir)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(promptDir)).toMatch(/^openclaw-node-claude-prompt-/u);
        expect(path.basename(result.stderr)).toBe("system-prompt.md");
        tempDirs.push(promptDir);
        await withinTest(decision.promise, signal);
        await expect(fs.readFile(result.stderr, "utf8")).resolves.toBe("descendant-owned prompt");
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(reason));
      } finally {
        await spawning.close().finally(() => {
          warning.mockRestore();
          removal.mockRestore();
        });
      }
    },
  );

  it("joins prompt removal admitted by the process certifier before returning", async ({
    signal,
  }) => {
    const executable = await executableScript('process.stdout.write(\'{"type":"result"}\\n\');');
    const removing = createDeferred();
    const release = createDeferred();
    const removed = createDeferred();
    const gatedClient = client([], () => removing.promise);
    const spy = observePromptRemoval(
      () => removed.resolve(),
      async () => {
        removing.resolve();
        await release.promise;
      },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withEnvAsync({ OPENCLAW_SERVICE_MARKER: "openclaw" }, async () => {
        const run = runCommand(
          executable,
          { systemPrompt: "synthetic prompt", idleTimeoutMs: 5_000 },
          { client: gatedClient, signal },
        );
        const settled = vi.fn();
        void run.then(settled, settled);
        try {
          await withinTest(removing.promise, signal);
          vi.useRealTimers();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(settled).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
          removing.resolve();
          release.resolve();
          await expect(run).resolves.toMatchObject({ success: true });
          await removed.promise;
        }
      });
    } finally {
      vi.useRealTimers();
      removing.resolve();
      release.resolve();
      spy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "retains the prompt for an authoritative descendant without delaying the root result",
    async ({ signal }) => {
      const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-prompt-"));
      tempDirs.push(markerDir);
      const marker = path.join(markerDir, "descendant-read");
      const receipts = await openFixtureReceiptChannel();
      try {
        const descendant = `
${fixtureReceiptClientSource(receipts.endpoint)}
import { readFileSync, writeFileSync } from "node:fs";
await awaitRelease(${JSON.stringify(marker)}, "read");
writeFileSync(${JSON.stringify(marker)}, readFileSync(process.argv[1], "utf8"));`;
        const executable = await executableScript(`
const { spawn } = require("node:child_process");
const prompt = process.argv[process.argv.indexOf("--append-system-prompt-file") + 1];
const child = spawn(process.execPath, ["--input-type=module", "-e",
  ${JSON.stringify(descendant)}, prompt
], { stdio: ["ignore", "ignore", "ignore", 3] });
child.unref();
process.stdout.write(JSON.stringify({ type: "result", result: prompt }) + "\\n");`);
        await withEnvAsync({ OPENCLAW_SERVICE_MARKER: "openclaw" }, async () => {
          const calls: Calls = [];
          const removed = createDeferred();
          let promptDir: string | undefined;
          const removal = observePromptRemoval((target) => {
            if (target === promptDir) {
              removed.resolve();
            }
          });
          const spawning = observeSpawn();
          // This test owns descendant lifetime; fixture startup does not advance command deadlines.
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            const result = await withinTest(
              runCommand(
                executable,
                { systemPrompt: "descendant-owned prompt", idleTimeoutMs: 2_000 },
                { client: client(calls), signal },
              ),
              signal,
            );
            vi.useRealTimers();
            expectSuccessfulRun(result);
            const output = progressText(calls);
            const promptPath = (JSON.parse(output) as { result: string }).result;
            promptDir = path.dirname(promptPath);

            await expect(fs.readFile(promptPath, "utf8")).resolves.toBe("descendant-owned prompt");
            receipts.release(marker, "read");
            // Removal follows certified descendant extinction, after its synchronous marker write.
            await withinTest(removed.promise, signal);
            expect(await fs.readFile(marker, "utf8")).toBe("descendant-owned prompt");
            await expect(fs.stat(promptPath)).rejects.toThrow();
          } finally {
            try {
              receipts.release(marker, "read");
            } finally {
              await spawning.close().finally(() => removal.mockRestore());
            }
          }
        });
      } finally {
        await receipts.close();
      }
    },
  );

  it("caps streamed output consistently with system.run", async () => {
    const executable = await executableScript(
      `let writes = 0;
function writeChunk() {
  if (writes++ < 80) {
    process.stdout.write("x".repeat(4096));
    setTimeout(writeChunk, 1);
    return;
  }
  process.stdout.write("\\n" + JSON.stringify({ type: "result", session_id: "tail-session", result: "done" }) + "\\n", () => process.stderr.write("late failure diagnostic"));
}
process.stdout.write(Buffer.concat([
  Buffer.alloc(199_997, 120), Buffer.from([0xe2, 0x82]), Buffer.from("A\\n")
]), writeChunk);`,
    );
    const calls: Calls = [];
    const result = await runCommand(executable, {}, { client: client(calls) });
    const progressBytes = calls
      .filter((call) => call.method === "node.invoke.progress")
      .reduce((sum, call) => sum + Buffer.byteLength((call.params as { chunk: string }).chunk), 0);

    const progress = progressText(calls);
    expect(progress.startsWith(`${"x".repeat(199_997)}�A`)).toBe(true);
    // OUTPUT_CAP_BYTES + TERMINAL_EVENT_MAX_BYTES from invoke-agent-cli-claude.ts.
    expect(progressBytes).toBeLessThanOrEqual(200_000 + 1024 * 1024);
    expect(progress).toContain('"session_id":"tail-session"');
    expect(result.truncated).toBe(true);
    expect(result.stderr).toContain("late failure diagnostic");
  });

  it.each([
    {
      idleTimeoutMs: 40,
      timeoutMs: 400,
      noOutputTimedOut: true,
      stderr: "Claude CLI produced no output before the idle timeout",
    },
    {
      idleTimeoutMs: 400,
      timeoutMs: 40,
      noOutputTimedOut: false,
      stderr: "Claude CLI exceeded the hard timeout",
    },
  ])("preserves the exact timeout result: $stderr", async (request) => {
    const executable = await executableScript("setInterval(() => {}, 1000);");
    const spawned = vi.spyOn(getProcessSupervisor(), "spawn");
    try {
      const result = await runCommand(executable, request);
      expect(spawned).toHaveBeenCalledOnce();
      const recorded = spawned.mock.results[0];
      if (recorded?.type !== "return") {
        throw new Error("CLI fixture did not create its supervised run");
      }
      const run = await recorded.value;
      const exit = await run.wait();
      // Preserve an observed native code; 124 is only the missing-code timeout fallback.
      expect(result).toMatchObject({
        exitCode: exit.exitCode ?? 124,
        timedOut: true,
        noOutputTimedOut: request.noOutputTimedOut,
        stderr: request.stderr,
        success: false,
        error: null,
      });
    } finally {
      spawned.mockRestore();
    }
  });

  it.each([
    { name: "spawn", command: "/definitely/not/a/claude-command", error: "ENOENT" },
    { name: "secret input", command: process.execPath, error: "secret delivery failed" },
    { name: "progress", command: process.execPath, error: "progress delivery failed" },
  ])("surfaces $name failures in the invocation result", async ({ name, command, error }) => {
    const request = { argv: ["-p"], idleTimeoutMs: 1_000, timeoutMs: 5_000 };
    const fail = () => {
      throw new Error(error);
    };
    const overrides: Partial<Parameters<typeof runClaudeCliNodeCommand>[0]> = {
      argv: [command, "-e", 'process.stdout.write("progress"); setInterval(() => {}, 1000)'],
    };
    if (name === "secret input") {
      overrides.secretInput = { fd: 3, createData: fail };
    }
    if (name === "progress") {
      overrides.client = { request: async () => fail() };
    }
    await expect(runCommand(command, request, overrides)).resolves.toMatchObject({
      exitCode: 1,
      success: false,
      timedOut: false,
      error: expect.stringContaining(error),
      stderr: expect.stringContaining(error),
    });
  });

  it("terminates an active Claude command when its invoke is cancelled", async () => {
    const executable = await executableScript(
      `process.stdout.write("ready"); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const request = { idleTimeoutMs: 5_000, timeoutMs: 10_000 };
    const calls: Calls = [];
    const { promise: progressObserved, resolve: resolveProgress } = createDeferred();
    const run = runCommand(executable, request, {
      client: client(calls, resolveProgress),
      signal: controller.signal,
    });

    await progressObserved;
    controller.abort();

    await expect(run).resolves.toMatchObject({
      exitCode: 130,
      success: false,
      timedOut: false,
      stderr: expect.stringContaining("cancelled"),
    });
  });

  it("does not spawn Claude when cancellation wins during approval", async () => {
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-marker-"));
    tempDirs.push(markerDir);
    const marker = path.join(markerDir, "spawned");
    const executable = await executableScript(
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`,
    );
    const controller = new AbortController();
    controller.abort();
    const request = { idleTimeoutMs: 5_000, timeoutMs: 10_000 };
    await expect(
      runCommand(executable, request, { signal: controller.signal }),
    ).resolves.toMatchObject({ exitCode: 130, success: false });
    await expect(fs.stat(marker)).rejects.toThrow();
  });
});

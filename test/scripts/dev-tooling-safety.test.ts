import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testing as prompt } from "../../scripts/anthropic-prompt-probe.ts";
import { testing as claude } from "../../scripts/debug-claude-usage.ts";
import { testing as discord } from "../../scripts/dev/discord-acp-plain-language-smoke.ts";
import { testing as realtime } from "../../scripts/dev/realtime-talk-live-smoke.ts";
import { testing as tui } from "../../scripts/dev/tui-pty-test-watch.ts";
import {
  maskIdentifier,
  parseBooleanEnv,
  previewForDevToolLog,
  redactHomePath,
  redactJsonValueForDevToolLog,
} from "../../scripts/lib/dev-tooling-safety.ts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

const tempDirs: string[] = [];
const testNodeExecPath = resolveTestNodeExecPath();
const promptProbeUrl = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.anthropicPromptProbe);
const fixtureToken = "sk-test1234567890abcdefghijklmnop"; // pragma: allowlist secret

async function tempDir(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function discordRequest(overrides: Partial<Parameters<typeof discord.requestDiscordJson>[0]>) {
  return discord.requestDiscordJson({
    method: "GET",
    path: "/channels/123/messages",
    headers: {},
    retries: 0,
    timeoutMs: 5,
    errorPrefix: "Discord API",
    ...overrides,
  });
}

function fetchResponse(response: Response): typeof fetch {
  return (() => Promise.resolve(response)) as typeof fetch;
}

function stalledResponse(headers?: HeadersInit) {
  return new Response(new ReadableStream({ start() {} }), { headers });
}

function spawnPrompt(claudeBin: string, env: NodeJS.ProcessEnv = {}, capture = false) {
  return spawn(process.execPath, resolveRuntimeWorkerArgv(promptProbeUrl), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_BIN: claudeBin,
      OPENCLAW_PROMPT_TRANSPORT: "direct",
      OPENCLAW_PROMPT_TIMEOUT_MS: "10000",
      ...env,
    },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
  });
}

function gatewayLeaderScript(descendantPidPath: string) {
  const descendantScript = [
    "process.on('SIGINT', () => {});",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
    "process.send('ready');",
    "process.disconnect();",
  ].join("");
  return [
    "import childProcess from 'node:child_process';",
    "import fs from 'node:fs';",
    "const descendant = childProcess.spawn(process.execPath, [",
    "  '--input-type=module',",
    `  '--eval', ${JSON.stringify(descendantScript)},`,
    "], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
    `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "process.on('SIGINT', () => process.exit(0));",
    "descendant.once('message', () => process.send(descendant.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

// Gateway stop reports leader exit; foreign descendants expose no join handle.
async function waitForExtinction(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessAlive(pid)) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`process still alive: ${pid}`, { cause: error });
  }
}

async function promptReadyBeforeSettlement(
  pidPath: string,
  operation: PromiseLike<unknown>,
  readyPath = pidPath,
): Promise<number> {
  // The fixture writes this record before its receipt; process exit travels separately.
  const recorded = () => existsSync(readyPath) && readFileSync(readyPath, "utf8").trim() !== "";
  const settled = Promise.resolve(operation).then(
    () => {
      if (!recorded()) {
        throw new Error("timed out waiting for condition");
      }
    },
    (error: unknown) => {
      if (!recorded()) {
        throw error;
      }
    },
  );
  await Promise.race([receipts.waitFor(pidPath, "ready"), settled]);
  return Number.parseInt(readFileSync(pidPath, "utf8"), 10);
}

function childClosed(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function captureChild(child: ReturnType<typeof spawn>) {
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => (output.stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (output.stderr += String(chunk)));
  const closed = childClosed(child);
  void closed.catch(() => undefined);
  return { output, closed };
}

async function withDescendantFixture(
  child: ReturnType<typeof spawn>,
  pidPath: string,
  signal: AbortSignal,
  check: (fixture: {
    closed: ReturnType<typeof childClosed>;
    ready: () => Promise<number>;
  }) => Promise<void>,
  ipc = false,
  group = false,
) {
  const message = ipc ? once(child, "message") : undefined;
  const closed = childClosed(child);
  void closed.catch(() => undefined);
  let descendantPid = 0;
  try {
    await check({
      closed,
      ready: async () => {
        descendantPid = message
          ? Number(
              (
                await withinTest(
                  awaitGateBeforeSettlement(message, closed, "timed out waiting for condition"),
                  signal,
                )
              )[0],
            )
          : await withinTest(promptReadyBeforeSettlement(pidPath, closed), signal);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        return descendantPid;
      },
    });
  } finally {
    if (child.pid && isProcessAlive(child.pid)) {
      process.kill(group ? -child.pid : child.pid, group ? "SIGKILL" : "SIGTERM");
    }
    const pid = descendantPid || (existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8")) : 0);
    await closed;
    if (pid && isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
}

async function promptFixture(prefix: string, mode?: Parameters<typeof writeFakePromptCli>[2]) {
  const root = await tempDir(prefix);
  const pidPath = path.join(root, "descendant.pid");
  return { root, pidPath, claudeBin: await writeFakePromptCli(root, pidPath, mode) };
}

async function logFixture(contents: string) {
  return writeFixture(await tempDir("openclaw-prompt-probe-log-"), "gateway.log", contents);
}

async function writeFixture(root: string, name: string, contents: string | string[]) {
  const filename = path.join(root, name);
  await fs.writeFile(filename, Array.isArray(contents) ? contents.join("\n") : contents, "utf8");
  return filename;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeShell(root: string, name: string, lines: string[]) {
  const filename = path.join(root, name);
  await fs.writeFile(filename, ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 });
  return filename;
}

async function writeFakePromptCli(
  root: string,
  descendantPidPath: string,
  mode: "blocking" | "leader-exit" | "escaped-output" = "blocking",
): Promise<string> {
  const descendantPath = await writeFixture(root, "fake-prompt-descendant.mjs", [
    'import fs from "node:fs";',
    fixtureReceiptClientSource(receipts.endpoint),
    'process.on("SIGINT", () => {});',
    'process.on("SIGTERM", () => {});',
    "fs.writeFileSync(process.argv[2], String(process.pid));",
    "setInterval(() => {}, 1000);",
    ...(mode === "escaped-output" ? ['fs.writeFileSync(process.argv[3], "ready");'] : []),
    'sendReceipt(process.argv[2], "ready");',
    "",
  ]);

  if (mode === "escaped-output") {
    const leaderPath = await writeFixture(root, "fake-prompt-leader.mjs", [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      `const child = spawn(${JSON.stringify(testNodeExecPath)}, ${JSON.stringify([
        descendantPath,
        descendantPidPath,
        path.join(root, "escaped.ready"),
      ])}, { detached: true, stdio: ["ignore", "inherit", "inherit"] });`,
      `fs.appendFileSync(${JSON.stringify(path.join(root, "launches.jsonl"))}, JSON.stringify({ pid: child.pid, args: process.argv.slice(2) }) + "\\n");`,
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
      "child.unref();",
      "setInterval(() => {}, 1000);",
      "",
    ]);
    return writeShell(root, "fake-prompt-cli.sh", [
      `exec ${quotePosixShellArg(testNodeExecPath)} ${quotePosixShellArg(leaderPath)} "$@"`,
    ]);
  }
  return writeShell(root, "fake-prompt-cli.sh", [
    `${quotePosixShellArg(testNodeExecPath)} ${quotePosixShellArg(descendantPath)} ${quotePosixShellArg(descendantPidPath)} >/dev/null 2>&1 &`,
    `while [ ! -s ${quotePosixShellArg(descendantPidPath)} ]; do sleep 0.01; done`,
    mode === "leader-exit" ? "exit 0" : "while :; do sleep 1; done",
  ]);
}

function runCli(scriptPath: string, args: string[]) {
  const child = spawn(testNodeExecPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const { output, closed } = captureChild(child);
  return closed.then(({ code }) => ({ status: code, ...output }));
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { force: true, recursive: true });
  }
});

describe("dev tooling safety helpers", () => {
  it("redacts secrets before truncating script log previews", () => {
    const preview = previewForDevToolLog(`prefix OPENAI_API_KEY=${fixtureToken} suffix`, 80);

    expect(preview).not.toContain(fixtureToken);
    expect(preview).toContain("OPENAI_API_KEY=");
  });

  it("recursively redacts JSON-ish detail values before printing smoke results", () => {
    const redacted = redactJsonValueForDevToolLog({
      nested: [{ message: `Authorization: Bearer ${fixtureToken}` }],
    }) as { nested: Array<{ message: string }> };

    expect(redacted.nested[0]?.message).not.toContain(fixtureToken);
    expect(redacted.nested[0]?.message).toContain("Authorization");
  });

  it("parses boolean env values explicitly", () => {
    expect(parseBooleanEnv({ fallback: false, name: "FLAG", raw: "yes" })).toBe(true);
    expect(parseBooleanEnv({ fallback: true, name: "FLAG", raw: "0" })).toBe(false);
    expect(() => parseBooleanEnv({ fallback: false, name: "FLAG", raw: "maybe" })).toThrow(
      /FLAG must be one of/u,
    );
  });

  it("redacts home paths and masks opaque ids", () => {
    expect(redactHomePath("/home/alice/.openclaw/state.json", "/home/alice")).toBe(
      "~/.openclaw/state.json",
    );
    expect(maskIdentifier("session-key-abcdef123456")).toBe("sessio...3456");
  });

  it("does not split boundary emoji in script log previews", () => {
    expect(previewForDevToolLog("123456😀tail", 10)).toBe("123456...");
  });
});

describe("script-specific dev tooling hardening", () => {
  it("rejects unknown Discord smoke drivers instead of silently using token mode", () => {
    expect(discord.parseDriverMode("webhook")).toBe("webhook");
    expect(() => discord.parseDriverMode("curl")).toThrow(/Invalid --driver/u);
  });

  it.each([
    ["Discord smoke", "scripts/dev/discord-acp-plain-language-smoke.ts", discord.parseArgs],
    ["TUI PTY watch", "scripts/dev/tui-pty-test-watch.ts", tui.parseOptions],
  ] as const)("rejects unknown %s args before launching work", async (_label, script, parse) => {
    expect(() => parse(["--wat"])).toThrow("Unknown argument: --wat");
    const result = await runCli(script, ["--wat"]);

    expect({ ...result, stderr: result.stderr.trim() }).toEqual({
      status: 1,
      stdout: "",
      stderr: "Unknown argument: --wat",
    });
  });

  it.each([
    [discord.parseArgs, ["--channel"], "--channel requires a value"],
    [discord.parseArgs, ["--channel="], "--channel requires a value"],
    [discord.parseArgs, ["--channel", "--json"], "--channel requires a value"],
    ...["--channel", "--token", "--timeout-ms", "--state-dir"].map(
      (flag) => [discord.parseArgs, [flag, "-h"], `${flag} requires a value`] as const,
    ),
    [realtime.parseRealtimeSmokeArgs, ["--wat"], "Unknown argument: --wat"],
    [
      realtime.parseRealtimeSmokeArgs,
      ["--openai-audio-cycles"],
      "--openai-audio-cycles requires a value",
    ],
    [
      realtime.parseRealtimeSmokeArgs,
      ["--openai-audio-cycles", "0"],
      "--openai-audio-cycles must be an integer >= 1",
    ],
    [
      realtime.parseRealtimeSmokeArgs,
      ["--openai-audio-cycles", "11"],
      "--openai-audio-cycles must be <= 10",
    ],
    [claude.parseArgs, ["--wat"], "Unknown argument: --wat"],
    [claude.parseArgs, ["--agent"], "--agent requires a value"],
    [claude.parseArgs, ["--agent="], "--agent requires a value"],
    [claude.parseArgs, ["--session-key", "--reveal"], "--session-key requires a value"],
    [claude.parseArgs, ["--session-key= "], "--session-key requires a value"],
  ] as const)("rejects malformed script arguments %j", (parse, args, error) => {
    expect(() => parse([...args])).toThrow(error);
  });

  it("redacts Discord webhook tokens from API paths", () => {
    const token = "webhook-secret-token-abcdef123456"; // pragma: allowlist secret
    const apiPath = `/webhooks/123/${token}?wait=true`;

    expect(discord.redactDiscordApiPath(apiPath)).not.toContain(token);
    expect(discord.redactDiscordApiPath(apiPath)).toContain("/webhooks/123/");
  });

  it("computes the remaining Discord smoke timeout budget", () => {
    expect(discord.remainingTimeoutMs(1_500, undefined, 1_000)).toBe(500);
    expect(() => discord.remainingTimeoutMs(1_000, undefined, 1_000)).toThrow(
      /exceeded total timeout/u,
    );
    expect(() =>
      discord.remainingTimeoutMs(1_000, () => new Error("request-specific timeout"), 1_000),
    ).toThrow("request-specific timeout");
  });

  it("aborts stalled Discord smoke fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = discordRequest({
      path: "/users/@me",
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/Discord API GET \/users\/@me exceeded timeout/u);
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    [
      "Discord smoke",
      () => discordRequest({ fetchImpl: fetchResponse(stalledResponse()) }),
      /Discord API GET \/channels\/123\/messages exceeded timeout/u,
    ],
    [
      "OpenAI realtime smoke",
      () =>
        realtime.createOpenAIClientSecret("test-key", {
          timeoutMs: 5,
          fetchImpl: fetchResponse(stalledResponse()),
        }),
      /OpenAI Realtime client secret request exceeded timeout/u,
    ],
    [
      "Claude usage",
      () =>
        claude.fetchAnthropicOAuthUsage("test-token", {
          timeoutMs: 5,
          fetchImpl: fetchResponse(stalledResponse({ "content-type": "application/json" })),
        }),
      /Anthropic OAuth usage request exceeded timeout/u,
    ],
  ] as const)("times out stalled %s response body reads", async (_name, request, error) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const rejection = expect(request()).rejects.toThrow(error);
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
  });

  it("bounds Discord smoke response bodies by content-length", async () => {
    const response = new Response("{}", {
      headers: { "content-length": "6" },
    });
    const request = discordRequest({
      timeoutMs: 50,
      responseBodyMaxBytes: 5,
      fetchImpl: fetchResponse(response),
    });

    await expect(request).rejects.toThrow(
      "Discord API GET /channels/123/messages response body exceeded 5 bytes",
    );
  });

  it("does not launch another Discord smoke retry after the timeout budget expires", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let calls = 0;
    const response = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({ retry_after: 1 }),
    } as Response;

    await expect(
      discordRequest({
        retries: 1,
        fetchImpl: (() => {
          calls += 1;
          return Promise.resolve(response);
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/exceeded total timeout/u);
    expect(calls).toBe(1);
  });

  it("rejects short flags as TUI PTY watch option values", () => {
    for (const flag of ["--mode", "--mirror-path"]) {
      expect(() => tui.parseOptions([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
  });

  it("keeps TUI PTY watch vitest args behind the separator", () => {
    expect(tui.parseOptions(["--mode", "all", "--", "--help"])).toMatchObject({
      mode: "all",
      vitestArgs: ["--help"],
    });
  });

  it("escalates stalled TUI PTY watch children after interrupt cleanup", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    const stopper = tui.createChildStopper(
      { kill: () => true },
      (_child, signal: NodeJS.Signals): void => {
        signals.push(signal);
      },
    );

    stopper.stop();
    expect(signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(signals).toEqual(["SIGINT", "SIGTERM"]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("restarts TUI PTY mirror reads when the mirror file is truncated", async () => {
    const root = await tempDir("openclaw-tui-watch-test-");
    const mirrorPath = await writeFixture(root, "mirror.ansi", "fresh");
    const result = await tui.readNewMirrorData(mirrorPath, 10, 1024);
    expect({ text: result.chunk.toString("utf8"), offset: result.offset }).toEqual({
      text: "fresh",
      offset: 5,
    });
  });

  it("drains all pending TUI PTY mirror chunks after the child exits", async () => {
    const root = await tempDir("openclaw-tui-watch-test-");
    const mirrorPath = await writeFixture(root, "mirror.ansi", "first-second-third");
    const chunks: string[] = [];
    const offset = await tui.drainNewMirrorData(
      mirrorPath,
      0,
      (chunk: Buffer) => chunks.push(chunk.toString("utf8")),
      6,
    );
    expect({ chunks, offset }).toEqual({
      chunks: ["first-", "second", "-third"],
      offset: "first-second-third".length,
    });
  });

  it("keeps only diagnostic tails from noisy TUI PTY child output", () => {
    const retained = tui.appendBufferTail(
      Buffer.from("0123456789", "utf8"),
      Buffer.from("abcdef", "utf8"),
      8,
    );

    expect(retained.toString("utf8")).toBe("89abcdef");
  });

  it.each([
    [
      realtime.resolveOpenAIHttpTimeoutMs,
      42,
      "2s",
      /OPENCLAW_REALTIME_OPENAI_HTTP_TIMEOUT_MS must be an integer/u,
    ],
    [
      claude.resolveFetchTimeoutMs,
      123,
      "1.5",
      /OPENCLAW_DEBUG_CLAUDE_USAGE_FETCH_TIMEOUT_MS must be an integer/u,
    ],
  ] as const)("validates timeout resolver %j", (resolve, expected, invalid, error) => {
    expect(resolve(String(expected))).toBe(expected);
    expect(() => resolve(invalid)).toThrow(error);
  });

  it.each([
    [["--help"], true, 1, false],
    [["--openai-only"], false, 1, true],
    [["--openai-audio-cycles", "3"], false, 3, false],
  ] as const)("parses realtime smoke arguments %j", (args, help, openAIAudioCycles, openAIOnly) => {
    expect(realtime.parseRealtimeSmokeArgs([...args])).toEqual({
      help,
      openAIAudioCycles,
      openAIOnly,
    });
  });

  it("formats OpenAI realtime smoke help without launching live checks", () => {
    expect(realtime.usage()).toContain(
      "Usage: node --import tsx scripts/dev/realtime-talk-live-smoke.ts",
    );
    expect(realtime.usage()).toContain("--openai-only");
    expect(realtime.usage()).toContain("--openai-audio-cycles");
  });

  it("chunks PCM input without copying or dropping bytes", async () => {
    const sent: Buffer[] = [];
    const chunkCount = await realtime.sendPcmAudioInChunks(
      {
        sendAudio: (audio: Buffer) => sent.push(audio),
      } as never,
      Buffer.from([1, 2, 3, 4, 5]),
      { chunkBytes: 2, delayMs: 0 },
    );

    expect(chunkCount).toBe(3);
    expect(Buffer.concat(sent)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(sent.map((chunk) => chunk.byteLength)).toEqual([2, 2, 1]);
    await expect(
      realtime.sendPcmAudioInChunks({ sendAudio: vi.fn() } as never, Buffer.alloc(1), {
        chunkBytes: 0,
        delayMs: 0,
      }),
    ).rejects.toThrow("PCM audio chunk size must be a positive integer");
  });

  it("matches normalized live audio transcript markers", () => {
    expect(realtime.transcriptIncludesMarker(["Glacier."], "glacier")).toBe(true);
    expect(
      realtime.transcriptIncludesMarker(
        ["Please reply with the single-word GLACIER!"],
        "single word glacier",
      ),
    ).toBe(true);
    expect(realtime.transcriptIncludesMarker(["ocean"], "glacier")).toBe(false);
  });

  it("resolves the realtime relay smoke to an existing Control UI module", () => {
    const modulePath = realtime.resolveGatewayRelayModulePath(process.cwd());

    expect(modulePath.endsWith("/ui/src/pages/chat/talk/gateway-relay.ts")).toBe(true);
    expect(existsSync(modulePath.slice("/@fs/".length))).toBe(true);
  });

  it("rejects unsafe OpenAI realtime SDP answer content-length values before reading", async () => {
    const maxBytes = realtime.OPENAI_HTTP_RESPONSE_MAX_BYTES;
    const body = {
      cancel: vi.fn(() => Promise.resolve()),
      getReader: vi.fn(() => {
        throw new Error("reader should not be acquired");
      }),
    };
    const response = {
      headers: new Headers({ "content-length": "9007199254740993" }),
      body,
    } as unknown as Response;

    await expect(
      realtime.readOpenAIRealtimeBrowserResponseText(
        response,
        "OpenAI Realtime SDP answer",
        maxBytes,
      ),
    ).rejects.toThrow(`OpenAI Realtime SDP answer response body exceeded ${maxBytes} bytes`);
    expect(body.getReader).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds OpenAI realtime smoke response body reads by streamed bytes", async () => {
    const maxBytes = realtime.OPENAI_HTTP_RESPONSE_MAX_BYTES;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(maxBytes + 1));
          controller.close();
        },
      }),
    );

    await expect(
      realtime.readBoundedText(response, "OpenAI Realtime test", maxBytes),
    ).rejects.toThrow(`OpenAI Realtime test response body exceeded ${maxBytes} bytes`);
  });

  it("rejects absolute-form URLs in the Anthropic capture proxy", () => {
    expect(
      prompt.resolveAnthropicUpstreamUrl(
        "/v1/messages?anthropic-version=2023-06-01",
        "https://api.anthropic.com",
      ),
    ).toBe("https://api.anthropic.com/v1/messages?anthropic-version=2023-06-01");
    expect(() =>
      prompt.resolveAnthropicUpstreamUrl(
        "http://169.254.169.254/latest/meta-data",
        "https://api.anthropic.com",
      ),
    ).toThrow(/refusing non-origin proxy request URL/u);
  });

  it("bounds Anthropic capture proxy request bodies", async () => {
    const request = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]) as never;
    const destroy = vi.spyOn(request, "destroy");

    await expect(prompt.readRequestBody(request, 12)).rejects.toThrow(
      "Anthropic capture proxy request body exceeded 12 bytes",
    );
    expect(destroy).toHaveBeenCalled();
  });

  it("reads only the bounded Anthropic prompt probe gateway log tail", async () => {
    const logPath = await logFixture(
      [
        `DO_NOT_PRINT_OLD_GATEWAY_LOG OPENAI_API_KEY=${fixtureToken}`,
        "x".repeat(256),
        `recent gateway tail Authorization: Bearer ${fixtureToken}`,
      ].join("\n"),
    );

    const tail = await prompt.readLogTail(logPath, 128);

    expect(tail).toContain("recent gateway tail");
    expect(tail).not.toContain("DO_NOT_PRINT_OLD_GATEWAY_LOG");
    expect(tail).not.toContain(fixtureToken);
  });

  it("drops partial Anthropic prompt probe log lines before redaction", async () => {
    const token = `sk-test${"a".repeat(80)}`; // pragma: allowlist secret
    const logPath = await logFixture(`Authorization: Bearer ${token}\nrecent gateway tail`);

    const tail = await prompt.readLogTail(logPath, "recent gateway tail".length + 24);

    expect(tail).toBe("recent gateway tail");
    expect(tail).not.toContain(token.slice(-16));
  });

  it("cleans Anthropic prompt probe temp dirs unless explicitly kept", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-probe-test-"));
    const keepRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-probe-test-"));

    expect(prompt.promptProbeTmpResult(tempRoot, false)).toEqual({});
    expect(prompt.promptProbeTmpResult(keepRoot, true)).toEqual({ tmpDir: keepRoot });

    await prompt.cleanupPromptProbeTmpDir(tempRoot, false);
    await prompt.cleanupPromptProbeTmpDir(keepRoot, true);

    await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(keepRoot)).resolves.toBeTruthy();
    await fs.rm(keepRoot, { force: true, recursive: true });
  });

  it.runIf(process.platform !== "win32")(
    "rejects direct prompt success with active descendants",
    async ({ signal }) => {
      const { pidPath: descendantPidPath, claudeBin } = await promptFixture(
        "openclaw-direct-normal-exit-",
        "leader-exit",
      );
      let descendantPid = 0;
      const result = prompt.runDirectPrompt("normal exit cleanup proof", {
        claudeBin,
        timeoutMs: 5_000,
      });
      void result.catch(() => undefined);

      await runQaGatewayFixture(
        async () => {
          descendantPid = await withinTest(
            promptReadyBeforeSettlement(descendantPidPath, result),
            signal,
          );
          await expect(withinTest(result, signal)).rejects.toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "terminated",
          });
          expect(isProcessAlive(descendantPid)).toBe(false);
        },
        async () => {
          if (!descendantPid && existsSync(descendantPidPath)) {
            descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
          }
          if (descendantPid && isProcessAlive(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
          }
          await result.catch(() => undefined);
          if (descendantPid) {
            await waitForExtinction(descendantPid, signal);
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports direct cleanup uncertainty on parent signal",
    async ({ signal }) => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-direct-unjoined-"));
      const owner = createVitestResourceOwner(tempRoot);
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      const fakeClaudeBin = await writeFakePromptCli(tempRoot, descendantPidPath, "escaped-output");
      const probe = spawnPrompt(
        fakeClaudeBin,
        {
          OPENCLAW_PROMPT_CAPTURE: "0",
          OPENCLAW_PROMPT_KEEP_TMP: "0",
          OPENCLAW_PROMPT_LIST_JSON: JSON.stringify(["cleanup uncertainty", "must not run"]),
          TMPDIR: tempRoot,
          TMP: tempRoot,
          TEMP: tempRoot,
        },
        true,
      );
      let descendantPid = 0;
      const { output, closed } = captureChild(probe);

      await runQaGatewayFixture(
        async () => {
          descendantPid = await withinTest(
            promptReadyBeforeSettlement(
              descendantPidPath,
              closed,
              path.join(tempRoot, "escaped.ready"),
            ),
            signal,
          );
          expect(readFileSync(path.join(tempRoot, "escaped.ready"), "utf8")).toBe("ready");
          expect(isProcessAlive(descendantPid)).toBe(true);
          probe.kill("SIGTERM");
          const exit = await withinTest(closed, signal);

          expect(isProcessAlive(descendantPid)).toBe(true);
          expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          expect(exit).toEqual({ code: 1, signal: null });
          expect(output.stderr).toContain(
            "Managed command cleanup could not verify child, process group, and output closure",
          );
          expect(output.stdout).toBe("");
          const launches = (await fs.readFile(path.join(tempRoot, "launches.jsonl"), "utf8"))
            .trim()
            .split("\n");
          expect(launches).toHaveLength(1);
        },
        async () => {
          const failures: unknown[] = [];
          if (probe.exitCode === null && probe.signalCode === null) {
            probe.kill("SIGTERM");
          }
          try {
            await closed;
          } catch (error) {
            failures.push(error);
          }
          // Rescue extra launches too, even when the one-prompt assertion fails.
          const ownedPids = new Set(descendantPid > 1 ? [descendantPid] : []);
          try {
            const journal = await fs.readFile(path.join(tempRoot, "launches.jsonl"), "utf8");
            for (const line of journal.trim().split("\n").filter(Boolean)) {
              const entry: unknown = JSON.parse(line);
              if (
                !entry ||
                typeof entry !== "object" ||
                !("pid" in entry) ||
                typeof entry.pid !== "number" ||
                !Number.isSafeInteger(entry.pid) ||
                entry.pid <= 1
              ) {
                throw new Error("Invalid escaped-child PID in the owned launch journal");
              }
              ownedPids.add(entry.pid);
            }
          } catch (error) {
            failures.push(error);
          }
          for (const pid of ownedPids) {
            try {
              killPidIfAlive(pid);
            } catch (error) {
              failures.push(error);
            }
          }
          const cleanup = await Promise.allSettled(
            [...ownedPids].map((pid) => waitForExtinction(pid, signal)),
          );
          failures.push(
            ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, `Fixture cleanup failed; retained ${tempRoot}`);
          }
          tempDirs.push(tempRoot);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns a terminal result after a direct prompt timeout",
    async () => {
      const tempRoot = await tempDir("openclaw-direct-prompt-tree-");
      const fakeClaudeBin = await writeShell(tempRoot, "blocking-prompt-cli.sh", [
        "while :; do sleep 1; done",
      ]);

      await expect(
        prompt.runDirectPrompt("timeout cleanup proof", {
          claudeBin: fakeClaudeBin,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        exitCode: null,
        ok: false,
        signal: "SIGKILL",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans direct prompt descendants on parent signal",
    async ({ signal }) => {
      const { pidPath: descendantPidPath, claudeBin } = await promptFixture(
        "openclaw-direct-parent-signal-",
      );
      const probe = spawnPrompt(claudeBin, {
        OPENCLAW_PROMPT_TEXT: "parent signal cleanup proof",
      });

      await withDescendantFixture(probe, descendantPidPath, signal, async ({ ready, closed }) => {
        const descendantPid = await ready();
        process.kill(probe.pid!, "SIGTERM");
        await expect(withinTest(closed, signal)).resolves.toEqual({ code: 143, signal: null });
        // runDirectPrompt joins its strict managed process tree before the parent exits.
        expect(isProcessAlive(descendantPid)).toBe(false);
      });
    },
  );

  it.each([
    { name: "waits for child exit after SIGKILL", exits: true, killWaitMs: 50 },
    { name: "bounds cleanup when the child never exits", exits: false, killWaitMs: 1 },
  ])("Anthropic prompt gateway cleanup $name", async ({ exits, killWaitMs }) => {
    const events = new EventEmitter();
    const signals: NodeJS.Signals[] = [];
    const log = { close: vi.fn(async () => {}) };
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        if (exits && signal === "SIGKILL") {
          setTimeout(() => {
            child.signalCode = "SIGKILL";
            events.emit("exit");
          }, 1);
        }
        return exits;
      },
      once(event: "exit", listener: () => void) {
        events.once(event, listener);
      },
    };

    const stopped = await prompt.stopGatewayPromptChild(child, log, 1, killWaitMs);

    expect(stopped).toBe(exits);
    expect(signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(log.close).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform !== "win32")(
    "cleans gateway descendants after leader exit",
    async ({ signal }) => {
      const tempRoot = await tempDir("openclaw-prompt-gateway-tree-");
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      const leaderScript = gatewayLeaderScript(descendantPidPath);
      const child = spawn(process.execPath, ["--input-type=module", "--eval", leaderScript], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const spawned = once(child, "spawn");
      const log = { close: vi.fn(async () => {}) };
      await withDescendantFixture(
        child,
        descendantPidPath,
        signal,
        async ({ ready }) => {
          await withinTest(spawned, signal);
          const descendantPid = await ready();
          const stopped = await prompt.stopGatewayPromptChild(
            child as Parameters<typeof prompt.stopGatewayPromptChild>[0],
            log,
            50,
            100,
          );

          expect(stopped).toBe(true);
          expect(log.close).toHaveBeenCalledTimes(1);
          await waitForExtinction(descendantPid, signal);
        },
        true,
        true,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans gateway descendants attached after parent signal",
    async ({ signal }) => {
      const tempRoot = await tempDir("openclaw-prompt-parent-signal-");
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      const leaderScript = gatewayLeaderScript(descendantPidPath);
      const runnerPath = await writeFixture(tempRoot, "parent-signal-runner.mjs", [
        "import childProcess from 'node:child_process';",
        "import fs from 'node:fs';",
        `const { testing } = await import(${JSON.stringify(promptProbeUrl.href)});`,
        "const signalController = testing.createPromptProbeParentSignalController();",
        `const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(leaderScript)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
        "let stopPromise;",
        "const stopGateway = () => {",
        "  stopPromise ??= testing.stopGatewayPromptChild(child, { close: async () => {} }, 50, 100);",
        "  return stopPromise;",
        "};",
        "process.on('SIGTERM', () => {",
        "  signalController.attach({",
        "    stop: stopGateway,",
        "    forceKill: () => {",
        "      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }",
        "    },",
        "  });",
        "});",
        "child.once('message', pid => process.send(pid));",
        "setInterval(() => {}, 1000);",
      ]);
      const runner = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(promptProbeUrl).slice(0, -1), runnerPath],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      await withDescendantFixture(
        runner,
        descendantPidPath,
        signal,
        async ({ ready, closed }) => {
          const descendantPid = await ready();
          process.kill(runner.pid!, "SIGTERM");
          await expect(withinTest(closed, signal)).resolves.toEqual({ code: 143, signal: null });
          await waitForExtinction(descendantPid, signal);
        },
        true,
      );
    },
  );

  it("waits for Anthropic prompt gateway log writes before closing the log file", async () => {
    let resolveWrite: (() => void) | undefined;
    const order: string[] = [];
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = () => {
        order.push("write");
        resolve();
      };
    });
    const stop = prompt.stopGatewayPromptChild(
      {
        exitCode: 0,
        signalCode: null,
        kill: () => true,
        once(_event: "exit", _listener: () => void) {},
      },
      {
        close: async () => {
          order.push("close");
        },
      },
      1,
      1,
      [pendingWrite],
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(order).toEqual([]);

    resolveWrite?.();
    await expect(stop).resolves.toBe(true);
    expect(order).toEqual(["write", "close"]);
  });

  it("uses exact Claude cookie host matchers instead of broad substring matches", () => {
    expect(claude.CLAUDE_COOKIE_HOST_SQL).toContain("host_key = 'claude.ai'");
    expect(claude.CLAUDE_COOKIE_HOST_SQL).toContain("LIKE '%.claude.ai'");
    expect(claude.CLAUDE_COOKIE_HOST_SQL).not.toContain("%claude.ai%");
  });

  it("rejects malformed Claude usage args before reading auth or browser state", () => {
    expect(claude.parseArgs(["--agent", "work", "--session-key=abc"])).toEqual({
      agentId: "work",
      help: false,
      reveal: false,
      sessionKey: "abc",
    });
    expect(claude.parseArgs(["--help"])).toEqual({
      agentId: "main",
      help: true,
      reveal: false,
      sessionKey: undefined,
    });
  });

  it.each([
    { name: "before response headers", sendsHeaders: false },
    { name: "during the response body", sendsHeaders: true },
  ])("bounds an Anthropic upstream stall $name", async ({ sendsHeaders }) => {
    const nativeFetch = globalThis.fetch;
    const upstream = http.createServer((_request, response) => {
      if (sendsHeaders) {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        // Start an incomplete body so fetch exposes the streaming response before it stalls.
        response.write('{"partial":');
      }
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("upstream did not bind to a TCP port");
    }
    const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/v1/messages`;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => nativeFetch(upstreamUrl, init));
    let proxy: Awaited<ReturnType<typeof prompt.startAnthropicProxy>> | undefined;

    try {
      proxy = await prompt.startAnthropicProxy({
        port: 0,
        upstreamBaseUrl: "https://api.anthropic.com",
        timeoutMs: 100,
      });
      const startedAt = Date.now();
      const proxyUrl = `http://127.0.0.1:${proxy.port}/v1/messages`;
      const request = sendsHeaders
        ? (async (): Promise<{ status: number; body: string }> => {
            const downstream = spawn(
              testNodeExecPath,
              [
                "-e",
                `fetch(process.argv[1], { method: "POST", body: "{}" })
                  .then(async response => ({ status: response.status, body: await response.text() }))
                  .then(result => process.stdout.write(JSON.stringify(result)))
                  .catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });`,
                proxyUrl,
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            const { output, closed } = captureChild(downstream);
            const { code } = await closed;
            if (code !== 0) {
              throw new Error(output.stderr || `proxy client exited ${String(code)}`);
            }
            return JSON.parse(output.stdout);
          })()
        : nativeFetch(proxyUrl, { method: "POST", body: "{}" }).then(async (response) => ({
            status: response.status,
            body: await response.text(),
          }));

      if (sendsHeaders) {
        await expect(request).rejects.toThrow();
      } else {
        await expect(request).resolves.toMatchObject({
          status: 502,
          body: expect.stringMatching(/Anthropic upstream timed out after 100ms/u),
        });
      }
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      fetchSpy.mockRestore();
      await proxy?.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

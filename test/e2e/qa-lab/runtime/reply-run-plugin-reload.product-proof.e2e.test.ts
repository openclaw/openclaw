// Product proof for #144809: a plugin hot reload that lands after the 300 s
// channel-reload deferral must not discard the reply of a claude-cli turn that
// is still running. Runs a real Gateway with a fake `claude` executable on PATH
// that speaks the stdio protocol and answers only after the reload has applied.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const CHANNEL_ID = "qa-channel";
const ACCOUNT_ID = "default";
const PEER_ID = "reload-peer";
const CLI_MODEL = "claude-cli/claude-opus-5";
const TURN_MS = Number(process.env.OPENCLAW_E2E_PLUGIN_RELOAD_PROOF_TURN_MS ?? 340_000);

type GatewayHarness = Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>>;

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let harness: GatewayHarness | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
// Minimal claude-stdio protocol: initialize handshake, one user turn, delayed result.
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const dir = process.env.FAKE_CLAUDE_DIR;
const log = (line) => fs.appendFileSync(path.join(dir, "fake-claude.log"), new Date().toISOString() + " pid=" + process.pid + " " + line + "\n");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("2.1.300 (Claude Code)\n"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "qa@example.com" }) + "\n");
  process.exit(0);
}
log("spawn argv=" + JSON.stringify(argv));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sessionIdx = argv.indexOf("--session-id");
const sessionId = sessionIdx >= 0 ? argv[sessionIdx + 1] : require("node:crypto").randomUUID();
const turnMs = Number(process.env.FAKE_CLAUDE_TURN_MS || "340000");
let resultEmitted = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { log("signal " + sig + (resultEmitted ? " (exit)" : " (ignored, turn in flight)")); if (resultEmitted) process.exit(0); });
}
process.stdin.on("end", () => { log("stdin end"); if (resultEmitted) process.exit(0); });
setInterval(() => {}, 60_000);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { log("non-json line bytes=" + line.length); return; }
  if (message.type === "control_request" && message.request && message.request.subtype === "initialize") {
    log("initialize received");
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: [] } } });
    return;
  }
  if (message.type === "control_request") {
    log("control_request subtype=" + (message.request && message.request.subtype) + " request_id=" + message.request_id);
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type === "control_cancel_request") { log("control_cancel_request " + message.request_id); return; }
  if (message.type === "user") {
    const content = message.message && message.message.content;
    log("user turn received uuid=" + message.uuid + " contentHead=" + JSON.stringify(String(typeof content === "string" ? content : JSON.stringify(content)).slice(0, 120)));
    fs.writeFileSync(path.join(dir, "turn-started.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    send({ type: "system", subtype: "init", session_id: sessionId, model: "claude-opus-5", tools: [], cwd: process.cwd() });
    setTimeout(() => {
      const text = "fake-claude reply " + sessionId;
      send({ type: "assistant", message: { id: "msg_1", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] }, session_id: sessionId });
      send({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, duration_ms: turnMs, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } });
      resultEmitted = true;
      log("turn finished (result emitted)");
      fs.writeFileSync(path.join(dir, "turn-finished.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    }, turnMs);
    return;
  }
  log("other message type=" + message.type);
});
`;

async function waitFor<T>(
  label: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function readLog(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

afterEach(async () => {
  const errors: unknown[] = [];
  try {
    if (gatewayOwner) {
      await stopQaGatewayFixture(gatewayOwner);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    harness = undefined;
    gatewayOwner = undefined;
  }
  try {
    await bus?.stop();
  } catch (error) {
    errors.push(error);
  } finally {
    bus = undefined;
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "reload repro cleanup failed");
  }
});

describe.runIf(process.env.OPENCLAW_E2E_PLUGIN_RELOAD_PROOF === "1")(
  "claude-cli reply survives a plugin hot reload landing mid-turn (#144809)",
  () => {
    it(
      "delivers the reply of a turn that outlives the forced plugin reload",
      { timeout: 1_200_000 },
      async () => {
        const fakeRoot = process.env.OPENCLAW_E2E_PLUGIN_RELOAD_PROOF_DIR ?? os.tmpdir();
        fs.mkdirSync(fakeRoot, { recursive: true });
        const fakeDir = fs.mkdtempSync(path.join(fakeRoot, "fake-claude-"));
        const fakeBin = path.join(fakeDir, "claude");
        fs.writeFileSync(fakeBin, FAKE_CLAUDE, { mode: 0o755 });
        process.env.PATH = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.FAKE_CLAUDE_DIR = fakeDir;
        process.env.FAKE_CLAUDE_TURN_MS = String(TURN_MS);

        const state = createQaBusState();
        const transport = createQaChannelTransport(state);
        bus = await startQaBusServer({ state });
        gatewayOwner = createQaLiveLaneGateway();
        harness = await gatewayOwner.start({
          repoRoot: process.cwd(),
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          transport,
          transportBaseUrl: bus.baseUrl,
          controlUiEnabled: false,
          mutateConfig: (config) => ({
            ...config,
            plugins: {
              ...config.plugins,
              allow: [...new Set([...(config.plugins?.allow ?? []), "anthropic"])],
              entries: { ...config.plugins?.entries, anthropic: { enabled: true } },
            },
            agents: {
              ...config.agents,
              defaults: {
                ...config.agents?.defaults,
                model: CLI_MODEL,
                models: { ...config.agents?.defaults?.models, [CLI_MODEL]: {} },
                modelPolicy: {
                  allow: [...(config.agents?.defaults?.modelPolicy?.allow ?? []), CLI_MODEL],
                },
              },
              entries: {
                ...config.agents?.entries,
                qa: { ...config.agents?.entries?.qa, model: CLI_MODEL },
              },
            },
          }),
        });
        const { gateway } = harness;
        const stdoutLog = path.join(gateway.tempRoot, "gateway.stdout.log");
        const stderrLog = path.join(gateway.tempRoot, "gateway.stderr.log");
        const record: Record<string, unknown> = { turnMs: TURN_MS, tempRoot: gateway.tempRoot };

        state.addInboundMessage({
          accountId: ACCOUNT_ID,
          conversation: { kind: "direct", id: PEER_ID },
          senderId: PEER_ID,
          text: `reload repro ${randomUUID()}`,
        });
        const started = await waitFor(
          "fake claude turn start",
          () => (fs.existsSync(path.join(fakeDir, "turn-started.json")) ? true : undefined),
          90_000,
        );
        record.turnStartedAt = new Date().toISOString();
        expect(started).toBe(true);
        await delay(5_000);

        const configBefore = (await gateway.call("config.get", {})) as {
          hash?: string;
          config?: { plugins?: { allow?: string[] } };
        };
        const allowBefore = configBefore.config?.plugins?.allow ?? [];
        record.allowBefore = allowBefore;
        // Mirror the reporter: a channel-affecting change plus a plugins.* change
        // (plugins.* forces reloadPlugins + disposeMcpRuntimes in the reload plan).
        const patchRaw = {
          channels: { [CHANNEL_ID]: { pollTimeoutMs: 700 } },
          plugins: { allow: [...new Set([...allowBefore, "discord"])] },
        };
        // config.patch blocks until the deferred reload applies (300 s), so do not await it.
        const patchPromise = gateway
          .call(
            "config.patch",
            {
              raw: JSON.stringify(patchRaw),
              baseHash: configBefore.hash,
              replacePaths: ["plugins.allow"],
              restartDelayMs: 0,
            },
            { timeoutMs: 900_000 },
          )
          .then(
            (result) => {
              record.patchResult = result;
              record.patchResolvedAt = new Date().toISOString();
            },
            (error: unknown) => {
              record.patchError = String(error);
              record.patchResolvedAt = new Date().toISOString();
            },
          );
        record.patchedAt = new Date().toISOString();

        await waitFor(
          "channel reload deferral log line",
          () =>
            /requires channel reload|deferring until/.test(
              `${readLog(stdoutLog)}\n${readLog(stderrLog)}`,
            )
              ? true
              : undefined,
          60_000,
        );
        record.deferralSeen = true;

        const finished = await waitFor(
          "fake claude turn finish",
          () => (fs.existsSync(path.join(fakeDir, "turn-finished.json")) ? true : undefined),
          TURN_MS + 120_000,
          2_000,
        ).catch((error: unknown) => String(error));
        record.turnFinished = finished;
        await delay(20_000);

        await Promise.race([patchPromise, delay(30_000)]);
        const outbound = state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .map((message) => ({ accountId: message.accountId, text: message.text }));
        const stdout = `${readLog(stdoutLog)}\n${readLog(stderrLog)}`;
        const interesting = stdout
          .split("\n")
          .filter((line) =>
            /authority snapshot|\[reload\]|cli turn|cli-backend|Embedded agent|failed before|aborted|reply run|stopping qa-channel|restarting qa-channel|channel reload/i.test(
              line,
            ),
          )
          .map((line) => line.replace(/\[[0-9;]*m/g, "").slice(0, 400));
        record.outbound = outbound;
        record.gatewayLines = interesting;
        record.fakeClaudeLog = readLog(path.join(fakeDir, "fake-claude.log"));
        record.stderrTail = readLog(stderrLog).slice(-2000);
        const verdictPath = path.join(fakeDir, "verdict.json");
        fs.writeFileSync(verdictPath, JSON.stringify(record, null, 2));
        console.log(`PLUGIN_RELOAD_PROOF ${verdictPath}`);
        console.log(JSON.stringify(record, null, 2));

        expect(finished).toBe(true);
        expect(interesting.some((line) => line.includes("reloading channels anyway"))).toBe(true);
        expect(
          interesting.some((line) =>
            line.includes("stopping qa-channel channel before plugin reload"),
          ),
        ).toBe(true);
        expect(
          interesting.filter((line) => /stream is closed|failed before reply/.test(line)),
        ).toEqual([]);
        expect(outbound.map((message) => message.text)).toEqual([
          expect.stringMatching(/^fake-claude reply /),
        ]);
      },
    );
  },
);

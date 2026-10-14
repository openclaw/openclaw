// Product proof for the reload path in #144809: replacing the active backend
// during a channel config reload must not discard an admitted claude-cli reply.
// Runs a real Gateway with a fake `claude` executable on PATH
// that speaks the stdio protocol and answers only after the reload has applied.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
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

type PatchOutcome = { ok: true; result: unknown } | { ok: false; error: string };

// oxlint-disable-next-line no-control-regex -- terminal color escapes in Gateway logs
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (line: string) => line.replace(ANSI_ESCAPE, "");

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
    vi.unstubAllEnvs();
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
        vi.stubEnv("PATH", `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`);
        vi.stubEnv("FAKE_CLAUDE_DIR", fakeDir);
        vi.stubEnv("FAKE_CLAUDE_TURN_MS", String(TURN_MS));

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
              entries: {
                ...config.plugins?.entries,
                anthropic: { enabled: true, subagent: { allowModelOverride: true } },
              },
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
        const readGatewayLogs = () => `${readLog(stdoutLog)}\n${readLog(stderrLog)}`;
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
        const pluginsBefore = (await gateway.call("plugins.list", {})) as { generation: number };
        record.generationBefore = pluginsBefore.generation;
        // A per-plugin entry change explicitly replaces Anthropic; unrelated allowlist
        // changes retain it. Tighten an unused fixture policy while preserving the
        // channel change that exercises active-work deferral and channel restart.
        const patchRaw = {
          channels: { [CHANNEL_ID]: { pollTimeoutMs: 700 } },
          plugins: { entries: { anthropic: { subagent: { allowModelOverride: false } } } },
        };
        // Observe publication while config.patch awaits the reload's channel tail.
        const patchPromise = gateway
          .call(
            "config.patch",
            {
              raw: JSON.stringify(patchRaw),
              baseHash: configBefore.hash,
              restartDelayMs: 0,
            },
            { timeoutMs: 900_000 },
          )
          .then(
            (result): PatchOutcome => ({ ok: true, result }),
            (error: unknown): PatchOutcome => ({ ok: false, error: String(error) }),
          )
          .then((outcome) => {
            record.patchOutcome = outcome;
            record.patchResolvedAt = new Date().toISOString();
            return outcome;
          });
        record.patchedAt = new Date().toISOString();

        await waitFor(
          "channel reload deferral log line",
          () =>
            /requires channel reload|deferring until/.test(readGatewayLogs()) ? true : undefined,
          60_000,
        );
        record.deferralSeen = true;

        // The reload must observably commit its plugin replacement before the CLI
        // result exists; otherwise the turn never exercised retirement.
        const turnFinishedPath = path.join(fakeDir, "turn-finished.json");
        const appliedLine = await waitFor(
          "committed plugin reload before the CLI result",
          () => {
            if (fs.existsSync(turnFinishedPath)) {
              throw new Error(
                "CLI turn finished before the plugin reload applied; retirement was not exercised",
              );
            }
            const line = readGatewayLogs()
              .split("\n")
              .map(stripAnsi)
              .find(
                (candidate) =>
                  candidate.includes("config hot reload applied (") &&
                  candidate.includes("plugins.entries.anthropic"),
              );
            return line ?? undefined;
          },
          TURN_MS + 60_000,
          2_000,
        );
        record.appliedLine = appliedLine;
        const configAfter = (await gateway.call("config.get", {})) as {
          hash?: string;
          appliedConfigHash?: string | null;
          configRevisionHash?: string;
          config?: {
            plugins?: { entries?: { anthropic?: { subagent?: { allowModelOverride?: boolean } } } };
            channels?: Record<string, { pollTimeoutMs?: number }>;
          };
        };
        record.configAfter = {
          hash: configAfter.hash,
          appliedConfigHash: configAfter.appliedConfigHash,
          configRevisionHash: configAfter.configRevisionHash,
          anthropic: configAfter.config?.plugins?.entries?.anthropic,
          pollTimeoutMs: configAfter.config?.channels?.[CHANNEL_ID]?.pollTimeoutMs,
        };
        // appliedConfigHash is published by the reload/restart publication; the
        // forced qa-channel restart is refused under its own active turn, so a
        // recovery restart stays pending and that hash is not asserted here. The
        // committed content plus the applied log line are the replacement evidence.
        expect(configAfter.hash).not.toBe(configBefore.hash);
        expect(configAfter.config?.plugins?.entries?.anthropic?.subagent?.allowModelOverride).toBe(
          false,
        );
        const pluginsAfter = (await gateway.call("plugins.list", {})) as {
          generation: number;
          plugins: Array<{ id: string; runtime: { state: string } }>;
        };
        record.generationAfter = pluginsAfter.generation;
        expect(pluginsAfter.generation).toBeGreaterThan(pluginsBefore.generation);
        expect(
          pluginsAfter.plugins.find((plugin) => plugin.id === "anthropic")?.runtime.state,
        ).toBe("active");
        expect(configAfter.config?.channels?.[CHANNEL_ID]?.pollTimeoutMs).toBe(700);
        // config.patch must settle before the CLI result. It may report that the
        // committed change still needs a recovery restart (the forced qa-channel
        // restart under its own active turn is refused), but a rejected or
        // pending replacement fails the proof.
        const patchOutcome = await Promise.race([
          patchPromise,
          delay(60_000).then((): PatchOutcome => ({
            ok: false,
            error: "config.patch still pending",
          })),
        ]);
        if (fs.existsSync(turnFinishedPath)) {
          throw new Error("CLI turn finished before config.patch settled");
        }
        if (
          !patchOutcome.ok &&
          !patchOutcome.error.includes("persisted and updated the active Gateway")
        ) {
          throw new Error(`config.patch did not commit the replacement: ${patchOutcome.error}`);
        }

        // This owner-emitted observation names the retired backend, not merely a
        // changed registry: its physical cleanup is waiting for this admitted turn.
        const retirementLine = await waitFor(
          "retired Anthropic instance before the CLI result",
          () => {
            if (fs.existsSync(turnFinishedPath)) {
              throw new Error("CLI turn finished before Anthropic retirement was observed");
            }
            return readGatewayLogs()
              .split("\n")
              .map(stripAnsi)
              .find((line) =>
                line.includes(
                  "Plugin anthropic cleanup is deferred until its admitted turn finishes.",
                ),
              );
          },
          20_000,
        );
        record.retirementLine = retirementLine;

        const finished = await waitFor(
          "fake claude turn finish",
          () => (fs.existsSync(path.join(fakeDir, "turn-finished.json")) ? true : undefined),
          TURN_MS + 120_000,
          2_000,
        ).catch((error: unknown) => String(error));
        record.turnFinished = finished;
        await waitFor(
          "outbound reply after CLI completion",
          () =>
            state.getSnapshot().messages.some((message) => message.direction === "outbound")
              ? true
              : undefined,
          20_000,
        );
        const outbound = state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .map((message) => ({ accountId: message.accountId, text: message.text }));
        const stdout = readGatewayLogs();
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
        const cliTurnLine = interesting.find((line) => line.includes("] cli turn: "));
        expect(cliTurnLine).toBeDefined();
        const appliedAt = Date.parse(appliedLine.slice(0, 29));
        const cliTurnAt = Date.parse((cliTurnLine ?? "").slice(0, 29));
        expect(Number.isFinite(appliedAt) && Number.isFinite(cliTurnAt)).toBe(true);
        expect(appliedAt).toBeLessThan(cliTurnAt);
        const channelRestartLine = interesting.find((line) =>
          line.includes("restarting qa-channel channel"),
        );
        expect(channelRestartLine).toBeDefined();
        const channelRestartAt = Date.parse((channelRestartLine ?? "").slice(0, 29));
        expect(Number.isFinite(channelRestartAt)).toBe(true);
        expect(channelRestartAt).toBeLessThan(cliTurnAt);
        const retiredAt = Date.parse(retirementLine.slice(0, 29));
        expect(Number.isFinite(retiredAt)).toBe(true);
        expect(retiredAt).toBeLessThan(cliTurnAt);
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

// #144809: replacing the backend mid-turn must preserve an admitted claude-cli reply.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { useChannelProductProof } from "./channel-product-proof.test-support.js";

const CHANNEL_ID = "qa-channel";
const PEER_ID = "reload-peer";
const CLI_MODEL = "claude-cli/claude-opus-5";
const TURN_MS = Number(process.env.OPENCLAW_E2E_PLUGIN_RELOAD_PROOF_TURN_MS ?? 340_000);

const proof = useChannelProductProof();

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const dir = process.env.FAKE_CLAUDE_DIR;
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("2.1.300 (Claude Code)\n"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "qa@example.com" }) + "\n");
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sessionIdx = argv.indexOf("--session-id");
const sessionId = sessionIdx >= 0 ? argv[sessionIdx + 1] : require("node:crypto").randomUUID();
const turnMs = Number(process.env.FAKE_CLAUDE_TURN_MS || "340000");
let resultEmitted = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { if (resultEmitted) process.exit(0); });
}
process.stdin.on("end", () => { if (resultEmitted) process.exit(0); });
setInterval(() => {}, 60_000);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "control_request" && message.request && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: [] } } });
    return;
  }
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type === "control_cancel_request") return;
  if (message.type === "user") {
    fs.writeFileSync(path.join(dir, "turn-started.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    send({ type: "system", subtype: "init", session_id: sessionId, model: "claude-opus-5", tools: [], cwd: process.cwd() });
    setTimeout(() => {
      const text = "fake-claude reply " + sessionId;
      send({ type: "assistant", message: { id: "msg_1", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] }, session_id: sessionId });
      send({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, duration_ms: turnMs, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } });
      resultEmitted = true;
      fs.writeFileSync(path.join(dir, "turn-finished.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    }, turnMs);
    return;
  }
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

const waitForFile = (file: string, timeout: number, interval = 500) =>
  waitFor(file, () => (fs.existsSync(file) ? true : undefined), timeout, interval);

it.runIf(process.env.OPENCLAW_E2E_PLUGIN_RELOAD_PROOF === "1")(
  "delivers a claude-cli reply across forced plugin reload (#144809)",
  { timeout: 1_200_000 },
  async () => {
    proof.cleanup(() => vi.unstubAllEnvs());
    const fakeRoot = process.env.OPENCLAW_E2E_PLUGIN_RELOAD_PROOF_DIR ?? os.tmpdir();
    fs.mkdirSync(fakeRoot, { recursive: true });
    const fakeDir = fs.mkdtempSync(path.join(fakeRoot, "fake-claude-"));
    fs.writeFileSync(path.join(fakeDir, "claude"), FAKE_CLAUDE, { mode: 0o755 });
    vi.stubEnv("PATH", `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("FAKE_CLAUDE_DIR", fakeDir);
    vi.stubEnv("FAKE_CLAUDE_TURN_MS", String(TURN_MS));

    const { gateway, state } = await proof.start({
      mutateConfig: (config) => {
        const plugins = (config.plugins ??= {});
        plugins.allow = [...new Set([...(plugins.allow ?? []), "anthropic"])];
        (plugins.entries ??= {}).anthropic = {
          enabled: true,
          subagent: { allowModelOverride: true },
        };
        const agents = (config.agents ??= {});
        const defaults = (agents.defaults ??= {});
        defaults.model = CLI_MODEL;
        (defaults.models ??= {})[CLI_MODEL] = {};
        defaults.modelPolicy = { allow: [...(defaults.modelPolicy?.allow ?? []), CLI_MODEL] };
        (agents.entries ??= {}).qa = { ...agents.entries.qa, model: CLI_MODEL };
        return config;
      },
    });
    const stdoutLog = path.join(gateway.tempRoot, "gateway.stdout.log");
    const stderrLog = path.join(gateway.tempRoot, "gateway.stderr.log");
    const readGatewayLogs = () => `${readLog(stdoutLog)}\n${readLog(stderrLog)}`;
    const turnFinishedPath = path.join(fakeDir, "turn-finished.json");
    const waitForReloadLog = (
      label: string,
      matches: (line: string) => boolean,
      timeout: number,
      interval = 500,
    ) =>
      waitFor(
        label,
        () => {
          if (fs.existsSync(turnFinishedPath)) {
            throw new Error(`CLI turn finished before ${label}`);
          }
          return readGatewayLogs().split("\n").map(stripAnsi).find(matches);
        },
        timeout,
        interval,
      );

    state.addInboundMessage({
      accountId: "default",
      conversation: { kind: "direct", id: PEER_ID },
      senderId: PEER_ID,
      text: `reload repro ${randomUUID()}`,
    });
    expect(await waitForFile(path.join(fakeDir, "turn-started.json"), 90_000)).toBe(true);
    await delay(5_000);

    const configBefore = (await gateway.call("config.get", {})) as {
      hash?: string;
    };
    const pluginsBefore = (await gateway.call("plugins.list", {})) as { generation: number };
    // Replace Anthropic while the channel change exercises active-work deferral.
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
      );

    await waitFor(
      "channel reload deferral log line",
      () => (/requires channel reload|deferring until/.test(readGatewayLogs()) ? true : undefined),
      60_000,
    );

    const appliedLine = await waitForReloadLog(
      "committed plugin reload before the CLI result",
      (line) =>
        line.includes("config hot reload applied (") && line.includes("plugins.entries.anthropic"),
      TURN_MS + 60_000,
      2_000,
    );
    const configAfter = (await gateway.call("config.get", {})) as {
      hash?: string;
      config?: OpenClawConfig;
    };
    // The channel restart may stay pending; committed content plus the log
    // prove replacement without requiring its appliedConfigHash publication.
    expect(configAfter.hash).not.toBe(configBefore.hash);
    expect(configAfter.config).toMatchObject({
      plugins: { entries: { anthropic: { subagent: { allowModelOverride: false } } } },
      channels: { [CHANNEL_ID]: { pollTimeoutMs: 700 } },
    });
    const pluginsAfter = (await gateway.call("plugins.list", {})) as {
      generation: number;
      plugins: Array<{ id: string; runtime: { state: string } }>;
    };
    expect(pluginsAfter.generation).toBeGreaterThan(pluginsBefore.generation);
    expect(pluginsAfter.plugins.find((plugin) => plugin.id === "anthropic")?.runtime.state).toBe(
      "active",
    );
    // Recovery-restart warnings are allowed, but settlement must precede the result.
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

    const retirementLine = await waitForReloadLog(
      "retired Anthropic instance before the CLI result",
      (line) =>
        line.includes("Plugin anthropic cleanup is deferred until its admitted turn finishes."),
      20_000,
    );

    const finished = await waitForFile(turnFinishedPath, TURN_MS + 120_000, 2_000).catch(
      (error: unknown) => String(error),
    );
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
      .map((message) => message.text);
    const interesting = readGatewayLogs().split("\n").map(stripAnsi);

    expect(finished).toBe(true);
    const cliTurnLine = interesting.find((line) => line.includes("] cli turn: "));
    const cliTurnAt = Date.parse((cliTurnLine ?? "").slice(0, 29));
    const channelRestartLine = interesting.find((line) =>
      line.includes("restarting qa-channel channel"),
    );
    expect(Number.isFinite(cliTurnAt)).toBe(true);
    for (const line of [appliedLine, channelRestartLine ?? "", retirementLine]) {
      const eventAt = Date.parse(line.slice(0, 29));
      expect(Number.isFinite(eventAt)).toBe(true);
      expect(eventAt).toBeLessThan(cliTurnAt);
    }
    expect(interesting.filter((line) => /stream is closed|failed before reply/.test(line))).toEqual(
      [],
    );
    expect(outbound).toEqual([expect.stringMatching(/^fake-claude reply /)]);
  },
);

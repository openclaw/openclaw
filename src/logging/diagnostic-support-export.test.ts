import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  uninstallDiagnosticStabilityFatalHook,
  writeDiagnosticStabilityBundleForFailureSync,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import { writeDiagnosticSupportExport } from "./diagnostic-support-export.js";
import * as logTailModule from "./log-tail.js";
import type { LogTailPayload } from "./log-tail.js";

async function readZipTextEntries(file: string): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) {
      entries[name] = await entry.async("string");
    }
  }
  return entries;
}

function emptyLogTail(file: string): LogTailPayload {
  return { file, cursor: 0, size: 0, truncated: false, reset: false, lines: [] };
}

function readJsonEntry(entries: Record<string, string>, name: string): unknown {
  return JSON.parse(entries[name] ?? "{}");
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function properties(value: unknown, expected: Record<string, unknown>) {
  for (const [key, item] of Object.entries(expected)) {
    expect(value).toHaveProperty(key, item);
  }
}

function logRecord(msg: string, fields: Record<string, unknown> = {}, time = "000") {
  return JSON.stringify({ time: `2026-04-22T12:00:00.${time}Z`, level: "info", msg, ...fields });
}

function expectContains(value: unknown, ...needles: string[]) {
  for (const needle of needles) {
    expect(value).toContain(needle);
  }
}
function expectOmits(value: unknown, ...needles: string[]) {
  for (const needle of needles) {
    expect(value).not.toContain(needle);
  }
}

describe("diagnostic support export", () => {
  let tempDir: string;

  async function archive(options: Parameters<typeof writeDiagnosticSupportExport>[0] = {}) {
    const result = await writeDiagnosticSupportExport(options);
    if (options.outputPath) {
      expect(result.path).toBe(options.outputPath);
    }
    expect(result.bytes).toBeGreaterThan(0);
    return readZipTextEntries(result.path);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-support-export-"));
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-22T12:00:01.000Z"));
    vi.spyOn(logTailModule, "readConfiguredLogTail").mockResolvedValue(
      emptyLogTail(path.join(tempDir, "logs", "openclaw.log")),
    );
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    uninstallDiagnosticStabilityFatalHook();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    uninstallDiagnosticStabilityFatalHook();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each(["current", "other-state alias", "marked relocated alias"])(
    "excludes %s capture files selected as config, logs, or a stability bundle",
    async (owner) => {
      const stateDir = path.join(tempDir, "state");
      let capture = `${stateDir}.update-captures`;
      if (owner !== "current") {
        const otherState = path.join(tempDir, "other-state");
        fs.mkdirSync(otherState);
        capture = `${otherState}.update-captures`;
      }
      fs.mkdirSync(capture);
      if (owner !== "current") {
        const alias = path.join(tempDir, "capture-alias");
        fs.symlinkSync(capture, alias, process.platform === "win32" ? "junction" : "dir");
        capture = alias;
      }
      if (owner === "marked relocated alias") {
        const original = `${path.join(tempDir, "other-state")}.update-captures`;
        const moved = path.join(tempDir, "relocated");
        fs.renameSync(original, moved);
        fs.unlinkSync(capture);
        fs.symlinkSync(moved, capture, process.platform === "win32" ? "junction" : "dir");
        fs.rmdirSync(path.join(tempDir, "other-state"));
        fs.writeFileSync(
          path.join(moved, ".openclaw-private-update-capture"),
          "openclaw-private-update-capture-v1\n",
        );
      }
      const privatePath = path.join(capture, "private.json");
      const marker = "synthetic-retained-record-not-for-support";
      fs.writeFileSync(privatePath, JSON.stringify({ agents: { entries: { [marker]: {} } } }));
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", privatePath);
      vi.mocked(logTailModule.readConfiguredLogTail).mockResolvedValue({
        file: privatePath,
        cursor: 1,
        size: 1,
        lines: [JSON.stringify({ msg: marker })],
        truncated: false,
        reset: false,
      });
      const files = await archive({ stabilityBundle: privatePath });
      expect(Object.values(files).join("\n")).not.toContain(marker);
      expect(Object.values(files).join("\n")).toContain("Private update captures are excluded");
      expect(fs.readFileSync(privatePath, "utf8")).toContain(marker);
    },
  );

  it("replaces identifier map keys throughout an archive without losing structure or cross-references", async () => {
    const identifiers = [
      "+15555550101",
      "+15555550102",
      "alice@example.invalid",
      "123456789012345678",
      "@alice:matrix.example.invalid",
      "!room:matrix.example.invalid",
      "ghp_abcdefghij",
      "ghp_klmnopqrst",
      "<identifier#1>",
    ];
    const numbers = Object.fromEntries(
      identifiers.map((identifier, index) => [identifier, { port: 19000 + index }]),
    );
    writeJson(path.join(tempDir, "openclaw.json"), {
      channels: { slack: { dms: { U1: { historyLimit: 5 }, U2: { historyLimit: 10 } } } },
      plugins: { entries: { "voice-call": { config: { numbers } } } },
    });
    const entries = await archive({
      readStatusSnapshot: async () => ({ routes: [{ destinations: numbers }] }),
      readHealthSnapshot: async () => ({ connected: true, destinations: numbers }),
    });

    const combined = Object.values(entries).join("\n");
    for (const identifier of identifiers.slice(0, -1)) {
      expectOmits(combined, identifier);
    }
    expectOmits(combined, '"U1"', '"U2"');
    const sanitizedConfig = JSON.parse(entries["config/sanitized.json"] ?? "{}");
    expect(sanitizedConfig).toHaveProperty("channels.slack.dms", {
      "<identifier#1>": { historyLimit: 5 },
      "<identifier#2>": { historyLimit: 10 },
    });
    const sanitizedNumbers = sanitizedConfig.plugins.entries["voice-call"].config.numbers;
    expect(Object.keys(sanitizedNumbers)).toHaveLength(identifiers.length);
    for (const key of Object.keys(sanitizedNumbers)) {
      expect(key).toMatch(/^<identifier#\d+>$/u);
    }
    // Distinct identifiers and a literal placeholder must retain separate entries.
    expect(Object.values(sanitizedNumbers)).toEqual(
      expect.arrayContaining(identifiers.map((_, index) => ({ port: 19000 + index }))),
    );
    expect(readJsonEntry(entries, "status/gateway-status.json")).toHaveProperty("data.routes", [
      { destinations: sanitizedNumbers },
    ]);
    expect(readJsonEntry(entries, "health/gateway-health.json")).toHaveProperty("data", {
      connected: true,
      destinations: sanitizedNumbers,
    });
  });

  it("writeDiagnosticSupportExport writes a shareable zip without raw chats, webhook bodies, or secrets", async () => {
    const fakeToken = "sk-test-support-export-secret-token-1234567890";
    const privateChat = "private user said diagnose my bank transfer";
    const privateAssistantReply = "the reimbursement is approved for 420 credits";
    const privateLogTapeAssistantReply = "the wire transfer clears on Thursday";
    const webhookBody = "raw webhook body with message contents";
    const requestAuthValue = "support-request-auth-value";
    const requestTlsPassphrase = "support-request-tls-passphrase";
    const proxyTlsPassphrase = "support-proxy-tls-passphrase";
    const credentialUrl =
      "wss://support-user:support-password@gateway.example/ws?token=short-token&ok=1";
    const configPath = path.join(tempDir, "openclaw.json");
    writeJson(configPath, {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 18789,
        tailscale: { mode: "serve" },
        auth: { mode: "token", token: fakeToken },
      },
      logging: { redactSensitive: "off" },
      models: {
        providers: {
          supportProxy: {
            request: {
              auth: { value: requestAuthValue },
              tls: { passphrase: requestTlsPassphrase },
              proxy: {
                tls: { passphrase: proxyTlsPassphrase },
              },
            },
          },
        },
      },
      channels: {
        $include: "./other-channels.json",
        defaults: { groupPolicy: "disabled" },
        modelByChannel: {},
        telegram: {
          accounts: {
            "15555551212": {
              botToken: fakeToken,
              allowFrom: [privateChat],
            },
          },
        },
      },
      agents: {
        entries: {
          $include: "./other-agents.json",
          main: { name: "personal-agent", instructions: privateChat },
        },
      },
      plugins: {
        enabled: false,
        allow: ["telegram", "slack"],
        entries: {
          $include: "./other-plugins.json",
          telegram: { enabled: true },
          slack: { enabled: false },
        },
      },
    });

    startDiagnosticStabilityRecorder();
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "15555551212",
      error: webhookBody,
    });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 2048,
      limitBytes: 1024,
      reason: "json_body_limit",
    });
    const bundle = writeDiagnosticStabilityBundleForFailureSync(
      "gateway.restart_startup_failed",
      undefined,
      { stateDir: tempDir, now: new Date("2026-04-22T12:00:00.000Z") },
    );
    expect(bundle.status).toBe("written");

    const logTail: LogTailPayload = {
      file: path.join(tempDir, "logs", "openclaw.log"),
      cursor: 200,
      size: 200,
      truncated: false,
      reset: false,
      lines: [
        logRecord(`gateway websocket listening at ${credentialUrl}`, {
          subsystem: "gateway",
          component: "gateway/server",
          channel: "telegram",
          sessionId: "gateway-session-15555551212",
          sessionKey: "matrix:!supportRoom:matrix.example.com:$supportEventSecret",
          hostname: "support-host",
          message: privateChat,
          body: webhookBody,
          authorization: `Bearer ${fakeToken}`,
          statusCode: 200,
        }),
        JSON.stringify({
          "0": JSON.stringify({ module: "matrix-auto-reply" }),
          "1": "matrix logged in as @support-user:matrix.example.com",
          _meta: {
            logLevelName: "info",
            name: JSON.stringify({
              module: "matrix-auto-reply",
              storePath: path.join(tempDir, "cron", "jobs.json"),
            }),
            hostname: "support-host",
          },
          time: "2026-04-22T12:00:00.100Z",
        }),
        logRecord("user said structured secret payload", { component: "gateway/server" }, "200"),
        logRecord(
          `stuck session: lastAssistant="${privateAssistantReply}"`,
          {
            level: "warn",
            subsystem: "diagnostic",
          },
          "250",
        ),
        JSON.stringify({
          "0": `stalled session: lastAssistant="${privateLogTapeAssistantReply}"`,
          _meta: { logLevelName: "warn", name: "diagnostic" },
          time: "2026-04-22T12:00:00.275Z",
        }),
        JSON.stringify({
          "0": JSON.stringify({ subsystem: "gateway/channels/matrix" }),
          "1": privateChat,
          _meta: {
            logLevelName: "warn",
            name: "gateway-runtime",
            hostname: "support-host",
          },
          time: "2026-04-22T12:00:00.300Z",
        }),
        JSON.stringify({ module: `gAAAA${"b".repeat(40_000)}` }),
        `plain fallback ${privateChat} ${fakeToken}`,
      ],
    };
    vi.mocked(logTailModule.readConfiguredLogTail).mockResolvedValue(logTail);

    const entries = await archive({
      outputPath: path.join(tempDir, "support.zip"),
      readStatusSnapshot: async () => ({
        service: {
          loaded: true,
          command: {
            programArguments: ["openclaw", "gateway", "run", "--token", fakeToken],
            environment: { HOME: tempDir, OPENCLAW_GATEWAY_TOKEN: fakeToken },
          },
        },
        gateway: { probeUrl: credentialUrl },
        warning: { message: privateChat },
      }),
      readHealthSnapshot: async () => ({
        ok: true,
        channels: {
          telegram: {
            accounts: { "15555551212": {} },
          },
        },
      }),
    });

    expect(readJsonEntry(entries, "stability/latest.json")).toHaveProperty(
      "reason",
      "gateway.restart_startup_failed",
    );

    const combined = Object.values(entries).join("\n");
    expectOmits(combined, fakeToken, privateChat, privateAssistantReply);
    expectOmits(combined, privateLogTapeAssistantReply, webhookBody, "15555551212");
    expectOmits(combined, "support-password", "short-token", tempDir);
    expectOmits(combined, "cron/jobs.json", os.hostname(), "structured secret payload");
    expectOmits(combined, requestAuthValue, requestTlsPassphrase, proxyTlsPassphrase);
    expectOmits(combined, "__OPENCLAW_REDACTED__", "gateway-session-15555551212");
    expectOmits(combined, "supportEventSecret");
    expectContains(combined, "payload.large", "gateway.http.json", "$OPENCLAW_STATE_DIR");
    expectContains(combined, "<redacted-hostname>");
    expectContains(combined, "Attach this zip to the bug report");

    const sanitizedLogs = entries["logs/openclaw-sanitized.jsonl"];
    expectContains(sanitizedLogs, '"subsystem":"gateway"', '"component":"gateway/server"');
    expectContains(sanitizedLogs, '"channel":"telegram"');
    expectOmits(sanitizedLogs, "sessionId", "sessionKey");
    expectContains(sanitizedLogs, "gateway websocket listening");
    expect(sanitizedLogs).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );
    expectContains(sanitizedLogs, '"module":"matrix-auto-reply"', '"module":"gAAAAb…bbbb"');
    expectContains(sanitizedLogs, '"subsystem":"gateway/channels/matrix"');
    expectContains(sanitizedLogs, '"logger":"gateway-runtime"', '"level":"warn"');
    expectContains(sanitizedLogs, "matrix logged in as <redacted-matrix-user>");
    expectContains(sanitizedLogs, '"omitted":"log-message"', '"omittedLogMessageBytes"');
    expectContains(sanitizedLogs, '"omittedLogMessageCount"');
    expectOmits(sanitizedLogs, "private user said", "@support-user:matrix.example.com");
    expectOmits(sanitizedLogs, "support-host");
    expectContains(sanitizedLogs, '"omitted":"unparsed"');

    const status = readJsonEntry(entries, "status/gateway-status.json");
    properties(status, {
      "data.service.command.programArguments": [
        "openclaw",
        "gateway",
        "run",
        "--token",
        "<redacted>",
      ],
      "data.service.command.environment.OPENCLAW_GATEWAY_TOKEN": "<redacted>",
    });
    expect(JSON.stringify(status)).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );

    const health = readJsonEntry(entries, "health/gateway-health.json");
    expect(health).toHaveProperty("data.channels.telegram.accounts", { count: 1 });

    const configShape = readJsonEntry(entries, "config/shape.json");
    properties(configShape, {
      "gateway.mode": "local",
      "gateway.authMode": "token",
      "gateway.tailscale": "serve",
      channels: { count: 1, ids: ["telegram"] },
      plugins: { count: 2, ids: ["slack", "telegram"] },
      agents: { count: 1 },
    });
    expect(JSON.parse(entries["diagnostics.json"] ?? "{}").config).toEqual(configShape);

    const sanitizedConfig = readJsonEntry(entries, "config/sanitized.json");
    properties(sanitizedConfig, {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 18789,
        tailscale: { mode: "serve" },
        auth: { mode: "token", token: "<redacted>" },
      },
      "logging.redactSensitive": "off",
      "models.providers.supportProxy.request.auth.value": "<redacted>",
      "models.providers.supportProxy.request.tls.passphrase": "<redacted>",
      "models.providers.supportProxy.request.proxy.tls.passphrase": "<redacted>",
      "channels.telegram.accounts": {
        "<identifier#1>": {
          botToken: "<redacted>",
          allowFrom: { redacted: true, count: 1 },
        },
      },
      "agents.entries.main.name": "personal-agent",
      "agents.entries.main.instructions": "<redacted>",
    });
  });

  it.each([
    { agents: { entries: { main: {} } }, expected: { count: 1 } },
    { agents: { defaults: {} }, expected: undefined },
    { agents: { entries: [] }, expected: undefined },
    { agents: { entries: {} }, expected: { count: 0 } },
  ])(
    "distinguishes absent, empty, and populated canonical agent rosters: $agents",
    async ({ agents, expected }) => {
      const configPath = path.join(tempDir, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify({ agents }));
      const entries = await archive();
      expect(JSON.parse(entries["config/shape.json"] ?? "{}").agents).toEqual(expected);
      expect(JSON.parse(entries["diagnostics.json"] ?? "{}").config.agents).toEqual(expected);
    },
  );

  it("includes an explicitly selected stability bundle", async () => {
    const bundle = writeDiagnosticStabilityBundleForFailureSync(
      "gateway.restart_startup_failed",
      undefined,
      { stateDir: tempDir },
    );
    if (bundle.status !== "written") {
      throw new Error(`bundle fixture failed: ${bundle.status}`);
    }
    const entries = await archive({ stabilityBundle: bundle.path });
    expect(readJsonEntry(entries, "stability/latest.json")).toHaveProperty(
      "reason",
      "gateway.restart_startup_failed",
    );
  });

  it("includes mDNS config state and recent Bonjour log summary", async () => {
    const configPath = path.join(tempDir, "openclaw.json");
    writeJson(configPath, { discovery: { mdns: { mode: "minimal" } } });
    vi.mocked(logTailModule.readConfiguredLogTail).mockResolvedValue({
      file: path.join(tempDir, "logs", "openclaw.log"),
      cursor: 0,
      size: 0,
      truncated: false,
      reset: false,
      lines: [
        JSON.stringify({
          time: "2026-04-22T12:00:00.000Z",
          level: "warn",
          subsystem: "gateway/discovery/bonjour",
          msg: "bonjour: suppressing ciao interface assertion: AssertionError",
        }),
        JSON.stringify({
          time: "2026-04-22T12:00:00.500Z",
          level: "warn",
          msg: "bonjour: disabling advertiser after 3 failed restarts",
        }),
      ],
    });
    vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", "1");
    const entries = await archive();
    const configShape = readJsonEntry(entries, "config/shape.json");
    expect(configShape).toHaveProperty("discovery", {
      mdnsMode: "minimal",
      bonjourEnvOverride: "force-disabled",
    });

    const diagnostics = readJsonEntry(entries, "diagnostics.json");
    expect(diagnostics).toHaveProperty("bonjour", {
      count: 2,
      warnings: 2,
      last: {
        time: "2026-04-22T12:00:00.500Z",
        level: "warn",
        kind: "disabled",
      },
      flags: {
        disabled: true,
        restarted: false,
        ciaoSuppressed: true,
      },
    });
  });

  it("keeps writing when status and health snapshots fail", async () => {
    const fakeToken = "sk-test-support-export-secret-token-1234567890";
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "missing-config.json"));

    const entries = await archive({
      readStatusSnapshot: async () => {
        throw new Error(`status failed with token ${fakeToken}`);
      },
      readHealthSnapshot: async () => {
        throw new Error("health failed with PASSWORD=hunter2");
      },
    });

    expect(entries["summary.md"]).toContain("config file not found");
    expect(Object.keys(entries).toSorted()).toContain("status/gateway-status.json");
    expect(Object.keys(entries).toSorted()).toContain("health/gateway-health.json");

    const combined = Object.values(entries).join("\n");
    expectOmits(combined, fakeToken, "hunter2");
    expectContains(combined, '"status": "failed"', "status snapshot failed");
    expectContains(combined, "health snapshot failed");
  });

  it("keeps writing when log tail collection fails", async () => {
    const fakeToken = "sk-test-log-tail-secret-token-1234567890";
    vi.mocked(logTailModule.readConfiguredLogTail).mockRejectedValue(
      new Error(`log tail failed at ${tempDir}/openclaw.log with token ${fakeToken}`),
    );
    const entries = await archive();
    expect(Object.keys(entries).toSorted()).toContain("logs/openclaw-sanitized.jsonl");

    const combined = Object.values(entries).join("\n");
    expectOmits(combined, fakeToken, tempDir);
    expectContains(combined, "log-tail-read-failed", "sanitized log tail unavailable");
  });

  it("keeps writing when config stat fails", async () => {
    const fakeToken = "sk-test-config-stat-secret-token-1234567890";
    const configPath = path.join(tempDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}\n", "utf8");

    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      if (target === configPath) {
        throw new Error(`config stat failed with token ${fakeToken}`);
      }
      return originalStatSync(target, options as never);
    });

    let entries: Record<string, string>;
    try {
      entries = await archive();
    } finally {
      statSpy.mockRestore();
    }

    const combined = Object.values(entries).join("\n");
    expect(Object.keys(entries).toSorted()).toContain("config/shape.json");
    expectOmits(combined, fakeToken);
    expectContains(combined, '"parseOk": false', "config stat failed with token");
    expect(entries["summary.md"]).toContain("config stat failed with token");
    expect(entries["summary.md"]).not.toContain("config file not found");
    expectContains(combined, "Attach this zip to the bug report");
  });

  it("finishes the support export when the config exceeds its read limit", async () => {
    const configPath = path.join(tempDir, "openclaw.json");
    fs.writeFileSync(configPath, Buffer.alloc(8 * 1024 * 1024 + 1, "{"));
    vi.setSystemTime(new Date("2026-07-18T12:00:01.000Z"));
    const entries = await archive();
    const configShape = readJsonEntry(entries, "config/shape.json");
    expect(configShape).toHaveProperty("parseOk", false);
    expect(configShape).toHaveProperty(
      "error",
      expect.stringContaining("File exceeds 8388608 bytes"),
    );
    expect(entries["config/sanitized.json"]).toBe("null\n");

    const combined = Object.values(entries).join("\n");
    expectContains(combined, "Attach this zip to the bug report");
  });
});

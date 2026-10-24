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

describe("diagnostic support export", () => {
  let tempDir: string;

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
      const outputPath = path.join(tempDir, "support.zip");
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
      await writeDiagnosticSupportExport({
        outputPath,
        stabilityBundle: privatePath,
      });
      const files = await readZipTextEntries(outputPath);
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
    const outputPath = path.join(tempDir, "identifier-keys.zip");
    await writeDiagnosticSupportExport({
      outputPath,
      readStatusSnapshot: async () => ({ routes: [{ destinations: numbers }] }),
      readHealthSnapshot: async () => ({ connected: true, destinations: numbers }),
    });

    const entries = await readZipTextEntries(outputPath);
    const combined = Object.values(entries).join("\n");
    for (const identifier of identifiers.slice(0, -1)) {
      expect(combined).not.toContain(identifier);
    }
    expect(combined).not.toContain('"U1"');
    expect(combined).not.toContain('"U2"');
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
    const fakeAwsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const fakeJwt = [
      "eyJhbGciOiJIUzI1NiIs",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4i",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
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
        auth: {
          mode: "token",
          token: fakeToken,
        },
      },
      logging: {
        redactSensitive: "off",
      },
      models: {
        providers: {
          supportProxy: {
            baseUrl: "https://models.example.test/v1",
            request: {
              auth: {
                mode: "header",
                headerName: "X-Support-Auth",
                value: requestAuthValue,
              },
              tls: {
                passphrase: requestTlsPassphrase,
              },
              proxy: {
                mode: "explicit-proxy",
                url: "http://127.0.0.1:8080",
                tls: {
                  passphrase: proxyTlsPassphrase,
                },
              },
            },
            models: [{ id: "support-model" }],
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
              ownerId: 8675309001,
            },
          },
        },
      },
      agents: {
        ownership: "explicit",
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
        JSON.stringify({
          time: "2026-04-22T12:00:00.000Z",
          level: "info",
          subsystem: "gateway",
          component: "gateway/server",
          channel: "telegram",
          sessionId: "gateway-session-15555551212",
          sessionKey: "matrix:!supportRoom:matrix.example.com:$supportEventSecret",
          msg: `gateway websocket listening at ${credentialUrl} Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== ${fakeAwsKey} ${fakeJwt} Cookie: sid=secret`,
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
        JSON.stringify({
          time: "2026-04-22T12:00:00.200Z",
          level: "info",
          component: "gateway/server",
          msg: "user said structured secret payload",
        }),
        JSON.stringify({
          time: "2026-04-22T12:00:00.250Z",
          level: "warn",
          subsystem: "diagnostic",
          msg: `stuck session: lastAssistant="${privateAssistantReply}"`,
        }),
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
    let requestedLogTail: { limit?: number; maxBytes?: number } | undefined;
    vi.mocked(logTailModule.readConfiguredLogTail).mockImplementation(async (params) => {
      requestedLogTail = params;
      return logTail;
    });

    const outputPath = path.join(tempDir, "support.zip");
    const result = await writeDiagnosticSupportExport({
      outputPath,
      readStatusSnapshot: async () => ({
        service: {
          loaded: true,
          command: {
            programArguments: ["openclaw", "gateway", "run", "--token", fakeToken],
            environment: {
              HOME: tempDir,
              OPENCLAW_GATEWAY_TOKEN: fakeToken,
            },
          },
        },
        gateway: {
          probeUrl: credentialUrl,
        },
        warning: {
          chatId: 4444555566,
          message: privateChat,
        },
      }),
      readHealthSnapshot: async () => ({
        ok: true,
        channels: {
          telegram: {
            accounts: {
              "15555551212": {
                accountId: 15555551212,
                configured: true,
                phone: 4444555566,
                probe: {
                  ok: false,
                  error: webhookBody,
                },
              },
            },
          },
        },
      }),
    });

    expect(result.path).toBe(outputPath);
    expect(result.bytes).toBeGreaterThan(0);
    expect(requestedLogTail?.limit).toBe(5000);
    expect(requestedLogTail?.maxBytes).toBe(1_000_000);

    const entries = await readZipTextEntries(outputPath);
    expect(Object.keys(entries).toSorted()).toEqual([
      "config/sanitized.json",
      "config/shape.json",
      "diagnostics.json",
      "health/gateway-health.json",
      "logs/openclaw-sanitized.jsonl",
      "manifest.json",
      "stability/latest.json",
      "status/gateway-status.json",
      "summary.md",
    ]);

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain(privateChat);
    expect(combined).not.toContain(privateAssistantReply);
    expect(combined).not.toContain(privateLogTapeAssistantReply);
    expect(combined).not.toContain(webhookBody);
    expect(combined).not.toContain("15555551212");
    expect(combined).not.toContain("4444555566");
    expect(combined).not.toContain("8675309001");
    expect(combined).not.toContain("support-password");
    expect(combined).not.toContain("short-token");
    expect(combined).not.toContain(tempDir);
    expect(combined).not.toContain("cron/jobs.json");
    expect(combined).not.toContain(os.hostname());
    expect(combined).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    expect(combined).not.toContain("sid=secret");
    expect(combined).not.toContain("structured secret payload");
    expect(combined).not.toContain(requestAuthValue);
    expect(combined).not.toContain(requestTlsPassphrase);
    expect(combined).not.toContain(proxyTlsPassphrase);
    expect(combined).not.toContain("__OPENCLAW_REDACTED__");
    expect(combined).not.toContain("gateway-session-15555551212");
    expect(combined).not.toContain("supportEventSecret");
    expect(combined).not.toContain(fakeAwsKey);
    expect(combined).not.toContain(fakeJwt);
    expect(combined).toContain("payload.large");
    expect(combined).toContain("gateway.http.json");
    expect(combined).toContain("$OPENCLAW_STATE_DIR");
    expect(combined).toContain("<redacted-hostname>");
    expect(combined).toContain("gateway-status.json");
    expect(combined).toContain("gateway-health.json");
    expect(combined).toContain("Attach this zip to the bug report");

    const sanitizedLogs = entries["logs/openclaw-sanitized.jsonl"];
    expect(sanitizedLogs).toContain('"subsystem":"gateway"');
    expect(sanitizedLogs).toContain('"component":"gateway/server"');
    expect(sanitizedLogs).toContain('"channel":"telegram"');
    expect(sanitizedLogs).not.toContain("sessionId");
    expect(sanitizedLogs).not.toContain("sessionKey");
    expect(sanitizedLogs).toContain("gateway websocket listening");
    expect(sanitizedLogs).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );
    expect(sanitizedLogs).toContain("Basic <redacted>");
    expect(sanitizedLogs).toContain("Cookie: <redacted>");
    expect(sanitizedLogs).toContain("<redacted-aws-key>");
    expect(sanitizedLogs).toContain("<redacted-jwt>");
    expect(sanitizedLogs).toContain('"module":"matrix-auto-reply"');
    expect(sanitizedLogs).toContain('"module":"gAAAAb…bbbb"');
    expect(sanitizedLogs).toContain('"subsystem":"gateway/channels/matrix"');
    expect(sanitizedLogs).toContain('"logger":"gateway-runtime"');
    expect(sanitizedLogs).toContain('"level":"warn"');
    expect(sanitizedLogs).toContain("matrix logged in as <redacted-matrix-user>");
    expect(sanitizedLogs).toContain('"omitted":"log-message"');
    expect(sanitizedLogs).toContain('"omittedLogMessageBytes"');
    expect(sanitizedLogs).toContain('"omittedLogMessageCount"');
    expect(sanitizedLogs).not.toContain("private user said");
    expect(sanitizedLogs).not.toContain("@support-user:matrix.example.com");
    expect(sanitizedLogs).not.toContain("support-host");
    expect(sanitizedLogs).toContain('"omitted":"unparsed"');

    const status = readJsonEntry(entries, "status/gateway-status.json");
    expect(status).toHaveProperty("data.service.command.programArguments", [
      "openclaw",
      "gateway",
      "run",
      "--token",
      "<redacted>",
    ]);
    expect(status).toHaveProperty(
      "data.service.command.environment.OPENCLAW_GATEWAY_TOKEN",
      "<redacted>",
    );
    expect(JSON.stringify(status)).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );

    const health = readJsonEntry(entries, "health/gateway-health.json");
    expect(health).toHaveProperty("data.channels.telegram.accounts", { count: 1 });

    const configShape = readJsonEntry(entries, "config/shape.json");
    expect(configShape).toHaveProperty("gateway.mode", "local");
    expect(configShape).toHaveProperty("gateway.authMode", "token");
    expect(configShape).toHaveProperty("gateway.tailscale", "serve");
    expect(configShape).toHaveProperty("channels", { count: 1, ids: ["telegram"] });
    expect(configShape).toHaveProperty("plugins", { count: 2, ids: ["slack", "telegram"] });
    expect(configShape).toHaveProperty("agents", { count: 1 });
    expect(JSON.parse(entries["diagnostics.json"] ?? "{}").config).toEqual(configShape);

    const sanitizedConfig = readJsonEntry(entries, "config/sanitized.json");
    expect(sanitizedConfig).toHaveProperty("gateway", {
      mode: "local",
      bind: "loopback",
      port: 18789,
      tailscale: { mode: "serve" },
      auth: {
        mode: "token",
        token: "<redacted>",
      },
    });
    expect(sanitizedConfig).toHaveProperty("logging.redactSensitive", "off");
    expect(sanitizedConfig).toHaveProperty(
      "models.providers.supportProxy.request.auth.value",
      "<redacted>",
    );
    expect(sanitizedConfig).toHaveProperty(
      "models.providers.supportProxy.request.tls.passphrase",
      "<redacted>",
    );
    expect(sanitizedConfig).toHaveProperty(
      "models.providers.supportProxy.request.proxy.tls.passphrase",
      "<redacted>",
    );
    expect(sanitizedConfig).toHaveProperty("channels.telegram.accounts", {
      "<identifier#1>": {
        botToken: "<redacted>",
        allowFrom: { redacted: true, count: 1 },
        ownerId: "<redacted>",
      },
    });
    expect(sanitizedConfig).toHaveProperty("agents.entries.main.name", "personal-agent");
    expect(sanitizedConfig).toHaveProperty("agents.entries.main.instructions", "<redacted>");
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
      const result = await writeDiagnosticSupportExport({});
      const entries = await readZipTextEntries(result.path);
      expect(JSON.parse(entries["config/shape.json"] ?? "{}").agents).toEqual(expected);
      expect(JSON.parse(entries["diagnostics.json"] ?? "{}").config.agents).toEqual(expected);
    },
  );

  it("sanitizes imported stability bundles before adding them to support exports", async () => {
    const bundlePath = path.join(tempDir, "imported-stability.json");
    const outputPath = path.join(tempDir, "support-imported-stability.zip");
    const importedBundle = {
      version: 1,
      generatedAt: "2026-04-22T12:00:00.000Z",
      reason: "private reason token=secret",
      process: { pid: 123, platform: "darwin", arch: "arm64", node: "24.14.1", uptimeMs: 1000 },
      host: { hostname: "private-hostname" },
      error: { name: "private error name", code: "ERR_TEST" },
      snapshot: {
        generatedAt: "2026-04-22T12:00:00.000Z",
        capacity: 1000,
        count: 1,
        dropped: 0,
        events: [
          {
            seq: 1,
            ts: 1,
            type: "webhook.error",
            channel: "telegram",
            reason: "private event reason",
            error: "event-error-secret",
          },
        ],
        summary: {
          byType: {
            "webhook.error": 1,
            "private summary type": 1,
          },
          privateSummary: "summary-secret",
        },
      },
    };
    writeJson(bundlePath, importedBundle);

    await writeDiagnosticSupportExport({
      outputPath,
      stabilityBundle: bundlePath,
    });

    const entries = await readZipTextEntries(outputPath);
    const stability = readJsonEntry(entries, "stability/latest.json");
    expect(stability).toHaveProperty("reason", "unknown");
    expect(stability).toHaveProperty("host", { hostname: "<redacted-hostname>" });
    expect(stability).toHaveProperty("error", { code: "ERR_TEST" });
    expect(stability).toHaveProperty("snapshot.events.0", {
      seq: 1,
      ts: 1,
      type: "webhook.error",
      channel: "telegram",
    });
    expect(stability).toHaveProperty("snapshot.summary.byType", { "webhook.error": 1 });

    const combined = Object.values(entries).join("\n");
    for (const secret of [
      "private reason",
      "private-hostname",
      "private error name",
      "private event reason",
      "event-error-secret",
      "private summary type",
      "summary-secret",
    ]) {
      expect(combined).not.toContain(secret);
    }
  });

  it.each([
    [undefined, "unset"],
    ["  ", "unset"],
    ["1", "force-disabled"],
    ["0", "force-enabled"],
    ["not-a-boolean", "unrecognized"],
  ] as const)(
    "includes mDNS config state and recent Bonjour log summary (%s)",
    async (value, expected) => {
      const configPath = path.join(tempDir, "openclaw.json");
      const outputPath = path.join(tempDir, "support-bonjour.zip");
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
      vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", value);
      await writeDiagnosticSupportExport({ outputPath });

      const entries = await readZipTextEntries(outputPath);
      const configShape = readJsonEntry(entries, "config/shape.json");
      expect(configShape).toHaveProperty("discovery", {
        mdnsMode: "minimal",
        bonjourEnvOverride: expected,
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
    },
  );

  it("keeps writing when status and health snapshots fail", async () => {
    const fakeToken = "sk-test-support-export-secret-token-1234567890";
    const outputPath = path.join(tempDir, "support-failed-snapshots.zip");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "missing-config.json"));

    await writeDiagnosticSupportExport({
      outputPath,
      readStatusSnapshot: async () => {
        throw new Error(`status failed with token ${fakeToken}`);
      },
      readHealthSnapshot: async () => {
        throw new Error("health failed with PASSWORD=hunter2");
      },
    });

    const entries = await readZipTextEntries(outputPath);
    expect(entries["summary.md"]).toContain("config file not found");
    expect(Object.keys(entries).toSorted()).toContain("status/gateway-status.json");
    expect(Object.keys(entries).toSorted()).toContain("health/gateway-health.json");

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain("hunter2");
    expect(combined).toContain('"status": "failed"');
    expect(combined).toContain("status snapshot failed");
    expect(combined).toContain("health snapshot failed");
  });

  it("keeps writing when log tail collection fails", async () => {
    const fakeToken = "sk-test-log-tail-secret-token-1234567890";
    const outputPath = path.join(tempDir, "support-failed-log-tail.zip");
    vi.mocked(logTailModule.readConfiguredLogTail).mockRejectedValue(
      new Error(`log tail failed at ${tempDir}/openclaw.log with token ${fakeToken}`),
    );
    await writeDiagnosticSupportExport({ outputPath });

    const entries = await readZipTextEntries(outputPath);
    expect(Object.keys(entries).toSorted()).toContain("logs/openclaw-sanitized.jsonl");

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain(tempDir);
    expect(combined).toContain("log-tail-read-failed");
    expect(combined).toContain("sanitized log tail unavailable");
  });

  it("keeps writing when config stat fails", async () => {
    const fakeToken = "sk-test-config-stat-secret-token-1234567890";
    const configPath = path.join(tempDir, "openclaw.json");
    const outputPath = path.join(tempDir, "support-failed-config-stat.zip");
    fs.writeFileSync(configPath, "{}\n", "utf8");

    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      if (target === configPath) {
        throw new Error(`config stat failed with token ${fakeToken}`);
      }
      return originalStatSync(target, options as never);
    });

    try {
      await writeDiagnosticSupportExport({ outputPath });
    } finally {
      statSpy.mockRestore();
    }

    const entries = await readZipTextEntries(outputPath);
    const combined = Object.values(entries).join("\n");
    expect(Object.keys(entries).toSorted()).toContain("config/shape.json");
    expect(combined).not.toContain(fakeToken);
    expect(combined).toContain('"parseOk": false');
    expect(combined).toContain("config stat failed with token");
    expect(entries["summary.md"]).toContain("config stat failed with token");
    expect(entries["summary.md"]).not.toContain("config file not found");
    expect(combined).toContain("Attach this zip to the bug report");
  });

  it("finishes the support export when the config exceeds its read limit", async () => {
    const configPath = path.join(tempDir, "openclaw.json");
    const outputPath = path.join(tempDir, "support-oversized-config.zip");
    fs.writeFileSync(configPath, Buffer.alloc(8 * 1024 * 1024 + 1, "{"));
    vi.setSystemTime(new Date("2026-07-18T12:00:01.000Z"));
    await writeDiagnosticSupportExport({ outputPath });

    const entries = await readZipTextEntries(outputPath);
    const configShape = readJsonEntry(entries, "config/shape.json");
    expect(configShape).toHaveProperty("parseOk", false);
    expect(configShape).toHaveProperty(
      "error",
      expect.stringContaining("File exceeds 8388608 bytes"),
    );
    expect(entries["config/sanitized.json"]).toBe("null\n");
    expect(Object.keys(entries).toSorted()).toEqual([
      "config/sanitized.json",
      "config/shape.json",
      "diagnostics.json",
      "logs/openclaw-sanitized.jsonl",
      "manifest.json",
      "summary.md",
    ]);

    const combined = Object.values(entries).join("\n");
    expect(combined).toContain("Attach this zip to the bug report");
  });
});

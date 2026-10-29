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

  async function exportEntries(options: Parameters<typeof writeDiagnosticSupportExport>[0] = {}) {
    const result = await writeDiagnosticSupportExport(options);
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

  it("includes separate redacted capabilities for the exporter and serving Gateway", async () => {
    vi.stubGlobal("__openclawStandaloneBuildInfo", {
      mode: "aot",
      openclaw: { version: "2026.10.3", commit: "a".repeat(40) },
      bun: { version: "1.4.4" },
      plugins: { embedded: ["synthetic-private@example.invalid"], omitted: [] },
    });
    try {
      const entries = await exportEntries({
        readGatewayCapabilities: async () => ({
          process: { kind: "bun", flavor: "jit" },
          source: "synthetic-private@example.invalid",
          token: "synthetic-secret-value",
        }),
      });
      expect(readJsonEntry(entries, "runtime/capabilities.json")).toMatchObject({
        data: { process: { flavor: "aot" }, build: { openclaw: { commit: "a".repeat(40) } } },
      });
      expect(readJsonEntry(entries, "runtime/gateway-capabilities.json")).toHaveProperty(
        "data.process.flavor",
        "jit",
      );
      expect(Object.values(entries).join("\n")).not.toMatch(
        /synthetic-private@example.invalid|synthetic-secret-value/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
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
      const files = await exportEntries({ stabilityBundle: privatePath });
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
    const entries = await exportEntries({
      readStatusSnapshot: async () => ({ routes: [{ destinations: numbers }] }),
      readHealthSnapshot: async () => ({ connected: true, destinations: numbers }),
    });

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
        entries: {
          $include: "./other-agents.json",
          main: { name: "personal-agent", instructions: privateChat },
        },
      },
      plugins: {
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
          msg: `gateway websocket listening at ${credentialUrl}`,
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
          },
        }),
        JSON.stringify({
          level: "info",
          component: "gateway/server",
          msg: "user said structured secret payload",
        }),
        JSON.stringify({
          level: "warn",
          subsystem: "diagnostic",
          msg: `stuck session: lastAssistant="${privateAssistantReply}"`,
        }),
        JSON.stringify({
          "0": `stalled session: lastAssistant="${privateLogTapeAssistantReply}"`,
          _meta: { logLevelName: "warn", name: "diagnostic" },
        }),
        JSON.stringify({
          "0": JSON.stringify({ subsystem: "gateway/channels/matrix" }),
          "1": privateChat,
          _meta: {
            logLevelName: "warn",
            name: "gateway-runtime",
          },
        }),
        JSON.stringify({ module: `gAAAA${"b".repeat(40_000)}` }),
        `plain fallback ${privateChat} ${fakeToken}`,
      ],
    };
    vi.mocked(logTailModule.readConfiguredLogTail).mockResolvedValue(logTail);

    const outputPath = path.join(tempDir, "support.zip");
    const result = await writeDiagnosticSupportExport({
      outputPath,
      readStatusSnapshot: async () => ({
        service: {
          command: {
            programArguments: ["--token", fakeToken],
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

    const entries = await readZipTextEntries(outputPath);

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
    expect(combined).not.toContain("structured secret payload");
    expect(combined).not.toContain(requestAuthValue);
    expect(combined).not.toContain(requestTlsPassphrase);
    expect(combined).not.toContain(proxyTlsPassphrase);
    expect(combined).not.toContain("__OPENCLAW_REDACTED__");
    expect(combined).not.toContain("supportEventSecret");
    expect(combined).toContain("payload.large");
    expect(combined).toContain("gateway.http.json");
    expect(combined).toContain("$OPENCLAW_STATE_DIR");
    expect(combined).toContain("<redacted-hostname>");
    expect(combined).toContain("Attach this zip to the bug report");

    const sanitizedLogs = entries["logs/openclaw-sanitized.jsonl"];
    expect(sanitizedLogs).toContain('"component":"gateway/server"');
    expect(sanitizedLogs).not.toContain("sessionId");
    expect(sanitizedLogs).not.toContain("sessionKey");
    expect(sanitizedLogs).toContain("gateway websocket listening");
    expect(sanitizedLogs).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );
    expect(sanitizedLogs).toContain('"module":"matrix-auto-reply"');
    expect(sanitizedLogs).toContain('"module":"gAAAAb…bbbb"');
    expect(sanitizedLogs).toContain('"subsystem":"gateway/channels/matrix"');
    expect(sanitizedLogs).toContain('"logger":"gateway-runtime"');
    expect(sanitizedLogs).toContain("matrix logged in as <redacted-matrix-user>");
    expect(sanitizedLogs).toContain('"omitted":"log-message"');
    expect(sanitizedLogs).toContain('"omittedLogMessageBytes"');
    expect(sanitizedLogs).toContain('"omittedLogMessageCount"');
    expect(sanitizedLogs).not.toContain("@support-user:matrix.example.com");
    expect(sanitizedLogs).not.toContain("support-host");
    expect(sanitizedLogs).toContain('"omitted":"unparsed"');

    const status = readJsonEntry(entries, "status/gateway-status.json");
    expect(status).toHaveProperty("data.service.command.programArguments", [
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
    expect(sanitizedConfig).toHaveProperty("gateway.auth.token", "<redacted>");
    expect(sanitizedConfig).toHaveProperty("logging.redactSensitive", "off");
    for (const field of ["auth.value", "tls.passphrase", "proxy.tls.passphrase"]) {
      expect(sanitizedConfig).toHaveProperty(
        `models.providers.supportProxy.request.${field}`,
        "<redacted>",
      );
    }
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
    { agents: { defaults: {} }, expected: undefined },
    { agents: { entries: [] }, expected: undefined },
    { agents: { entries: {} }, expected: { count: 0 } },
  ])(
    "distinguishes absent, invalid, and empty canonical agent rosters: $agents",
    async ({ agents, expected }) => {
      const configPath = path.join(tempDir, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify({ agents }));
      const entries = await exportEntries();
      expect(JSON.parse(entries["config/shape.json"] ?? "{}").agents).toEqual(expected);
      expect(JSON.parse(entries["diagnostics.json"] ?? "{}").config.agents).toEqual(expected);
    },
  );

  it("sanitizes imported stability bundles before adding them to support exports", async () => {
    const bundlePath = path.join(tempDir, "imported-stability.json");
    const run = { type: "run.completed", outcome: "aborted", durationMs: 12 };
    const interruption = {
      abortCause: "timeout",
      timeoutPhase: "prompt",
      timeoutSource: "run_budget",
    };
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
        count: 4,
        dropped: 0,
        events: [
          { seq: 1, ts: 1, ...run, ...interruption },
          {
            seq: 2,
            ts: 2,
            ...run,
            abortCause: "private-cause",
            timeoutPhase: "private-phase",
            timeoutSource: "private-source",
          },
          { seq: 3, ts: 3, ...run },
          {
            seq: 4,
            ts: 4,
            type: "webhook.error",
            channel: "telegram",
            reason: "private event reason",
            error: "event-error-secret",
          },
        ],
        summary: {
          byType: {
            "run.completed": 3,
            "webhook.error": 1,
            "private summary type": 1,
          },
          privateSummary: "summary-secret",
        },
      },
    };
    writeJson(bundlePath, importedBundle);

    const entries = await exportEntries({ stabilityBundle: bundlePath });
    const stability = readJsonEntry(entries, "stability/latest.json");
    expect(stability).toHaveProperty("reason", "unknown");
    expect(stability).toHaveProperty("host", { hostname: "<redacted-hostname>" });
    expect(stability).toHaveProperty("error", { code: "ERR_TEST" });
    for (const [index, expected] of [interruption, {}, {}].entries()) {
      expect(stability).toHaveProperty(`snapshot.events.${index}`, {
        seq: index + 1,
        ts: index + 1,
        ...run,
        ...expected,
      });
    }
    expect(stability).toHaveProperty("snapshot.events.3", {
      seq: 4,
      ts: 4,
      type: "webhook.error",
      channel: "telegram",
    });
    expect(stability).toHaveProperty("snapshot.summary.byType", {
      "run.completed": 3,
      "webhook.error": 1,
    });

    const combined = Object.values(entries).join("\n");
    for (const secret of [
      "private-cause",
      "private-phase",
      "private-source",
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
    ["1", "force-disabled"],
    ["0", "force-enabled"],
    ["not-a-boolean", "unrecognized"],
  ] as const)(
    "includes mDNS config state and recent Bonjour log summary (%s)",
    async (value, expected) => {
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
      vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", value);
      const entries = await exportEntries();
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
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "missing-config.json"));

    const entries = await exportEntries({
      readStatusSnapshot: async () => {
        throw new Error(`status failed with token ${fakeToken}`);
      },
      readHealthSnapshot: async () => {
        throw new Error("health failed with PASSWORD=hunter2");
      },
      readGatewayCapabilities: async () => {
        throw new Error("synthetic-private@example.invalid is offline");
      },
    });

    expect(entries["summary.md"]).toContain("config file not found");
    expect(readJsonEntry(entries, "status/gateway-status.json")).toHaveProperty("status", "failed");
    expect(readJsonEntry(entries, "health/gateway-health.json")).toHaveProperty("status", "failed");
    expect(readJsonEntry(entries, "runtime/gateway-capabilities.json")).toHaveProperty(
      "status",
      "failed",
    );
    expect(readJsonEntry(entries, "runtime/capabilities.json")).toHaveProperty("status", "ok");

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain("hunter2");
    expect(combined).not.toContain("synthetic-private@example.invalid");
    expect(combined).toContain("status snapshot failed");
    expect(combined).toContain("health snapshot failed");
  });

  it("keeps writing when log tail collection fails", async () => {
    const fakeToken = "sk-test-log-tail-secret-token-1234567890";
    vi.mocked(logTailModule.readConfiguredLogTail).mockRejectedValue(
      new Error(`log tail failed at ${tempDir}/openclaw.log with token ${fakeToken}`),
    );
    const entries = await exportEntries();
    expect(entries["logs/openclaw-sanitized.jsonl"]).toBeDefined();

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain(tempDir);
    expect(combined).toContain("log-tail-read-failed");
    expect(combined).toContain("sanitized log tail unavailable");
  });

  it.each(["stat", "size"] as const)("keeps writing after a config %s failure", async (failure) => {
    const fakeToken = "sk-test-config-stat-secret-token-1234567890";
    const configPath = path.join(tempDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      failure === "stat" ? "{}\n" : Buffer.alloc(8 * 1024 * 1024 + 1, "{"),
    );
    if (failure === "stat") {
      const originalStatSync = fs.statSync.bind(fs);
      vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
        if (target === configPath) {
          throw new Error(`config stat failed with token ${fakeToken}`);
        }
        return originalStatSync(target, options as never);
      });
    }
    const entries = await exportEntries();
    const error =
      failure === "stat" ? "config stat failed with token" : "File exceeds 8388608 bytes";
    expect(readJsonEntry(entries, "config/shape.json")).toMatchObject({
      parseOk: false,
      error: expect.stringContaining(error),
    });
    expect(entries["config/sanitized.json"]).toBe("null\n");
    if (failure === "stat") {
      expect(entries["summary.md"]).toContain(error);
    }
    expect(entries["summary.md"]).not.toContain("config file not found");
    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).toContain("Attach this zip to the bug report");
  });

  // Windows normalizes trailing whitespace in both directory and file names.
  it.skipIf(process.platform === "win32")(
    "preserves a quoted output directory name instead of trimming its whitespace",
    async () => {
      const quotedDir = path.join(tempDir, " quoted dir ");
      fs.mkdirSync(quotedDir);
      const result = await writeDiagnosticSupportExport({ outputPath: quotedDir });

      // beforeEach freezes the clock at 2026-04-22T12:00:01.000Z.
      const expectedName = `openclaw-diagnostics-2026-04-22T12-00-01-000Z-${process.pid}.zip`;
      expect(result.path).toBe(path.join(quotedDir, expectedName));
      expect(fs.existsSync(path.join(quotedDir, expectedName))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, " quoted dir"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves leading and trailing whitespace in an explicit output file path",
    async () => {
      const literalPath = path.join(tempDir, "spaced bundle ");
      const result = await writeDiagnosticSupportExport({ outputPath: literalPath });

      expect(result.path).toBe(literalPath);
      expect(fs.existsSync(literalPath)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "spaced bundle"))).toBe(false);
    },
  );

  it("treats a blank output path as omitted and writes to the default support directory", async () => {
    const result = await writeDiagnosticSupportExport({ outputPath: "   " });

    const expectedName = `openclaw-diagnostics-2026-04-22T12-00-01-000Z-${process.pid}.zip`;
    expect(result.path).toBe(path.join(tempDir, "logs", "support", expectedName));
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

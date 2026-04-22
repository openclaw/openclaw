import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  resetDiagnosticStabilityBundleForTest,
  writeDiagnosticStabilityBundleSync,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import { writeDiagnosticSupportExport } from "./diagnostic-support-export.js";
import { redactTextForSupport } from "./diagnostic-support-redaction.js";
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

describe("diagnostic support export", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-support-export-"));
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticStabilityBundleForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticStabilityBundleForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a shareable zip without raw chats, webhook bodies, or secrets", async () => {
    const fakeToken = "sk-test-support-export-secret-token-1234567890";
    const fakeAwsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const fakeJwt = [
      "eyJhbGciOiJIUzI1NiIs",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4i",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const privateChat = "private user said diagnose my bank transfer";
    const webhookBody = "raw webhook body with message contents";
    const credentialUrl =
      "wss://support-user:support-password@gateway.example/ws?token=short-token&ok=1";
    const configPath = path.join(tempDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: {
            mode: "local",
            bind: "loopback",
            port: 18789,
            auth: {
              mode: "token",
              token: fakeToken,
            },
          },
          logging: {
            redactSensitive: "off",
          },
          channels: {
            telegram: {
              accounts: {
                "15555551212": {
                  botToken: fakeToken,
                  allowFrom: [privateChat],
                },
              },
            },
          },
          agents: [{ name: "personal-agent", instructions: privateChat }],
        },
        null,
        2,
      ),
      "utf8",
    );

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
    const bundle = writeDiagnosticStabilityBundleSync({
      reason: "gateway.restart_startup_failed",
      stateDir: tempDir,
      now: new Date("2026-04-22T12:00:00.000Z"),
    });
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
          "0": JSON.stringify({ subsystem: "gateway/channels/matrix" }),
          "1": privateChat,
          _meta: {
            logLevelName: "warn",
            name: "gateway-runtime",
            hostname: "support-host",
          },
          time: "2026-04-22T12:00:00.300Z",
        }),
        `plain fallback ${privateChat} ${fakeToken}`,
      ],
    };
    let requestedLogTail: { limit?: number; maxBytes?: number } | undefined;

    const outputPath = path.join(tempDir, "support.zip");
    const result = await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-04-22T12:00:01.000Z"),
      readLogTail: async (params) => {
        requestedLogTail = params;
        return logTail;
      },
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
          message: privateChat,
        },
      }),
      readHealthSnapshot: async () => ({
        ok: true,
        channels: {
          telegram: {
            accounts: {
              "15555551212": {
                accountId: "15555551212",
                configured: true,
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
    expect(requestedLogTail).toMatchObject({
      limit: 5000,
      maxBytes: 1_000_000,
    });

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
    expect(combined).not.toContain(webhookBody);
    expect(combined).not.toContain("15555551212");
    expect(combined).not.toContain("support-password");
    expect(combined).not.toContain("short-token");
    expect(combined).not.toContain(tempDir);
    expect(combined).not.toContain("cron/jobs.json");
    expect(combined).not.toContain(os.hostname());
    expect(combined).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    expect(combined).not.toContain("sid=secret");
    expect(combined).not.toContain("structured secret payload");
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
    expect(sanitizedLogs).toContain("gateway websocket listening");
    expect(sanitizedLogs).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );
    expect(sanitizedLogs).toContain("Basic <redacted>");
    expect(sanitizedLogs).toContain("Cookie: <redacted>");
    expect(sanitizedLogs).toContain("<redacted-aws-key>");
    expect(sanitizedLogs).toContain("<redacted-jwt>");
    expect(sanitizedLogs).toContain('"module":"matrix-auto-reply"');
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

    const status = JSON.parse(entries["status/gateway-status.json"] ?? "{}") as {
      data?: {
        service?: {
          command?: {
            programArguments?: string[];
            environment?: Record<string, string>;
          };
        };
      };
    };
    expect(status.data?.service?.command?.programArguments).toEqual([
      "openclaw",
      "gateway",
      "run",
      "--token",
      "<redacted>",
    ]);
    expect(status.data?.service?.command?.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(status)).toContain(
      "wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
    );

    const health = JSON.parse(entries["health/gateway-health.json"] ?? "{}") as {
      data?: {
        channels?: {
          telegram?: {
            accounts?: { count?: number };
          };
        };
      };
    };
    expect(health.data?.channels?.telegram?.accounts).toEqual({ count: 1 });

    const configShape = JSON.parse(entries["config/shape.json"] ?? "{}") as {
      gateway?: { mode?: string; authMode?: string };
      channels?: { ids?: string[] };
    };
    expect(configShape.gateway).toMatchObject({
      mode: "local",
      authMode: "token",
    });
    expect(configShape.channels?.ids).toEqual(["telegram"]);

    const sanitizedConfig = JSON.parse(entries["config/sanitized.json"] ?? "{}") as {
      gateway?: {
        mode?: string;
        port?: number;
        auth?: {
          mode?: string;
          token?: string;
        };
      };
      channels?: {
        telegram?: {
          accounts?: Record<string, { botToken?: string; allowFrom?: { redacted?: boolean } }>;
        };
      };
      logging?: {
        redactSensitive?: string;
      };
      agents?: Array<{ name?: string; instructions?: string }>;
    };
    expect(sanitizedConfig.gateway).toMatchObject({
      mode: "local",
      port: 18789,
      auth: {
        mode: "token",
        token: "<redacted>",
      },
    });
    expect(sanitizedConfig.logging).toMatchObject({
      redactSensitive: "off",
    });
    expect(Object.keys(sanitizedConfig.channels?.telegram?.accounts ?? {})).toEqual([
      "<redacted-account-1>",
    ]);
    const sanitizedTelegramAccount =
      sanitizedConfig.channels?.telegram?.accounts?.["<redacted-account-1>"];
    expect(sanitizedTelegramAccount?.botToken).toBe("<redacted>");
    expect(sanitizedTelegramAccount?.allowFrom).toEqual({ redacted: true, count: 1 });
    expect(sanitizedConfig.agents?.[0]?.name).toBe("personal-agent");
    expect(sanitizedConfig.agents?.[0]?.instructions).toBe("<redacted>");
  });

  it("redacts support text identifiers without hiding useful URL hosts", () => {
    const fakeAwsKey = ["ASIA", "IOSFODNN7EXAMPLE"].join("");
    const fakeJwt = [
      "eyJhbGciOiJIUzI1NiIs",
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4i",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const cases = [
      [
        "connect wss://support-user:support-password@gateway.example/ws?token=short-token&ok=1",
        "connect wss://<redacted>:<redacted>@gateway.example/ws?token=<redacted>",
      ],
      [
        "connect https://gateway.example/ws?access-token=short-token",
        "connect https://gateway.example/ws?access-token=<redacted>",
      ],
      [
        "connect https://gateway.example/ws?hook-token=hook-secret",
        "connect https://gateway.example/ws?hook-token=<redacted>",
      ],
      ["connect https://token@gateway.example/ws", "connect https://<redacted>@gateway.example/ws"],
      ["auth Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==", "auth Basic <redacted>"],
      ["Cookie: sid=secret; theme=light", "Cookie: <redacted>"],
      [`aws ${fakeAwsKey}`, "aws <redacted-aws-key>"],
      [`jwt ${fakeJwt}`, "jwt <redacted-jwt>"],
      ["email alice@example.com", "email <redacted-email>"],
      ["matrix @support-user:matrix.example.com", "matrix <redacted-matrix-user>"],
      ["room !support-room:matrix.example.com", "room <redacted-matrix-room>"],
      ["event $F0Zlxky8bavuqH6MK75Av_c7UWFLp550WTQ1EA-F0KM", "event <redacted-matrix-event>"],
      ["notify @support_bot now", "notify <redacted-handle> now"],
      ["phone 15555551212", "phone <redacted-id>"],
    ] as const;

    for (const [input, expected] of cases) {
      expect(redactTextForSupport(input)).toBe(expected);
    }
  });

  it("keeps writing when status and health snapshots fail", async () => {
    const fakeToken = "sk-test-support-export-secret-token-1234567890";
    const outputPath = path.join(tempDir, "support-failed-snapshots.zip");

    await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-04-22T12:00:01.000Z"),
      readLogTail: async () => ({
        file: path.join(tempDir, "logs", "openclaw.log"),
        cursor: 0,
        size: 0,
        truncated: false,
        reset: false,
        lines: [],
      }),
      readStatusSnapshot: async () => {
        throw new Error(`status failed with token ${fakeToken}`);
      },
      readHealthSnapshot: async () => {
        throw new Error("health failed with PASSWORD=hunter2");
      },
    });

    const entries = await readZipTextEntries(outputPath);
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

    await writeDiagnosticSupportExport({
      env: {
        ...process.env,
        HOME: tempDir,
        OPENCLAW_STATE_DIR: tempDir,
      },
      stateDir: tempDir,
      outputPath,
      now: new Date("2026-04-22T12:00:02.000Z"),
      readLogTail: async () => {
        throw new Error(`log tail failed at ${tempDir}/openclaw.log with token ${fakeToken}`);
      },
    });

    const entries = await readZipTextEntries(outputPath);
    expect(Object.keys(entries).toSorted()).toContain("logs/openclaw-sanitized.jsonl");

    const combined = Object.values(entries).join("\n");
    expect(combined).not.toContain(fakeToken);
    expect(combined).not.toContain(tempDir);
    expect(combined).toContain("log-tail-read-failed");
    expect(combined).toContain("sanitized log tail unavailable");
  });
});

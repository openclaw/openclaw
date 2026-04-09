import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as loggingConfig from "../logging/config.js";
import {
  appendGatewayToolAuditRecord,
  createGatewayToolAuditRecord,
  resolveGatewayToolAuditLogPath,
} from "./tool-audit.js";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("gateway tool audit", () => {
  it("writes redacted JSONL audit records under the state logs directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-audit-"));
    createdDirs.push(home);
    const env = { ...process.env, HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
    const record = createGatewayToolAuditRecord({
      tool: "exec",
      args: { command: "OPENAI_API_KEY=sk-secret-token-1234567890" },
      ctx: {
        surface: "tools-invoke",
        sessionKey: "agent:main:main",
        messageChannel: "discord",
        model: null,
      },
      runId: "run-1",
      toolCallId: "call-1",
      now: "2026-04-08T20:00:00.000Z",
    });

    await appendGatewayToolAuditRecord({ record, env, homedir: () => home });

    const auditPath = resolveGatewayToolAuditLogPath(env, () => home);
    const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as { args?: { command?: string }; tool?: string };
    expect(parsed.tool).toBe("exec");
    expect(parsed.args?.command).not.toContain("sk-secret-token-1234567890");
  });

  it("honors configured redactPatterns when writing audit records", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-audit-"));
    createdDirs.push(home);
    const env = { ...process.env, HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
    const readLoggingConfigSpy = vi.spyOn(loggingConfig, "readLoggingConfig").mockReturnValue({
      redactPatterns: [String.raw`custom-secret-[A-Za-z0-9]+`],
    } as never);
    const record = createGatewayToolAuditRecord({
      tool: "exec",
      args: { command: "custom-secret-ABC123XYZ" },
      ctx: {
        surface: "tools-invoke",
        sessionKey: "agent:main:main",
        messageChannel: "discord",
        model: null,
      },
      runId: "run-1",
      toolCallId: "call-1",
      now: "2026-04-08T20:00:00.000Z",
    });

    await appendGatewayToolAuditRecord({ record, env, homedir: () => home });

    const auditPath = resolveGatewayToolAuditLogPath(env, () => home);
    const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
    const parsed = JSON.parse(lines[0] ?? "{}") as { args?: { command?: string } };
    expect(parsed.args?.command).not.toContain("custom-secret-ABC123XYZ");
    readLoggingConfigSpy.mockRestore();
  });
});

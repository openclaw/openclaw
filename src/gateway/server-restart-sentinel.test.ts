import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDeps } from "../cli/deps.js";
import * as agentModule from "../commands/agent.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import * as targets from "../infra/outbound/targets.js";
import { writeRestartSentinel } from "../infra/restart-sentinel.js";
import { scheduleRestartSentinelWake } from "./server-restart-sentinel.js";

describe("server restart sentinel", () => {
  let tempStateDir: string;
  let prevStateDir: string | undefined;
  let prevConfigPath: string | undefined;

  beforeEach(async () => {
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    prevConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const configPath = path.join(tempStateDir, "openclaw.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "{}", "utf-8");
  });

  afterEach(async () => {
    if (prevStateDir) {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
    if (prevConfigPath) {
      process.env.OPENCLAW_CONFIG_PATH = prevConfigPath;
    } else {
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("routes restart pings using the session lastAccountId", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const entry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      channel: "whatsapp",
      deliveryContext: { channel: "whatsapp", to: "+15555550123" },
      lastChannel: "whatsapp",
      lastTo: "+15555550123",
      lastAccountId: "work",
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: entry }, null, 2), "utf-8");
    await writeRestartSentinel({
      kind: "restart",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      deliveryContext: { channel: "whatsapp", to: "+15555550123" },
      message: "restart",
      doctorHint: "hint",
      stats: { mode: "gateway.restart", reason: "test" },
    });

    const resolveTargetSpy = vi
      .spyOn(targets, "resolveOutboundTarget")
      .mockReturnValue({ ok: true, to: "+15555550123" });
    const agentCommandSpy = vi.spyOn(agentModule, "agentCommand").mockResolvedValue(undefined);

    await scheduleRestartSentinelWake({ deps: createDefaultDeps() });

    const calledWith = resolveTargetSpy.mock.calls[0][0];
    expect(calledWith.accountId).toBe("work");
    expect(agentCommandSpy).toHaveBeenCalled();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  baseCommandTestConfig,
  buildCommandTestParams,
} from "./commands.test-harness.js";
import { handleHandoffCommand } from "./commands-handoff.js";
import type { HandleCommandsParams } from "./commands-types.js";

let stateDir: string;

async function readLatestHandoff(): Promise<string> {
  const scopesDir = path.join(stateDir, "handoffs", "scopes");
  const scopes = await fs.readdir(scopesDir);
  expect(scopes.length).toBe(1);
  return fs.readFile(path.join(scopesDir, scopes[0] ?? "", "latest.md"), "utf8");
}

function buildTelegramParams(commandBody: string): HandleCommandsParams {
  const cfg = {
    ...baseCommandTestConfig,
    channels: { telegram: { allowFrom: ["*"] } },
  } as OpenClawConfig;
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "telegram",
    Surface: "telegram",
    From: "7215741815",
    To: "bot",
    AccountId: "default",
    Body: commandBody,
    RawBody: commandBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
  }) as HandleCommandsParams;
  return {
    ...params,
    provider: "openai-codex",
    model: "gpt-5.5",
    sessionKey: "agent:telegram:telegram:direct:7215741815",
    contextTokens: 12_000,
    sessionEntry: {
      sessionId: "session-telegram",
      updatedAt: Date.now(),
      totalTokens: 158_100,
      totalTokensFresh: true,
    },
  };
}

describe("handleHandoffCommand", () => {
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("returns null for unrelated commands", async () => {
    const result = await handleHandoffCommand(buildTelegramParams("/status"), true);

    expect(result).toBeNull();
  });

  it("leaves /new as a fresh-session command without implicit handoff", async () => {
    const result = await handleHandoffCommand(buildTelegramParams("/new"), true);

    expect(result).toBeNull();
    await expect(fs.readdir(path.join(stateDir, "handoffs"))).rejects.toThrow();
  });

  it("saves a scoped handoff and preserves the raw operator note", async () => {
    const params = buildTelegramParams("/handoff Current MAINLINE\nKeep exact case and line");
    const result = await handleHandoffCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Handoff saved.");
    expect(result?.reply?.text).toContain("/new alone for a fresh topic");

    const content = await readLatestHandoff();
    expect(content).toContain("Current MAINLINE\nKeep exact case and line");
    expect(content).toContain("Source session: agent:telegram:telegram:direct:7215741815");
    expect(content).toContain("Token risk: 158k: handoff recommended");
    expect(content).toContain("/new alone starts fresh");
  });

  it("reports handoff status without creating a model turn", async () => {
    const result = await handleHandoffCommand(buildTelegramParams("/handoff status"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Handoff status");
    expect(result?.reply?.text).toContain("latest: none");
    expect(result?.reply?.text).toContain("/new alone starts fresh");
  });

  it("does not write handoff records for unauthorized senders", async () => {
    const params = buildTelegramParams("/handoff do not save");
    const result = await handleHandoffCommand(
      {
        ...params,
        command: {
          ...params.command,
          isAuthorizedSender: false,
        },
      },
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    await expect(fs.readdir(path.join(stateDir, "handoffs"))).rejects.toThrow();
  });

  it("loads /resume latest into the next agent prompt", async () => {
    await handleHandoffCommand(buildTelegramParams("/handoff resume this mainline"), true);

    const params = buildTelegramParams("/resume latest");
    const result = await handleHandoffCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect(result?.reply).toBeUndefined();
    expect(params.ctx.BodyForAgent).toContain("<openclaw_handoff_packet>");
    expect(params.ctx.BodyForAgent).toContain("resume this mainline");
  });

  it("does not resume when no scoped handoff exists", async () => {
    const result = await handleHandoffCommand(buildTelegramParams("/resume latest"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("No handoff found for this chat");
    expect(result?.reply?.text).toContain("/new alone for a fresh start");
  });
});

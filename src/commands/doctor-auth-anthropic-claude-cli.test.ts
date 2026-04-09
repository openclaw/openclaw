import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { maybeRepairRemovedAnthropicClaudeCliState } from "./doctor-auth-anthropic-claude-cli.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

let envSnapshot: ReturnType<typeof captureEnv>;
let tempAgentDir: string | undefined;

function makePrompter(confirmValue: boolean): DoctorPrompter {
  const repairMode: DoctorRepairMode = {
    shouldRepair: confirmValue,
    shouldForce: false,
    nonInteractive: false,
    canPrompt: true,
    updateInProgress: false,
  };
  return {
    confirm: async () => confirmValue,
    confirmAutoFix: async () => confirmValue,
    confirmAggressiveAutoFix: async () => confirmValue,
    confirmRuntimeRepair: async () => confirmValue,
    select: async <T>(_params: unknown, fallback: T) => fallback,
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}

beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]);
  tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
  process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

afterEach(() => {
  envSnapshot.restore();
  if (tempAgentDir) {
    fs.rmSync(tempAgentDir, { recursive: true, force: true });
    tempAgentDir = undefined;
  }
});

describe("maybeRepairRemovedAnthropicClaudeCliState", () => {
  it("converts stored Claude CLI Anthropic auth back to anthropic and removes stale config", async () => {
    if (!tempAgentDir) {
      throw new Error("Missing temp agent dir");
    }
    const authPath = path.join(tempAgentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "anthropic:claude-cli": {
              type: "oauth",
              provider: "claude-cli",
              access: "token-a",
              refresh: "token-r",
              expires: Date.now() + 60_000,
              email: "user@example.com",
            },
          },
          order: {
            anthropic: ["anthropic:claude-cli"],
            "claude-cli": ["anthropic:claude-cli"],
          },
          lastGood: {
            anthropic: "anthropic:claude-cli",
            "claude-cli": "anthropic:claude-cli",
          },
          usageStats: {
            "anthropic:claude-cli": {
              cooldownUntil: Date.now() + 30_000,
              cooldownReason: "rate_limit",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const next = await maybeRepairRemovedAnthropicClaudeCliState(
      {
        auth: {
          profiles: {
            "anthropic:claude-cli": {
              provider: "claude-cli",
              mode: "oauth",
            },
          },
          order: {
            anthropic: ["anthropic:claude-cli"],
            "claude-cli": ["anthropic:claude-cli"],
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "claude-cli/claude-sonnet-4-6",
              fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.4"],
            },
            models: {
              "claude-cli/claude-sonnet-4-6": { alias: "Claude" },
            },
          },
        },
      } as OpenClawConfig,
      makePrompter(true),
    );

    expect(next.auth?.profiles?.["anthropic:claude-cli"]).toBeUndefined();
    expect(next.auth?.profiles?.["anthropic:user@example.com"]).toMatchObject({
      provider: "anthropic",
      mode: "oauth",
      email: "user@example.com",
    });
    expect(next.auth?.order?.anthropic).toEqual(["anthropic:user@example.com"]);
    expect(next.auth?.order?.["claude-cli"]).toBeUndefined();
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-sonnet-4-6",
      fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.models?.["claude-cli/claude-sonnet-4-6"]).toBeUndefined();
    expect(next.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]).toEqual({
      alias: "Claude",
    });

    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      profiles?: Record<string, unknown>;
      order?: Record<string, string[]>;
      lastGood?: Record<string, string>;
      usageStats?: Record<string, unknown>;
    };
    expect(raw.profiles?.["anthropic:claude-cli"]).toBeUndefined();
    expect(raw.profiles?.["anthropic:user@example.com"]).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "token-a",
      refresh: "token-r",
      email: "user@example.com",
    });
    expect(raw.order?.anthropic).toEqual(["anthropic:user@example.com"]);
    expect(raw.order?.["claude-cli"]).toBeUndefined();
    expect(raw.lastGood?.anthropic).toBe("anthropic:user@example.com");
    expect(raw.lastGood?.["claude-cli"]).toBeUndefined();
    expect(raw.usageStats?.["anthropic:claude-cli"]).toBeUndefined();
    expect(raw.usageStats?.["anthropic:user@example.com"]).toBeDefined();
  });

  it("removes stale Claude CLI Anthropic config when no stored credential bytes exist", async () => {
    if (!tempAgentDir) {
      throw new Error("Missing temp agent dir");
    }
    const authPath = path.join(tempAgentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-ant-test",
            },
          },
          order: {
            anthropic: ["anthropic:claude-cli", "anthropic:default"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const next = await maybeRepairRemovedAnthropicClaudeCliState(
      {
        auth: {
          profiles: {
            "anthropic:claude-cli": {
              provider: "claude-cli",
              mode: "oauth",
            },
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
          order: {
            anthropic: ["anthropic:claude-cli", "anthropic:default"],
          },
        },
        agents: {
          defaults: {
            model: "claude-cli/claude-sonnet-4-6",
            models: {
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig,
      makePrompter(true),
    );

    expect(next.auth?.profiles?.["anthropic:claude-cli"]).toBeUndefined();
    expect(next.auth?.profiles?.["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(next.auth?.order?.anthropic).toEqual(["anthropic:default"]);
    expect(next.agents?.defaults?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(next.agents?.defaults?.models?.["claude-cli/claude-sonnet-4-6"]).toBeUndefined();
    expect(next.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]).toEqual({});

    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      profiles?: Record<string, unknown>;
      order?: Record<string, string[]>;
    };
    expect(raw.profiles?.["anthropic:claude-cli"]).toBeUndefined();
    expect(raw.profiles?.["anthropic:default"]).toBeDefined();
    expect(raw.order?.anthropic).toEqual(["anthropic:default"]);
  });
});

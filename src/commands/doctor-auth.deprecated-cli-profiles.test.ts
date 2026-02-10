import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { maybeRemoveDeprecatedCliAuthProfiles } from "./doctor-auth.js";

let originalAgentDir: string | undefined;
let originalPiAgentDir: string | undefined;
let tempAgentDir: string | undefined;

function makePrompter(confirmValue: boolean): DoctorPrompter {
  return {
    confirm: vi.fn().mockResolvedValue(confirmValue),
    confirmRepair: vi.fn().mockResolvedValue(confirmValue),
    confirmAggressive: vi.fn().mockResolvedValue(confirmValue),
    confirmSkipInNonInteractive: vi.fn().mockResolvedValue(confirmValue),
    select: vi.fn().mockResolvedValue(""),
    shouldRepair: confirmValue,
    shouldForce: false,
  };
}

beforeEach(() => {
  originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
  process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.OPENCLAW_AGENT_DIR;
  } else {
    process.env.OPENCLAW_AGENT_DIR = originalAgentDir;
  }
  if (originalPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  }
  if (tempAgentDir) {
    fs.rmSync(tempAgentDir, { recursive: true, force: true });
    tempAgentDir = undefined;
  }
});

describe("maybeRemoveDeprecatedCliAuthProfiles", () => {
  it("removes deprecated codex-cli profile but preserves claude-cli", async () => {
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
              provider: "anthropic",
              access: "token-a",
              refresh: "token-r",
              expires: Date.now() + 60_000,
            },
            "openai-codex:codex-cli": {
              type: "oauth",
              provider: "openai-codex",
              access: "token-b",
              refresh: "token-r2",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const cfg = {
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "anthropic", mode: "oauth" },
          "openai-codex:codex-cli": { provider: "openai-codex", mode: "oauth" },
        },
        order: {
          anthropic: ["anthropic:claude-cli"],
          "openai-codex": ["openai-codex:codex-cli"],
        },
      },
    } as const;

    const next = await maybeRemoveDeprecatedCliAuthProfiles(cfg, makePrompter(true));

    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      profiles?: Record<string, unknown>;
    };
    // claude-cli is NOT deprecated — it should be preserved
    expect(raw.profiles?.["anthropic:claude-cli"]).toBeDefined();
    // codex-cli IS deprecated — it should be removed
    expect(raw.profiles?.["openai-codex:codex-cli"]).toBeUndefined();

    expect(next.auth?.profiles?.["anthropic:claude-cli"]).toBeDefined();
    expect(next.auth?.profiles?.["openai-codex:codex-cli"]).toBeUndefined();
    expect(next.auth?.order?.anthropic).toBeDefined();
    expect(next.auth?.order?.["openai-codex"]).toBeUndefined();
  });
});

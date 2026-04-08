import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { captureEnv } from "../test-utils/env.js";
import { maybeRepairLegacyOAuthProfileIds } from "./doctor-auth.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const resolvePluginProvidersMock = vi.fn<() => ProviderPlugin[]>(() => []);
const isPluginProvidersLoadInFlightMock = vi.fn(() => false);

vi.mock("../plugins/providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => isPluginProvidersLoadInFlightMock(),
  resolvePluginProviders: () => resolvePluginProvidersMock(),
}));

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
    confirm: vi.fn().mockResolvedValue(confirmValue),
    confirmAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmAggressiveAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(confirmValue),
    select: vi.fn().mockResolvedValue(""),
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
  resolvePluginProvidersMock.mockReset();
  resolvePluginProvidersMock.mockReturnValue([]);
  isPluginProvidersLoadInFlightMock.mockReset();
  isPluginProvidersLoadInFlightMock.mockReturnValue(false);
});

afterEach(() => {
  envSnapshot.restore();
  if (tempAgentDir) {
    fs.rmSync(tempAgentDir, { recursive: true, force: true });
    tempAgentDir = undefined;
  }
});

describe("maybeRepairLegacyOAuthProfileIds", () => {
  it("repairs provider-owned legacy OAuth profile ids", async () => {
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
            "anthropic:user@example.com": {
              type: "oauth",
              provider: "anthropic",
              access: "token-a",
              refresh: "token-r",
              expires: Date.now() + 60_000,
              email: "user@example.com",
            },
          },
          lastGood: {
            anthropic: "anthropic:user@example.com",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default" }],
      },
    ]);

    const next = await maybeRepairLegacyOAuthProfileIds(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
          order: {
            anthropic: ["anthropic:default"],
          },
        },
      } as OpenClawConfig,
      makePrompter(true),
    );

    expect(next.auth?.profiles?.["anthropic:default"]).toBeUndefined();
    expect(next.auth?.profiles?.["anthropic:user@example.com"]).toMatchObject({
      provider: "anthropic",
      mode: "oauth",
      email: "user@example.com",
    });
    expect(next.auth?.order?.anthropic).toEqual(["anthropic:user@example.com"]);
  });
});

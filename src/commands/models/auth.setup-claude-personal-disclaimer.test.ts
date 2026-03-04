import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SDK_POLICY_WARNING_LINES } from "../../agents/claude-sdk-runner/logging.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  upsertAuthProfile: vi.fn(),
  updateConfig: vi.fn(async (_updater: unknown) => {}),
  logConfigUpdated: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => mocks.confirm(...args),
  select: (...args: unknown[]) => mocks.select(...args),
  text: (...args: unknown[]) => mocks.text(...args),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  upsertAuthProfile: (...args: unknown[]) => mocks.upsertAuthProfile(...args),
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: (...args: unknown[]) => mocks.logConfigUpdated(...args),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return {
    ...actual,
    updateConfig: (updater: unknown) => mocks.updateConfig(updater),
  };
});

import { modelsAuthSetupClaudePersonalCommand } from "./auth.js";

function makeRuntime() {
  return {
    log: vi.fn(),
  } as unknown as RuntimeEnv & { log: ReturnType<typeof vi.fn> };
}

describe("modelsAuthSetupClaudePersonalCommand policy disclaimer", () => {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");

  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.select.mockReset();
    mocks.text.mockReset();
    mocks.upsertAuthProfile.mockReset();
    mocks.updateConfig.mockReset();
    mocks.logConfigUpdated.mockReset();
    mocks.updateConfig.mockResolvedValue(undefined);

    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });
  });

  afterEach(() => {
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("prints policy disclaimer and creates profile after acknowledgment", async () => {
    const runtime = makeRuntime();
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await modelsAuthSetupClaudePersonalCommand({ provider: "claude-personal" }, runtime);

    for (const line of CLAUDE_SDK_POLICY_WARNING_LINES) {
      expect(runtime.log).toHaveBeenCalledWith(line);
    }
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    const firstProfileWrite = mocks.upsertAuthProfile.mock.calls[0]?.[0] as
      | { profileId?: string; credential?: { type?: string; provider?: string; token?: string } }
      | undefined;
    expect(firstProfileWrite?.profileId?.endsWith(":system-keychain")).toBe(true);
    expect(firstProfileWrite?.credential).toMatchObject({
      type: "token",
      token: "system-keychain",
    });
    const expectedProvider = firstProfileWrite?.profileId?.replace(":system-keychain", "");
    expect(firstProfileWrite?.credential?.provider).toBe(expectedProvider);
    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
  });

  it("cancels setup when policy is not acknowledged", async () => {
    const runtime = makeRuntime();
    mocks.confirm.mockResolvedValueOnce(false);

    await modelsAuthSetupClaudePersonalCommand({ provider: "claude-personal" }, runtime);

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("Cancelled Claude Code keychain setup.");
  });

  it("still prints disclaimer in --yes mode", async () => {
    const runtime = makeRuntime();

    await modelsAuthSetupClaudePersonalCommand({ provider: "claude-personal", yes: true }, runtime);

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("Important Anthropic policy notice:");
    expect(mocks.upsertAuthProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
  });
});

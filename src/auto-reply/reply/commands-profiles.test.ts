import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const ensureAuthProfileStoreMock = vi.fn();
  const resolveAuthProfileOrderMock = vi.fn();
  return { ensureAuthProfileStoreMock, resolveAuthProfileOrderMock };
});

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: hoisted.ensureAuthProfileStoreMock,
  resolveAuthProfileOrder: hoisted.resolveAuthProfileOrderMock,
}));

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { handleProfileCommand, handleProfilesCommand } = await import("./commands-profiles.js");

const cfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/profile commands", () => {
  it("sets a session auth profile override", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai-codex:work": { provider: "openai-codex", type: "oauth", token: "t" },
      },
    });

    const params = buildCommandTestParams("/profile openai-codex:work", cfg);
    params.provider = "openai-codex";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleProfileCommand(params, true);
    expect(result?.reply?.text).toContain("set to openai-codex:work");
    expect(params.sessionEntry.authProfileOverride).toBe("openai-codex:work");
    expect(params.sessionEntry.authProfileOverrideSource).toBe("user");
  });

  it("clears session auth profile override", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });

    const params = buildCommandTestParams("/profile clear", cfg);
    params.provider = "openai-codex";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai-codex:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    };
    params.sessionStore = {};

    const result = await handleProfileCommand(params, true);
    expect(result?.reply?.text).toContain("Cleared session profile override");
    expect(params.sessionEntry.authProfileOverride).toBeUndefined();
    expect(params.sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(params.sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("lists profiles for provider", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai-codex:work": { provider: "openai-codex", type: "oauth", token: "t" },
        "openai-codex:personal": { provider: "openai-codex", type: "oauth", token: "t2" },
      },
    });
    hoisted.resolveAuthProfileOrderMock.mockReturnValue([
      "openai-codex:work",
      "openai-codex:personal",
    ]);

    const params = buildCommandTestParams("/profiles", cfg);
    params.provider = "openai-codex";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai-codex:personal",
    };

    const result = await handleProfilesCommand(params, true);
    expect(result?.reply?.text).toContain("Profiles (openai-codex)");
    expect(result?.reply?.text).toContain("* openai-codex:personal");
  });
});

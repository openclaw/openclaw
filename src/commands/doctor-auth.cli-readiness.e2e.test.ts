import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  version: 1,
  profiles: {
    "anthropic:default": {
      type: "token",
      provider: "anthropic",
      token: "anthropic-token",
      expires: Date.now() - 60_000,
    },
    "openai-codex:default": {
      type: "token",
      provider: "openai-codex",
      token: "codex-token",
      expires: Date.now() - 60_000,
    },
  },
  usageStats: {},
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: vi.fn(() => store),
    resolveProfileUnusableUntilForDisplay: vi.fn(() => undefined),
  };
});

import { noteAuthProfileHealth, noteCliProviderReadiness } from "./doctor-auth.js";

function createPrompter() {
  return {
    confirm: vi.fn().mockResolvedValue(false),
    confirmRepair: vi.fn().mockResolvedValue(false),
    confirmAggressive: vi.fn().mockResolvedValue(false),
    confirmSkipInNonInteractive: vi.fn().mockResolvedValue(false),
    select: vi.fn().mockResolvedValue(""),
    shouldRepair: false,
    shouldForce: false,
  };
}

describe("doctor auth provider scoping and cli readiness", () => {
  beforeEach(() => {
    note.mockClear();
  });

  it("skips auth health notes when provider scope is empty", async () => {
    await noteAuthProfileHealth({
      cfg: {} as OpenClawConfig,
      prompter: createPrompter(),
      allowKeychainPrompt: false,
      providers: [],
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("limits model auth warnings to requested providers", async () => {
    await noteAuthProfileHealth({
      cfg: {} as OpenClawConfig,
      prompter: createPrompter(),
      allowKeychainPrompt: false,
      providers: ["openai-codex"],
    });

    const rendered = note.mock.calls.map((call) => String(call[0])).join("\n");
    expect(rendered).toContain("openai-codex:default");
    expect(rendered).not.toContain("anthropic:default");
  });

  it("notes unresolved cli backend command with actionable hint", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "definitely-missing-openclaw-cli",
            },
          },
        },
      },
    } as OpenClawConfig;

    await noteCliProviderReadiness({
      cfg,
      providersInUse: ["claude-cli"],
    });

    expect(note).toHaveBeenCalled();
    const rendered = note.mock.calls.map((call) => String(call[0])).join("\n");
    expect(rendered).toContain("claude-cli");
    expect(rendered).toContain("not found");
    expect(rendered).toContain('cliBackends["claude-cli"].command');
  });
});

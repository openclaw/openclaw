import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { checkAccount } from "./imap-himalaya.js";
import { runImapService, runImapSetup } from "./imap-ops.js";
import { startImapWatcher, stopImapWatcher } from "./imap-watcher.js";

function makeSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.config.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: config,
    valid: true,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

vi.mock("../agents/skills.js", () => ({
  hasBinary: vi.fn(() => true),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    readConfigFileSnapshot: vi.fn(async () => makeSnapshot({})),
    validateConfigObjectWithPlugins: vi.fn((config: OpenClawConfig) => ({ ok: true, config })),
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("./imap-himalaya.js", () => ({
  checkAccount: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./imap-watcher.js", () => ({
  startImapWatcher: vi.fn(),
  stopImapWatcher: vi.fn(),
}));

describe("imap-ops", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws when watcher does not start", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      hooks: {
        enabled: true,
        token: "hook-token",
        imap: { account: "configured-account" },
      },
    } satisfies OpenClawConfig);
    vi.mocked(startImapWatcher).mockResolvedValue({
      started: false,
      reason: "himalaya binary not found",
    });

    await expect(runImapService({ account: "override-account" })).rejects.toThrow(
      "himalaya binary not found",
    );
    expect(stopImapWatcher).not.toHaveBeenCalled();
  });

  it("uses persisted himalayaConfig for account validation when flag is omitted", async () => {
    const configModule = await import("../config/config.js");
    vi.mocked(configModule.readConfigFileSnapshot).mockResolvedValueOnce(
      makeSnapshot({
        hooks: {
          imap: {
            himalayaConfig: "/custom/himalaya.toml",
          },
        },
      } satisfies OpenClawConfig),
    );

    await runImapSetup({ account: "configured-account" });

    expect(checkAccount).toHaveBeenCalledWith({
      account: "configured-account",
      config: "/custom/himalaya.toml",
    });
  });

  it("preserves existing himalayaConfig when setup flag is absent", async () => {
    const configModule = await import("../config/config.js");
    vi.mocked(configModule.readConfigFileSnapshot).mockResolvedValueOnce(
      makeSnapshot({
        hooks: {
          imap: {
            himalayaConfig: "/custom/himalaya.toml",
          },
        },
      } satisfies OpenClawConfig),
    );

    await runImapSetup({ account: "configured-account" });

    expect(configModule.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        hooks: expect.objectContaining({
          imap: expect.objectContaining({
            himalayaConfig: "/custom/himalaya.toml",
          }),
        }),
      }),
    );
  });
});

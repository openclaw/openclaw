import { afterEach, describe, expect, it, vi } from "vitest";

// Mock heavy config modules to avoid transitive dependency issues in tests
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../config/config-paths.js", () => ({
  setConfigValueAtPath: vi.fn(),
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeAccountId: (id: string) => id || "default",
}));

import { setConfigValueAtPath } from "../config/config-paths.js";
import {
  readConfigFileSnapshotForWrite,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import type { ParsedSettingsCallback } from "./settings-buttons.js";
import {
  buildSettingsCommandResponse,
  handleSettingsCallback,
  _resolveConfigPath,
  _applySettingChange,
} from "./settings-panel.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("_resolveConfigPath", () => {
  it("returns base telegram path for default account", () => {
    expect(_resolveConfigPath("default", "dmpol")).toEqual(["channels", "telegram", "dmPolicy"]);
    expect(_resolveConfigPath("default", "grppol")).toEqual([
      "channels",
      "telegram",
      "groupPolicy",
    ]);
    expect(_resolveConfigPath("default", "stream")).toEqual(["channels", "telegram", "streaming"]);
  });

  it("returns account-scoped path for named accounts", () => {
    expect(_resolveConfigPath("prod", "dmpol")).toEqual([
      "channels",
      "telegram",
      "accounts",
      "prod",
      "dmPolicy",
    ]);
  });
});

describe("buildSettingsCommandResponse", () => {
  it("renders main menu with config values", () => {
    const cfg: TelegramAccountConfig = {
      dmPolicy: "allowlist",
      groupPolicy: "disabled",
      streaming: "block",
    };
    const result = buildSettingsCommandResponse(cfg);
    expect(result.text).toContain("DM Policy: allowlist");
    expect(result.text).toContain("Group Policy: disabled");
    expect(result.text).toContain("Streaming: block");
    expect(result.buttons).toHaveLength(2);
  });

  it("uses defaults for missing config", () => {
    const result = buildSettingsCommandResponse({});
    expect(result.text).toContain("DM Policy: pairing");
    expect(result.text).toContain("Group Policy: open");
    expect(result.text).toContain("Streaming: partial");
  });
});

describe("handleSettingsCallback", () => {
  function createMockParams(
    parsed: ParsedSettingsCallback,
    telegramCfg: TelegramAccountConfig = {},
  ) {
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const answerCallback = vi.fn().mockResolvedValue(undefined);
    return {
      params: {
        parsed,
        cfg: {} as OpenClawConfig,
        accountId: "default",
        telegramCfg,
        editMessage,
        answerCallback,
      },
      editMessage,
      answerCallback,
    };
  }

  it("renders main menu on 'menu' callback", async () => {
    const { params, editMessage } = createMockParams({ type: "menu" });
    await handleSettingsCallback(params);
    expect(editMessage).toHaveBeenCalledOnce();
    const [text] = editMessage.mock.calls[0];
    expect(text).toContain("Settings");
    expect(text).toContain("DM Policy:");
  });

  it("renders submenu on 'submenu' callback", async () => {
    const { params, editMessage } = createMockParams(
      { type: "submenu", setting: "dmpol" },
      { dmPolicy: "open" },
    );
    await handleSettingsCallback(params);
    expect(editMessage).toHaveBeenCalledOnce();
    const [text] = editMessage.mock.calls[0];
    expect(text).toContain("DM Policy");
    expect(text).toContain("open \u2713");
  });

  it("renders allowlist view on 'allow' submenu", async () => {
    const { params, editMessage } = createMockParams(
      { type: "submenu", setting: "allow" },
      { allowFrom: [123, "@alice"], groupAllowFrom: [456] },
    );
    await handleSettingsCallback(params);
    expect(editMessage).toHaveBeenCalledOnce();
    const [text] = editMessage.mock.calls[0];
    expect(text).toContain("Allowlist");
    expect(text).toContain("123");
    expect(text).toContain("@alice");
    expect(text).toContain("456");
  });

  it("silently no-ops when value is already set", async () => {
    const { params, answerCallback, editMessage } = createMockParams(
      { type: "set", setting: "dmpol", value: "pairing" },
      { dmPolicy: "pairing" },
    );
    await handleSettingsCallback(params);
    expect(answerCallback).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("applies config change and re-renders submenu", async () => {
    const mockSnapshot = {
      snapshot: {
        valid: true,
        resolved: { channels: { telegram: { dmPolicy: "pairing" } } },
      },
      writeOptions: {},
    };
    vi.mocked(readConfigFileSnapshotForWrite).mockResolvedValue(mockSnapshot as never);
    vi.mocked(validateConfigObjectWithPlugins).mockReturnValue({
      ok: true,
      config: {} as OpenClawConfig,
      warnings: [],
    });
    vi.mocked(writeConfigFile).mockResolvedValue(undefined);

    const { params, editMessage, answerCallback } = createMockParams(
      { type: "set", setting: "dmpol", value: "open" },
      { dmPolicy: "pairing" },
    );
    await handleSettingsCallback(params);
    expect(answerCallback).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledOnce();
    const [text] = editMessage.mock.calls[0];
    expect(text).toContain("open \u2713");
    expect(setConfigValueAtPath).toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("shows error on validation failure", async () => {
    const mockSnapshot = {
      snapshot: {
        valid: true,
        resolved: { channels: { telegram: {} } },
      },
      writeOptions: {},
    };
    vi.mocked(readConfigFileSnapshotForWrite).mockResolvedValue(mockSnapshot as never);
    vi.mocked(validateConfigObjectWithPlugins).mockReturnValue({
      ok: false,
      issues: [{ path: "test", message: "Invalid value" }],
      warnings: [],
    });

    const { params, editMessage, answerCallback } = createMockParams(
      { type: "set", setting: "grppol", value: "disabled" },
      { groupPolicy: "open" },
    );
    await handleSettingsCallback(params);
    expect(answerCallback).toHaveBeenCalledWith("Failed: Invalid value");
    expect(editMessage).toHaveBeenCalledOnce();
    const [text] = editMessage.mock.calls[0];
    expect(text).toContain("\u274c Invalid value");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("handles config file read errors", async () => {
    vi.mocked(readConfigFileSnapshotForWrite).mockRejectedValue(new Error("file locked"));

    const { params, answerCallback, editMessage } = createMockParams(
      { type: "set", setting: "stream", value: "block" },
      { streaming: "partial" },
    );
    await handleSettingsCallback(params);
    expect(answerCallback).toHaveBeenCalledWith(expect.stringContaining("file locked"));
    expect(editMessage).toHaveBeenCalledOnce();
  });
});

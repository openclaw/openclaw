import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());
const addChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
const removeChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../pairing/pairing-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../pairing/pairing-store.js")>(
    "../../pairing/pairing-store.js",
  );
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    addChannelAllowFromStoreEntry: addChannelAllowFromStoreEntryMock,
    removeChannelAllowFromStoreEntry: removeChannelAllowFromStoreEntryMock,
  };
});

vi.mock("../../channels/plugins/pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/pairing.js")>(
    "../../channels/plugins/pairing.js",
  );
  return {
    ...actual,
    listPairingChannels: () => ["telegram"],
  };
});

function buildParams(commandBody: string, cfg: ClawdbotConfig, ctxOverrides?: Partial<MsgContext>) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "telegram",
    Surface: "telegram",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "telegram",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("handleCommands /allowlist", () => {
  it("lists config + store allowFrom entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValueOnce(["456"]);

    const cfg = {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["123", "@Alice"] } },
    } as ClawdbotConfig;
    const params = buildParams("/allowlist list dm", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Channel: telegram");
    expect(result.reply?.text).toContain("DM allowFrom (config): 123, @alice");
    expect(result.reply?.text).toContain("Paired allowFrom (store): 456");
  });

  it("adds entries to config and pairing store", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: {
        channels: { telegram: { allowFrom: ["123"] } },
      },
    });
    validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
      ok: true,
      config,
    }));
    addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
      changed: true,
      allowFrom: ["123", "789"],
    });

    const cfg = {
      commands: { text: true, config: true },
      channels: { telegram: { allowFrom: ["123"] } },
    } as ClawdbotConfig;
    const params = buildParams("/allowlist add dm 789", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { telegram: { allowFrom: ["123", "789"] } },
      }),
    );
    expect(addChannelAllowFromStoreEntryMock).toHaveBeenCalledWith({
      channel: "telegram",
      entry: "789",
    });
    expect(result.reply?.text).toContain("DM allowlist added");
  });
});

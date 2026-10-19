// Load the existing mocked I/O boundaries at collection, outside command case deadlines.
import "../../../commands/message.js";
import "../../../plugins/loader.js";
import "../../deps.js";
import "../config-guard.js";
import { Command } from "commander";
import { vi } from "vitest";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { registerMessageCommands } from "../register.message.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(async (_options: Record<string, unknown>) => undefined),
  exit: vi.fn(),
}));

export const messageCliMocks = mocks;

vi.mock("../../../commands/message.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../commands/message.js")>()),
  messageCommand: mocks.command,
}));
vi.mock("../../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/config.js")>()),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));
vi.mock("../config-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config-guard.js")>()),
  ensureConfigReady: async () => {},
}));
vi.mock("../../../plugins/channel-plugin-ids.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/channel-plugin-ids.js")>()),
  resolveConfiguredChannelPluginIds: () => [],
  resolveDiscoverableScopedChannelPluginIds: ({ channelIds }: { channelIds: string[] }) =>
    channelIds,
}));
vi.mock("../../../plugins/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/loader.js")>()),
  loadPluginRegistryHandle: () => createMockPluginRegistry([]),
}));
vi.mock("../../deps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../deps.js")>()),
  createDefaultDeps: () => ({}),
}));
vi.mock("../../one-shot-exit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../one-shot-exit.js")>()),
  requestExitAfterOneShotOutput: (_runtime: unknown, code: number) => {
    mocks.exit(code);
    return true;
  },
}));

export function createMessageCliProgram(channels = "discord|matrix|msteams|slack") {
  const program = new Command()
    .name("openclaw")
    .exitOverride()
    .configureOutput({ writeErr() {}, writeOut() {} });
  registerMessageCommands(program, {
    programVersion: "test",
    messageChannelOptions: channels,
    agentChannelOptions: `last|${channels}`,
  });
  return program;
}

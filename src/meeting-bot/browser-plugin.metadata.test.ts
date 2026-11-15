import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../plugin-sdk/plugin-entry.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";

type CliMetadata = {
  register(api: OpenClawPluginApi): void;
  descriptor: { machineOutput: (params: { argv: readonly string[] }) => boolean };
};

afterEach(() => {
  vi.doUnmock("openclaw/plugin-sdk/meeting-runtime");
  vi.resetModules();
});

describe.each([
  {
    id: "zoom-meetings",
    name: "Zoom meetings",
    command: "zoommeetings",
    description: "Join and manage Zoom meeting guests",
  },
  {
    id: "teams-meetings",
    name: "Microsoft Teams meetings",
    command: "teamsmeetings",
    description: "Join and manage Microsoft Teams meeting guests",
  },
  {
    id: "slack-huddles",
    name: "Slack huddles",
    command: "slackhuddles",
    description: "Join and manage Slack huddle participants",
  },
])("$name CLI output mode", ({ id, name, command, description }) => {
  it("loads and registers metadata without the meeting runtime", async () => {
    vi.resetModules();
    vi.doMock("openclaw/plugin-sdk/meeting-runtime", () => {
      throw new Error("CLI metadata must not load the meeting runtime");
    });
    const { default: metadata } = await loadBundledPluginFacade<{ default: CliMetadata }>({
      pluginId: id,
      artifactBasename: "cli-metadata.js",
    });
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    const api = createTestPluginApi({ registerCli });
    metadata.register(api);
    expect(metadata).toMatchObject({ id, name, description: `${name} CLI metadata` });
    expect(registerCli).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      descriptors: [
        { name: command, description, hasSubcommands: true, machineOutput: expect.any(Function) },
      ],
    });
    const program = new Command();
    for (const [register] of registerCli.mock.calls) {
      await register({ program, parentPath: [], config: {}, logger: api.logger });
    }
    expect(program.commands).toEqual([]);
    const isMachineOutput = metadata.descriptor.machineOutput;
    for (const [args, expected] of [
      [["status"], true],
      [[], false],
      [["--log-level", "debug", "future-action"], true],
    ] as const) {
      expect(isMachineOutput({ argv: ["node", "openclaw", command, ...args] })).toBe(expected);
    }
  });
});

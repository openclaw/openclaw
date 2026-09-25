// Non-TTY `channels add` advice must name only flags the selected channel registers.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { configMocks } from "./channels.mock-harness.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const channelMocks = vi.hoisted(() => ({
  listBundledPackageChannelMetadata: vi.fn((): PluginPackageChannel[] => []),
}));
const terminalMocks = vi.hoisted(() => ({ isTerminalInteractive: vi.fn() }));

vi.mock("../plugins/bundled-package-channel-metadata.js", () => channelMocks);
vi.mock("../channels/plugins/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/catalog.js")>()),
  listRawChannelPluginCatalogEntries: vi.fn(() => []),
}));
vi.mock("../cli/terminal-interactivity.js", () => terminalMocks);
vi.mock("../wizard/clack-prompter.js", () => ({ createClackPrompter: vi.fn() }));
// The advice exits before any channel plugin is loaded, so keep that graph out of
// this file's cost.
vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: vi.fn(() => undefined),
  normalizeChannelId: vi.fn((id: string) => id),
}));

let channelsAddCommand: typeof import("./channels/add.js").channelsAddCommand;
beforeAll(async () => {
  ({ channelsAddCommand } = await import("./channels/add.js"));
});

describe("channelsAddCommand non-TTY advice", () => {
  it("points at the channel's help command when its setup contract omits --use-env", async () => {
    channelMocks.listBundledPackageChannelMetadata.mockReturnValue([
      {
        id: "fixture-signal",
        setup: {
          fields: [
            {
              key: "httpUrl",
              kind: "string",
              cli: { flags: "--http-url <url>", description: "Signal HTTP service URL" },
            },
          ],
        },
      },
    ]);
    terminalMocks.isTerminalInteractive.mockReturnValue(false);
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    const runtime = createTestRuntime();

    await channelsAddCommand({ channel: "fixture-signal" }, runtime, { hasFlags: false });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels add --channel fixture-signal --help"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("channels add --channel <id> --use-env"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

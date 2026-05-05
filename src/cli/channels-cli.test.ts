import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChannelsCli } from "./channels-cli.js";

const listBundledPackageChannelMetadataMock = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/bundled-package-channel-metadata.js", () => ({
  listBundledPackageChannelMetadata: listBundledPackageChannelMetadataMock,
}));

describe("registerChannelsCli", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.clearAllMocks();
  });

  it("loads channel-specific add options only for channels add invocations", async () => {
    process.argv = ["node", "openclaw", "channels"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).not.toHaveBeenCalled();

    process.argv = ["node", "openclaw", "channels", "add", "--help"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
  });
});

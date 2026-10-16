import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerChannelsCli } from "./channels-cli.js";

const addCommand = vi.hoisted(() => vi.fn(async () => undefined));

// mock-isolation: Exercise registration without reading installed plugins or user state.
vi.mock("../plugins/bundled-package-channel-metadata.js", () => ({
  listBundledPackageChannelMetadata: () => [
    {
      id: "matrix",
      setup: {
        fields: [
          {
            key: "homeserver",
            kind: "string",
            cli: { flags: "--homeserver <url>", description: "Matrix homeserver URL" },
          },
        ],
      },
    },
  ],
}));

// mock-isolation: Keep catalog discovery outside this command parsing fixture.
vi.mock("../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: () => [],
}));

// mock-isolation: Observe parsed options without writing account configuration.
vi.mock("../commands/channels.js", () => ({ channelsAddCommand: addCommand }));

// mock-isolation: Login and logout are unrelated to add-command argument parsing.
vi.mock("./channel-auth.js", () => ({ runChannelLogin: vi.fn(), runChannelLogout: vi.fn() }));

afterEach(() => vi.clearAllMocks());

it.each([
  { label: "empty name", selection: ["--name", "", "--channel", "matrix"], expected: { name: "" } },
  {
    label: "terminator-like name",
    selection: ["--name", "--", "--channel", "matrix"],
    expected: { name: "--" },
  },
  ...["name", "account", "agent"].flatMap((field) =>
    ["--channel", "--channel=signal"].map((value) => ({
      label: `${field}=${value}`,
      selection: ["matrix", `--${field}`, value],
      expected: { [field]: value },
    })),
  ),
  {
    label: "explicit override",
    selection: ["telegram", "--channel", "matrix", "--name=work"],
    expected: { name: "work" },
  },
])("registers the selected channel's options with $label", async ({ selection, expected }) => {
  const args = ["channels", "add", ...selection, "--homeserver", "https://matrix.example.org"];
  const program = new Command().name("openclaw").exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });

  expect(addCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "matrix",
      homeserver: "https://matrix.example.org",
      ...expected,
    }),
    expect.anything(),
    { hasFlags: true },
  );
});

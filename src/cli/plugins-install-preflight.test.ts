// Invalid plugin install requests must fail before persistent state or source execution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fixture from "./plugins-cli-test-helpers.js";

const { withPluginLifecycleLeaseMock } = vi.hoisted(() => ({
  withPluginLifecycleLeaseMock: vi.fn(),
}));

vi.mock("../plugins/plugin-lifecycle-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lifecycle-lease.js")>()),
  withPluginLifecycleLease: withPluginLifecycleLeaseMock,
  withPluginLifecycleLeaseAsync: withPluginLifecycleLeaseMock,
  hasPluginLifecycleLease: () => false,
}));

const install = (...args: string[]) =>
  fixture.runPluginsCommand(["plugins", "install", ...args, "--force"]);

async function expectRejected(args: string[], error: string) {
  await expect(install(...args)).rejects.toThrow("__exit__:1");
  expect(fixture.runtimeErrors.at(-1)).toContain(error);
  for (const effect of [
    withPluginLifecycleLeaseMock,
    fixture.readConfigFileSnapshotForWriteMock,
    fixture.promptYesNoMock,
    fixture.installPluginFromClawHubMock,
    fixture.installPluginFromGitSpecMock,
    fixture.installPluginFromMarketplaceMock,
    fixture.installPluginFromNpmPackArchiveMock,
    fixture.installPluginFromNpmSpecMock,
    fixture.installPluginFromPathMock,
    fixture.installHooksFromNpmSpecMock,
    fixture.installHooksFromPathMock,
    fixture.configWriteMock,
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
}

describe("plugin install mutation-free preflight", () => {
  beforeEach(() => {
    fixture.resetPluginsCliTestState();
    withPluginLifecycleLeaseMock
      .mockReset()
      .mockImplementation(
        async (_options: unknown, run: (lease: unknown) => Promise<unknown>) =>
          await run({ assertOwned: vi.fn(), assertCurrent: vi.fn() }),
      );
  });

  it("resolves registered marketplace shorthand before ordinary source classification", async () => {
    fixture.resolveMarketplaceInstallShortcutMock.mockResolvedValue({
      ok: true,
      plugin: "superpowers",
      marketplaceSource: "claude-plugins-official",
    });

    await expect(install("superpowers@claude-plugins-official")).rejects.toThrow("__exit__:1");
    expect(fixture.runtimeErrors.at(-1)).toContain("marketplace install failed");

    expect(fixture.installPluginFromMarketplaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "claude-plugins-official",
        plugin: "superpowers",
      }),
    );
    expect(fixture.installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it.each([
    ...[" clawhub:demo@ ", "demo@", "@composio/composio@", "unknown:demo"].map(
      (raw): [string[], string] => [[raw], `Unsupported ClawHub plugin spec: ${raw}`],
    ),
    [["\t"], "Plugin install source must not be empty."],
    [["demo", "--marketplace", ""], "--marketplace requires a non-empty source."],
    [["demo", "--marketplace", "\t"], "--marketplace requires a non-empty source."],
    [
      ["demo", "--marketplace", "local/repo", "--link"],
      "--link is not supported with --marketplace.",
    ],
    [
      ["demo", "--marketplace", "local/repo", "--pin"],
      "--pin is not supported with --marketplace.",
    ],
    [["git:github.com/acme/demo", "--link"], "--link is not supported with git: installs."],
    [["git:github.com/acme/demo", "--pin"], "--pin is not supported with git: installs."],
    [["clawhub:demo", "--pin"], "--pin is only supported with npm registry installs."],
    [
      ["npm-pack:/tmp/openclaw-plugin-preflight-test.tgz", "--pin"],
      "--pin is only supported with npm registry installs.",
    ],
    [[".", "--pin"], "--pin is only supported with npm registry installs."],
    [["npm:demo", "--link"], "--link requires a local path."],
    [["npm:"], "Unsupported npm plugin spec: missing package."],
    [["npm-pack:"], "Unsupported npm-pack plugin spec: missing archive path."],
    [["git:"], "unsupported git: plugin spec: git:"],
    [["file:openclaw-missing-plugin-preflight-test.js"], "Plugin path not found:"],
    [["./openclaw-missing-plugin-preflight-test.tgz"], "Plugin path not found:"],
  ] satisfies [string[], string][])("rejects %j before the lifecycle lease", expectRejected);
});

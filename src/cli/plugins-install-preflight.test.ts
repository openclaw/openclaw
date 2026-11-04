// Invalid plugin install requests must fail before persistent state or source execution.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  it.each([false, true])("resolves a local archive file URL (localhost=%s)", async (localhost) => {
    const archive = path.join(tempDirs.make("plugin-file-url-"), "demo ü #%.tgz");
    fs.writeFileSync(archive, "fixture");
    const url = pathToFileURL(archive);
    if (localhost) {
      url.hostname = "localhost";
    }
    await expect(install(url.href)).rejects.toThrow("__exit__:1");
    expect(fixture.installPluginFromPathMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: archive }),
    );
    expect(fixture.runtimeErrors.at(-1)).toContain("path install disabled in test");
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

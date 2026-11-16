// Invalid plugin install requests must fail before persistent state or source execution.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePluginInstallSourcePlan } from "../plugins/install-source-plan.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  it.skipIf(process.platform === "win32").each([
    { flags: [], mode: {} },
    // A linked install validates in place and records this same path in plugins.load.paths.
    { flags: ["--link"], mode: { dryRun: true } },
  ])(
    "installs the plugin a symlinked parent's `..` leads to, keeping its final link $flags",
    async ({ flags, mode }: { flags: string[]; mode: { dryRun?: boolean } }) => {
      const root = fs.realpathSync(tempDirs.make("plugin-symlink-parent-"));
      fs.mkdirSync(path.join(root, "physical", "nested"), { recursive: true });
      fs.mkdirSync(path.join(root, "physical", "plugin-real"));
      fs.symlinkSync("plugin-real", path.join(root, "physical", "plugin-b"));
      fs.mkdirSync(path.join(root, "plugin-b"));
      fs.symlinkSync(path.join(root, "physical", "nested"), path.join(root, "selected"));

      await expect(install(`${root}/selected/../plugin-b`, ...flags)).rejects.toThrow("__exit__:1");
      expect(fixture.installPluginFromPathMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: path.join(root, "physical", "plugin-b"), ...mode }),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "names the typed path when a folder before `..` is missing",
    async () => {
      const root = fs.realpathSync(tempDirs.make("plugin-missing-parent-"));
      fs.mkdirSync(path.join(root, "plugin-b"));
      await expectRejected(
        [`${root}/missing/../plugin-b`],
        `Plugin path not found: ${root}/missing/../plugin-b (ENOENT`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "plans the local Git repository a symlinked parent's `..` leads to",
    () => {
      const root = fs.realpathSync(tempDirs.make("plugin-git-symlink-parent-"));
      fs.mkdirSync(path.join(root, "physical", "nested"), { recursive: true });
      fs.mkdirSync(path.join(root, "physical", "repo"));
      fs.mkdirSync(path.join(root, "repo"));
      fs.symlinkSync(path.join(root, "physical", "nested"), path.join(root, "selected"));
      // Local Git sources must be relative (`./`, `../` or `~/`).
      const selected = path.relative(process.cwd(), path.join(root, "selected"));

      expect(
        resolvePluginInstallSourcePlan({ raw: `git:${selected}/../repo`, mode: "install" }),
      ).toMatchObject({
        request: {
          source: "git",
          spec: `git:${pathToFileURL(path.join(root, "physical", "repo")).href}`,
        },
      });
    },
  );

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

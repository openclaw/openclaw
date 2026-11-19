import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gatewayServiceCommandUsesRoot } from "../cli/update-cli/update-command-service-plan.js";
import { summarizeGatewayServiceLayout } from "./service-layout.js";
import { standaloneManifestFixture } from "./standalone-manifest.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("summarizeGatewayServiceLayout", () => {
  it("identifies the standalone executable as the entrypoint even when it is named bun", async () => {
    const root = dirs.make("standalone-service-layout-");
    const executable = path.join(root, "bun");
    await fs.writeFile(executable, "");
    await fs.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify(standaloneManifestFixture("aot", "bun", "2026.10.25", "1.4.4")),
    );
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: [executable, "gateway", "--port", "19876"],
      }),
    ).resolves.toHaveProperty("entrypoint", executable);
  });

  it("preserves optional physical fields and lexical source paths on probe failure", async () => {
    vi.spyOn(fs, "realpath").mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    await expect(summarizeGatewayServiceLayout({ programArguments: [] })).resolves.toEqual({
      execStart: "",
    });
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: [],
        sourcePath: "blocked/../gateway.service",
      }),
    ).resolves.toEqual({
      execStart: "",
      sourcePath: "blocked/../gateway.service",
      sourcePathReal: path.resolve("gateway.service"),
      sourceScope: "user",
    });
  });

  it.each<[string[], string]>([
    [["node", "dist/index.js", "gateway", "run"], "dist/index.js"],
    [
      ["node", "--title", "gateway", "dist/index.js", "--profile", "dev", "gateway"],
      "dist/index.js",
    ],
    [["bun", "run", "dist/index.js", "--profile=gateway", "gateway"], "dist/index.js"],
    [["tsx", "watch", "dist/index.js", "--dev", "gateway"], "dist/index.js"],
    [["dist/index.js", "--profile", "dev", "gateway"], "dist/index.js"],
    [["/bin/sh", "bin/gateway.sh", "--profile", "dev", "gateway"], "bin/gateway.sh"],
  ])(
    "resolves a relative entrypoint without mistaking root options for the script: %j",
    async (programArguments, entrypoint) => {
      await expect(
        summarizeGatewayServiceLayout({ programArguments, workingDirectory: "/repo/openclaw" }),
      ).resolves.toHaveProperty("entrypoint", path.join("/repo/openclaw", entrypoint));
    },
  );

  it("resolves Windows service entrypoints with Windows path semantics", async () => {
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node.exe", "dist\\index.js", "gateway", "run"],
        workingDirectory: "C:\\openclaw",
      }),
    ).resolves.toHaveProperty("entrypoint", "C:\\openclaw\\dist\\index.js");
  });

  it("rejects a relative entrypoint without an absolute service working directory", async () => {
    const programArguments = ["node", "dist/index.js", "gateway", "run"];
    for (const workingDirectory of [undefined, "./checkout"]) {
      await expect(
        summarizeGatewayServiceLayout({ programArguments, workingDirectory }),
      ).resolves.not.toHaveProperty("entrypoint");
    }
  });
});

it.each(["stable", "foreign", "pinned", "paired", "different-mount"] as const)(
  "checks the effective launcher against the managed installation (%s)",
  async (layout) => {
    const root = await fs.realpath(dirs.make("openclaw-update-release-owner-"));
    const managedRoot = path.join(root, "openclaw");
    const release = path.join(root, "releases", "selected");
    const foreign = path.join(root, "foreign", "releases", "selected");
    const current = path.join(root, "current");
    const mounted = layout === "paired" || layout === "different-mount";
    for (const packageRoot of [managedRoot, release, foreign, ...(mounted ? [current] : [])]) {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
      await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "gateway");
    }
    if (!mounted) {
      await fs.symlink(layout === "foreign" ? foreign : release, current);
    } else if (layout === "paired") {
      // The Docker proof supplies real bind mounts; this isolates directory identity.
      const selected = await fs.stat(release);
      const stat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation(async (target) =>
        path.resolve(String(target)) === current ? selected : stat(target),
      );
    }
    const commandAt = (dir: string) => ({
      programArguments: [process.execPath, path.join(dir, "dist", "index.js"), "gateway"],
    });
    const command = {
      ...commandAt(layout === "pinned" ? release : current),
      managedDefinition: commandAt(managedRoot),
    };
    await expect(gatewayServiceCommandUsesRoot({ root: managedRoot, command })).resolves.toBe(
      layout === "stable" || layout === "paired",
    );
    await expect(
      gatewayServiceCommandUsesRoot({ root: managedRoot, command: command.managedDefinition }),
    ).resolves.toBe(true);
  },
);

it.each([
  "own checkout",
  "other checkout",
  "copied release",
  "release outside its prefix",
] as const)(
  "owns a Git release-mode service only for a release worktree of its checkout (%s)",
  async (release) => {
    const root = await fs.realpath(dirs.make("openclaw-git-release-owner-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@invalid",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        // Host Git configuration and hooks must not shape the fixture.
        {
          cwd,
          stdio: "ignore",
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        },
      );
    const createCheckout = async (dir: string) => {
      await fs.mkdir(path.join(dir, "dist"), { recursive: true });
      await fs.writeFile(path.join(dir, "package.json"), '{"name":"openclaw"}');
      await fs.writeFile(path.join(dir, "dist", "index.js"), "gateway");
      git(dir, "init", "-q");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "fixture");
    };
    const checkout = path.join(root, "checkout");
    const other = path.join(root, "other");
    await createCheckout(checkout);
    await createCheckout(other);
    const prefix = path.join(root, "state", "git-install");
    const releaseRoot =
      release === "release outside its prefix"
        ? path.join(root, "elsewhere", "releases", "r1", "openclaw")
        : path.join(prefix, "releases", "r1", "lib", "node_modules", "openclaw");
    await fs.mkdir(path.dirname(releaseRoot), { recursive: true });
    if (release === "copied release") {
      // A copy keeps the `.git` file, but Git's registration still names the original.
      const registered = path.join(root, "registered");
      git(checkout, "worktree", "add", "-q", "--detach", registered);
      await fs.cp(registered, releaseRoot, { recursive: true });
    } else {
      const owner = release === "other checkout" ? other : checkout;
      git(owner, "worktree", "add", "-q", "--detach", releaseRoot);
    }
    const slot = path.join(prefix, "lib", "node_modules", "openclaw");
    await fs.mkdir(path.dirname(slot), { recursive: true });
    await fs.symlink(path.relative(path.dirname(slot), releaseRoot), slot);
    // The installed unit starts the launcher written beside the release link.
    const launcher = path.join(prefix, "openclaw-launcher.mjs");
    const command = { programArguments: [process.execPath, launcher, "gateway"] };

    await expect(gatewayServiceCommandUsesRoot({ root: checkout, command })).resolves.toBe(
      release === "own checkout",
    );
    // Without the launcher, a service of the release files is not this checkout's.
    const direct = [process.execPath, path.join(slot, "dist", "index.js"), "gateway"];
    await expect(
      gatewayServiceCommandUsesRoot({ root: checkout, command: { programArguments: direct } }),
    ).resolves.toBe(false);
  },
);

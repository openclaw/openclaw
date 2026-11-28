import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { irohNativeBinaryName, irohNativeBuildInputs } from "../infra/iroh-native-build.js";
import { prepareGit } from "./prepare-git.js";
import { node, repository, root } from "./prepare.test-support.js";

const exec = promisify(execFile);

export const irohCrate = path.join("crates", "openclaw-iroh-node");
export const irohBinary = irohNativeBinaryName();

export async function irohRepository(
  opts: {
    artifact?: "checkout" | "running" | "both" | "foreign";
    changed?: boolean;
    build?: "missing" | "failure" | "no-output";
    checkoutDrift?: "dirty" | "pulled";
  } = {},
) {
  const { checkout, source } = await repository();
  const bare = path.join(root, "remote.git");
  const crate = path.join(source, irohCrate);
  const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, ...args]);
  const publish = async (message: string) => {
    await git(source, "add", ".");
    await git(source, "commit", "-m", message);
    await git(source, "push", bare, "HEAD:main");
    return (await git(source, "rev-parse", "HEAD")).stdout.trim();
  };
  await fs.mkdir(path.join(crate, "src"), { recursive: true });
  await fs.writeFile(path.join(crate, "Cargo.toml"), "native-v1\n");
  await fs.writeFile(path.join(crate, ".gitignore"), "*.node\n");
  for (const input of [
    "Cargo.lock",
    "build.rs",
    "package.json",
    "rust-toolchain.toml",
    "src/lib.rs",
  ]) {
    await fs.writeFile(path.join(crate, input), "fixture\n");
  }
  const manifestPath = path.join(source, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.scripts["build:iroh"] = "node build-iroh.cjs";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(
    path.join(source, "build-iroh.cjs"),
    opts.build === "failure"
      ? "console.error('fixture cargo missing'); process.exit(42);"
      : opts.build === "no-output"
        ? ""
        : "const fs = require('node:fs');" +
          "if (process.env.RUSTUP_TOOLCHAIN) throw new Error('inherited toolchain override');" +
          "fs.copyFileSync(" +
          JSON.stringify(path.join(irohCrate, "Cargo.toml")) +
          "," +
          JSON.stringify(path.join(irohCrate, irohBinary)) +
          ");",
  );
  const base = await publish("add native crate fixture");
  await git(checkout, "pull", "--ff-only");
  const writeArtifact = async (repositoryRoot: string, contents: string) => {
    const artifactCrate = path.join(repositoryRoot, irohCrate);
    const binary = path.join(artifactCrate, irohBinary);
    await fs.writeFile(binary, contents);
    // Keep builds strictly newer even on coarse clocks, and older than later source edits.
    for (const input of [...irohNativeBuildInputs, "src/lib.rs"]) {
      await fs.utimes(path.join(artifactCrate, input), 100, 100);
    }
    await fs.utimes(binary, 200, 200);
  };
  let runningRoot = checkout;
  if (opts.artifact === "running" || opts.artifact === "both") {
    runningRoot = path.join(root, "running");
    await git(checkout, "worktree", "add", "--detach", runningRoot, base);
    await writeArtifact(runningRoot, "running bytes");
  }
  if (opts.artifact === "checkout" || opts.artifact === "both") {
    await writeArtifact(checkout, "checkout bytes");
  } else if (opts.artifact === "foreign") {
    await fs.writeFile(
      path.join(checkout, irohCrate, "iroh-node.android-arm-eabi.node"),
      "foreign",
    );
  }
  if (opts.changed) {
    await fs.writeFile(path.join(crate, "Cargo.toml"), "native-v2\n");
  }
  if (opts.build === "missing") {
    delete manifest.scripts["build:iroh"];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
  }
  await fs.writeFile(path.join(source, "next-release.txt"), "target\n");
  const sha = await publish("prepare a successor release");
  if (opts.checkoutDrift === "pulled") {
    await git(checkout, "pull", "--ff-only");
  } else if (opts.checkoutDrift === "dirty") {
    // This binary is newer than the dirty input, but still cannot match the target tree.
    await fs.writeFile(path.join(checkout, irohCrate, "Cargo.toml"), "locally modified\n");
    await fs.utimes(path.join(checkout, irohCrate, "Cargo.toml"), 300, 300);
    await fs.writeFile(path.join(checkout, irohCrate, irohBinary), "dirty build bytes");
    await fs.utimes(path.join(checkout, irohCrate, irohBinary), 400, 400);
  }
  const staging = path.join(root, "staging");
  const release = path.join(staging, "openclaw");
  return { checkout, runningRoot, sha, staging, release, node, timeoutMs: 30_000 };
}

export function registerIrohPreparationTests() {
  it.each([undefined, "foreign"] as const)("does not opt in with artifact %s", async (artifact) => {
    const target = await irohRepository({ artifact, changed: true });
    expect(await prepareGit(target)).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(target.release, "steps.txt"), "utf8")).toBe(
      "install --frozen-lockfile\nbuild\n",
    );
    await expect(fs.access(path.join(target.release, irohCrate, irohBinary))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("rebuilds changed native sources in the release with its pinned toolchain", async () => {
    vi.stubEnv("RUSTUP_TOOLCHAIN", "fixture-override");
    const target = await irohRepository({ artifact: "running", changed: true });
    expect(await prepareGit(target)).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(target.release, irohCrate, irohBinary), "utf8")).toBe(
      "native-v2\n",
    );
    expect(await fs.readFile(path.join(target.release, "steps.txt"), "utf8")).toContain(
      "build:iroh",
    );
    expect(await fs.readFile(path.join(target.runningRoot, irohCrate, irohBinary), "utf8")).toBe(
      "running bytes",
    );
  });

  it.each(["pulled", "dirty"] as const)(
    "rebuilds after %s checkout drift",
    async (checkoutDrift) => {
      vi.stubEnv("RUSTUP_TOOLCHAIN", undefined);
      const target = await irohRepository({
        artifact: "checkout",
        changed: checkoutDrift === "pulled",
        checkoutDrift,
      });
      expect(await prepareGit(target)).toMatchObject({ ok: true });
      expect(await fs.readFile(path.join(target.release, irohCrate, irohBinary), "utf8")).toBe(
        checkoutDrift === "pulled" ? "native-v2\n" : "native-v1\n",
      );
    },
  );

  it.each([
    ["missing", "does not define"],
    ["failure", "fixture cargo missing"],
    ["no-output", "did not produce"],
  ] as const)("fails before activation when the native build is %s", async (build, detail) => {
    const target = await irohRepository({ artifact: "running", changed: true, build });
    expect(await prepareGit(target)).toMatchObject({
      ok: false,
      reason: "build:iroh-failed",
      stderrTail: expect.stringContaining(detail),
    });
    expect(await fs.readFile(path.join(target.runningRoot, irohCrate, irohBinary), "utf8")).toBe(
      "running bytes",
    );
  });
}

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { snapshotNodeWorkerEnv } from "../../node-host/node-worker-environment.js";
import { DEFAULT_NODE_TOOLCHAIN_SETUP_SH, NODE_TOOLCHAIN_INSTALL_SH } from "./node-toolchain.js";
import { resolveRepositoryNodeRequirement } from "./repository-node-requirement.js";
import { PREPARE_REPOSITORY_NODE_JS } from "./repository-node-toolchain.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const requireModule = createRequire(import.meta.url);

function fixture(
  tools: Record<string, string> = Object.fromEntries(
    ["node", "npm", "npx", "corepack"].map((name) => [name, "#!/bin/sh\necho v22.21.1\n"]),
  ),
) {
  const root = tempDirs.make("node-toolchain-");
  const bin = path.join(root, "bin");
  const release = path.join(root, "release");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(release, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; *) echo x86_64;; esac\n',
    { mode: 0o755 },
  );
  for (const [name, script] of Object.entries(tools)) {
    fs.writeFileSync(path.join(release, "bin", name), script, { mode: 0o755 });
  }
  const archive = path.join(root, "release.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "release"]);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  fs.writeFileSync(
    path.join(bin, "curl"),
    '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp "$(dirname "$0")/../release.tgz" "$2"\n',
    { mode: 0o755 },
  );
  return {
    root,
    bin,
    archive,
    digest,
    env: {
      ...process.env,
      HOME: root,
      PATH: bin + path.delimiter + process.env.PATH,
      FIXTURE_ARCHIVE: archive,
    },
  };
}

function prepareRepositoryNode(
  f: ReturnType<typeof fixture>,
  releases: string[],
  fetchUrls: string[] = [],
): (workspaceDir: string, homeDir: string, machineHome: string) => Promise<string> {
  return runInNewContext(`(${PREPARE_REPOSITORY_NODE_JS})`, {
    require: requireModule,
    process: { platform: "linux", arch: "x64", execPath: process.execPath, env: f.env },
    AbortSignal,
    fetch: async (url: string) => {
      fetchUrls.push(url);
      return {
        ok: true,
        text: async () =>
          url.endsWith("index.json")
            ? JSON.stringify(
                releases.map((release) => ({ version: `v${release}`, files: ["linux-x64"] })),
              )
            : `${f.digest}  node-${url.split("/")[4]}-linux-x64.tar.gz\n`,
      };
    },
  });
}

/**
 * Mirrors a system-packaged Corepack: read-only files, env-node entry stubs, and an enable that
 * links shims into the running package's dist.
 */
function workerCorepack(root: string) {
  const corepack = path.join(root, "worker", "lib", "node_modules", "corepack");
  fs.mkdirSync(path.join(corepack, "dist", "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(corepack, "package.json"),
    JSON.stringify({
      name: "corepack",
      engines: { node: "^22.22.2 || ^24.15.0 || >=26.0.0" },
      exports: { "./package.json": "./package.json" },
    }),
    { mode: 0o444 },
  );
  fs.writeFileSync(
    path.join(corepack, "dist", "lib", "corepack.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
exports.runMain = ([command, ...args]) => {
  if (command !== "enable") {
    console.log(JSON.stringify({ node: process.env.FIXTURE_NODE ?? "worker", argv: [command, ...args] }));
    return;
  }
  const directory = fs.realpathSync(args[args.indexOf("--install-directory") + 1]);
  const dist = path.join(path.dirname(require.resolve("corepack/package.json")), "dist");
  fs.rmSync(path.join(directory, "pnpm"), { force: true });
  fs.symlinkSync(path.relative(directory, path.join(dist, "pnpm.js")), path.join(directory, "pnpm"));
};
`,
    { mode: 0o444 },
  );
  for (const [name, argv] of [
    ["corepack", "process.argv.slice(2)"],
    ["pnpm", '["pnpm", ...process.argv.slice(2)]'],
  ]) {
    fs.writeFileSync(
      path.join(corepack, "dist", `${name}.js`),
      `#!/usr/bin/env node\nrequire("./lib/corepack.cjs").runMain(${argv});\n`,
      { mode: 0o555 },
    );
  }
  const bin = path.join(root, "worker", "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync("../lib/node_modules/corepack/dist/corepack.js", path.join(bin, "corepack"));
  return bin;
}

describe("cloud Node toolchain preparation", () => {
  it("installs verified bytes, reuses them offline, and repairs a damaged installation", () => {
    const f = fixture();
    const script =
      NODE_TOOLCHAIN_INSTALL_SH + '\nopenclaw_install_node "22.21.1" "$FIXTURE_DIGEST"\n';
    const install = () =>
      execFileSync("sh", ["-s"], {
        input: script,
        env: { ...f.env, FIXTURE_DIGEST: f.digest },
        encoding: "utf8",
      }).trim();
    const bin = install();
    expect(execFileSync(path.join(bin, "node"), ["--version"], { encoding: "utf8" }).trim()).toBe(
      "v22.21.1",
    );
    fs.writeFileSync(path.join(f.bin, "curl"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    expect(install()).toBe(bin);
    fs.appendFileSync(path.join(bin, "node"), "# changed\n");
    expect(() => install()).toThrow(/allow HTTPS access to nodejs.org and retry preparation/);
    fs.writeFileSync(
      path.join(f.bin, "curl"),
      '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp "$(dirname "$0")/../release.tgz" "$2"\n',
      { mode: 0o755 },
    );
    expect(install()).toBe(bin);
  });

  it("rejects a default-release archive whose digest differs from the source pin", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = spawnSync("sh", ["-s"], {
      input: DEFAULT_NODE_TOOLCHAIN_SETUP_SH,
      env: f.env,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "SHA-256 verification failed; check the download proxy and retry preparation",
    );
    expect(fs.readdirSync(path.join(f.root, ".openclaw-worker", "toolchains", "node"))).toEqual([]);
  });

  it("selects the latest matching repository release and gives session commands its PATH", async () => {
    const f = fixture();
    const workspace = path.join(f.root, "workspace");
    const home = path.join(f.root, "session-home");
    fs.mkdirSync(workspace);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22\n");
    const fetchUrls: string[] = [];
    const setupPath = await prepareRepositoryNode(f, ["24.21.0", "22.20.0", "22.21.1"], fetchUrls)(
      workspace,
      home,
      f.root,
    );
    expect(fetchUrls).toEqual([
      "https://nodejs.org/dist/index.json",
      "https://nodejs.org/dist/v22.21.1/SHASUMS256.txt",
    ]);
    expect(
      execFileSync("node", ["--version"], { env: { PATH: setupPath }, encoding: "utf8" }).trim(),
    ).toBe("v22.21.1");
    expect(process.execPath).not.toBe(fs.realpathSync(path.join(home, ".local", "bin", "node")));
    const session = snapshotNodeWorkerEnv({ PATH: "/runtime/bin" }, home);
    expect(session.HOME).toBe(home);
    if (process.platform === "linux") {
      expect(session.PATH).toBe(path.join(home, ".local", "bin") + ":/runtime/bin");
    }
  });

  it.each([
    ["16.8.0", "worker"],
    ["26.1.0", "repository"],
  ])(
    "runs worker Corepack for repository Node %s under a Node its engines accept",
    async (version, runner) => {
      const f = fixture({
        node: `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; else FIXTURE_NODE=repository exec '${process.execPath}' "$@"; fi\n`,
        npm: `#!/bin/sh\necho ${version}\n`,
        npx: `#!/bin/sh\necho ${version}\n`,
      });
      const corepackBin = workerCorepack(f.root);
      f.env.PATH = corepackBin + path.delimiter + f.env.PATH;
      vi.stubEnv("PATH", corepackBin + path.delimiter + process.env.PATH);
      const workspace = path.join(f.root, "workspace");
      const home = path.join(f.root, "session-home");
      fs.mkdirSync(workspace);
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(workspace, ".nvmrc"), `${version}\n`);
      fs.writeFileSync(path.join(workspace, "package.json"), '{"packageManager":"pnpm@10.11.0"}');
      const prepare = prepareRepositoryNode(f, [version]);
      await prepare(workspace, home, f.root);
      // A commit refresh prepares the same HOME again; detected installs then re-enable Corepack.
      const setupPath = await prepare(workspace, home, f.root);
      const run = (command: string) =>
        execFileSync("sh", ["-c", command], {
          env: { PATH: setupPath, HOME: home },
          encoding: "utf8",
        });
      expect(run("node --version").trim()).toBe(`v${version}`);
      expect(
        JSON.parse(run('corepack enable --install-directory "$HOME/.local/bin" && pnpm --version')),
      ).toEqual({ node: runner, argv: ["pnpm", "--version"] });
    },
  );
});

describe("repository Node declarations", () => {
  it.each([
    [{ ".nvmrc": "# Node version\nv22.21.1 # pinned", ".node-version": "24" }, "v22.21.1"],
    [{ ".node-version": "22.21\n" }, "22.21"],
    [{ ".tool-versions": "python 3.13\nnodejs 22.21.1\n" }, "22.21.1"],
    [{ "mise.toml": '[tools] # versions\nnode = "lts/*"\n[env]\nnode = "other"' }, "lts/*"],
    [{ "package.json": '{"engines":{"node":">=20 <23"}}' }, ">=20 <23"],
    [{ "package.json": '{"engines":{"node":22}}' }, undefined],
  ])("resolves checkout declarations", (files, expected) => {
    expect(resolveRepositoryNodeRequirement(files)).toBe(expected);
  });
});

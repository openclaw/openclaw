import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { snapshotNodeWorkerEnv } from "../../node-host/node-worker-environment.js";
import {
  DEFAULT_NODE_TOOLCHAIN_SETUP_SH,
  BUNDLE_NODE_TOOLCHAIN_SETUP_SH,
  NODE_TOOLCHAIN_INSTALL_SH,
} from "./node-toolchain.js";
import { createProjectSeedScript } from "./project-seed-script.js";
import { createProjectSetupScript } from "./project-setup-script.js";
import { REPOSITORY_NODE_REQUIREMENT_SOURCE } from "./repository-node-requirement.generated.js";
import { resolveRepositoryNodeRequirement } from "./repository-node-requirement.js";
import { PREPARE_REPOSITORY_NODE_JS } from "./repository-node-toolchain.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const requireModule = createRequire(import.meta.url);
const resolveBuiltNodeRequirement: typeof resolveRepositoryNodeRequirement = runInNewContext(
  REPOSITORY_NODE_REQUIREMENT_SOURCE,
  {},
  { contextCodeGeneration: { strings: false, wasm: false } },
);
const downloadScript =
  '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp "$(dirname "$0")/../release.tgz" "$2"\n';
const write = (file: string, text: string, mode = 0o755) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};
const run = (file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) =>
  execFileSync(file, args, { env, input, encoding: "utf8" }).trim();

function fixture(
  tools: Record<string, string> = Object.fromEntries(
    ["node", "npm", "npx", "corepack"].map((name) => [name, "#!/bin/sh\necho v22.21.1\n"]),
  ),
) {
  const root = tempDirs.make("node-toolchain-");
  const bin = path.join(root, "bin");
  const release = path.join(root, "release");
  write(
    path.join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; *) echo x86_64;; esac\n',
  );
  for (const [name, script] of Object.entries(tools)) {
    write(path.join(release, "bin", name), script);
  }
  const archive = path.join(root, "release.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "release"]);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  write(path.join(bin, "curl"), downloadScript);
  const env = { ...process.env, HOME: root, PATH: bin + path.delimiter + process.env.PATH };
  const home = path.join(root, "session-home");
  function checkout(
    version: string,
    releases: string[],
    packageManager?: string,
    fetchUrls: string[] = [],
  ) {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(home);
    write(path.join(workspace, ".nvmrc"), version);
    if (packageManager) {
      write(path.join(workspace, "package.json"), JSON.stringify({ packageManager }));
    }
    const index = JSON.stringify(
      releases.map((releaseVersion) => ({ version: `v${releaseVersion}`, files: ["linux-x64"] })),
    );
    const install: (workspace: string, home: string, root: string) => Promise<string> =
      runInNewContext(`(${PREPARE_REPOSITORY_NODE_JS})`, {
        require: requireModule,
        process: { platform: "linux", arch: "x64", execPath: process.execPath, env },
        AbortSignal,
        fetch: async (url: string) => {
          fetchUrls.push(url);
          return new Response(
            url.endsWith("index.json")
              ? index
              : `${digest}  node-${url.split("/")[4]}-linux-x64.tar.gz\n`,
          );
        },
      });
    return () => install(workspace, home, root);
  }
  return { root, bin, digest, env, home, checkout };
}

// System Corepack: read-only package, env-node stubs, enable links into its own dist.
function workerCorepack(root: string) {
  const corepack = path.join(root, "worker", "lib", "node_modules", "corepack");
  const file = (name: string, text: string, mode = 0o444) =>
    write(path.join(corepack, name), text, mode);
  file(
    "package.json",
    '{"name":"corepack","engines":{"node":"^22.22.2 || ^24.15.0 || >=26.0.0"},"exports":{"./package.json":"./package.json"}}',
  );
  file(
    "dist/lib/corepack.cjs",
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
  );
  for (const [name, argv] of [
    ["corepack", "process.argv.slice(2)"],
    ["pnpm", '["pnpm", ...process.argv.slice(2)]'],
  ]) {
    file(
      `dist/${name}.js`,
      `#!/usr/bin/env node\nrequire("./lib/corepack.cjs").runMain(${argv});\n`,
      0o555,
    );
  }
  const bin = path.join(root, "worker", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync("../lib/node_modules/corepack/dist/corepack.js", path.join(bin, "corepack"));
  return bin;
}

it("installs verified bytes, reuses them offline, and repairs a damaged installation", () => {
  const f = fixture();
  const script = `${NODE_TOOLCHAIN_INSTALL_SH}\nopenclaw_install_node "22.21.1" "${f.digest}"\n`;
  const install = () => run("sh", ["-s"], f.env, script);
  const bin = install();
  expect(run(path.join(bin, "node"), ["--version"], process.env)).toBe("v22.21.1");
  write(path.join(f.bin, "curl"), "#!/bin/sh\nexit 99\n");
  expect(install()).toBe(bin);
  fs.appendFileSync(path.join(bin, "node"), "# changed\n");
  expect(() => install()).toThrow(/allow HTTPS access to nodejs.org and retry preparation/);
  write(path.join(f.bin, "curl"), downloadScript);
  expect(install()).toBe(bin);
});

it.each(["npm", "corepack"])(
  "keeps bundle bootstrap offline but repairs missing %s for repository preparation",
  (missing) => {
    const f = fixture();
    fs.symlinkSync(process.execPath, path.join(f.bin, "node"));
    for (const name of ["wc", "tr", "mkdir", "mktemp", "rm", "tar", "sha256sum"]) {
      const executable = resolveExecutablePath(name, {
        env: process.env,
        cwd: process.cwd(),
        useCache: false,
      });
      expect(executable, `fixture tool ${name}`).toBeDefined();
      fs.symlinkSync(executable!, path.join(f.bin, name));
    }
    write(
      path.join(f.bin, "curl"),
      '#!/bin/sh\nprintf attempted > "$HOME/download-attempt"\nexit 17\n',
    );
    if (missing === "corepack") {
      for (const name of ["npm", "npx"]) {
        write(path.join(f.bin, name), "#!/bin/sh\nexit 0\n");
      }
    }
    const env = { ...f.env, PATH: f.bin };
    expect(run("/bin/sh", ["-s"], env, BUNDLE_NODE_TOOLCHAIN_SETUP_SH)).toBe("");
    expect(fs.existsSync(path.join(f.root, "download-attempt"))).toBe(false);
    const input = {
      namespace: "gateway",
      seedKey: "a".repeat(64),
      baseCommit: "b".repeat(40),
      preparationKey: "c".repeat(64),
      cacheKey: "d".repeat(64),
    };
    for (const script of [
      DEFAULT_NODE_TOOLCHAIN_SETUP_SH,
      createProjectSeedScript(input),
      createProjectSetupScript(input),
    ]) {
      fs.rmSync(path.join(f.root, "download-attempt"), { force: true });
      expect(() => run("/bin/sh", ["-s"], env, script)).toThrow(/allow HTTPS access/);
      expect(fs.readFileSync(path.join(f.root, "download-attempt"), "utf8")).toBe("attempted");
    }
  },
);

it("rejects a default-release archive whose digest differs from the source pin", () => {
  const f = fixture();
  write(path.join(f.bin, "node"), "#!/bin/sh\nexit 1\n");
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

it("resolves a repository .nvmrc=24 declaration and gives session commands its PATH", async () => {
  const f = fixture(
    Object.fromEntries(
      ["node", "npm", "npx", "corepack"].map((name) => [name, "#!/bin/sh\necho v24.22.1\n"]),
    ),
  );
  const fetchUrls: string[] = [];
  const { home } = f;
  const prepare = f.checkout("24\n", ["26.12.1", "24.21.0", "24.22.1"], undefined, fetchUrls);
  const setupPath = await prepare();
  expect(fetchUrls).toEqual([
    "https://nodejs.org/dist/index.json",
    "https://nodejs.org/dist/v24.22.1/SHASUMS256.txt",
  ]);
  expect(run("node", ["--version"], { PATH: setupPath })).toBe("v24.22.1");
  expect(process.execPath).not.toBe(fs.realpathSync(path.join(home, ".local", "bin", "node")));
  const session = snapshotNodeWorkerEnv({ PATH: "/runtime/bin" }, home);
  expect(session.HOME).toBe(home);
  if (process.platform === "linux") {
    expect(session.PATH).toBe(path.join(home, ".local", "bin") + ":/runtime/bin");
  }
});

it.each([
  ["16.8.0", "worker"],
  ["26.12.1", "repository"],
])(
  "runs worker Corepack for repository Node %s under a Node its engines accept",
  async (version, runner) => {
    const f = fixture({
      node: `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; else FIXTURE_NODE=repository exec '${process.execPath}' "$@"; fi\n`,
      npm: `#!/bin/sh\necho ${version}\n`,
      npx: `#!/bin/sh\necho ${version}\n`,
    });
    const corepackBin = workerCorepack(f.root);
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside, { mode: 0o755 });
    write(path.join(outside, "keep.txt"), "outside copy", 0o644);
    fs.chmodSync(outside, 0o755);
    fs.chmodSync(path.join(outside, "keep.txt"), 0o644);
    const source = path.join(f.root, "worker/lib/node_modules/corepack");
    fs.mkdirSync(path.join(source, "readonly"), { mode: 0o555 });
    fs.chmodSync(path.join(source, "readonly"), 0o555);
    fs.symlinkSync(outside, path.join(source, "external-directory"), "dir");
    fs.symlinkSync(path.join(outside, "keep.txt"), path.join(source, "external-file"), "file");
    f.env.PATH = corepackBin + path.delimiter + f.env.PATH;
    vi.stubEnv("PATH", corepackBin + path.delimiter + process.env.PATH);
    const { home } = f;
    const prepare = f.checkout(`${version}\n`, [version], "pnpm@10.11.0");
    await prepare();
    // A commit refresh prepares the same HOME again; detected installs then re-enable Corepack.
    const setupPath = await prepare();
    if (runner === "worker") {
      expect(
        fs.statSync(path.join(home, ".local/lib/openclaw-corepack/readonly")).mode & 0o777,
      ).toBe(0o700);
    }
    expect(fs.statSync(path.join(source, "readonly")).mode & 0o777).toBe(0o555);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(outside, "keep.txt")).mode & 0o777).toBe(0o644);
    const shell = (command: string) => run("sh", ["-c", command], { PATH: setupPath, HOME: home });
    expect(shell("node --version")).toBe(`v${version}`);
    expect(
      JSON.parse(shell('corepack enable --install-directory "$HOME/.local/bin" && pnpm --version')),
    ).toEqual({ node: runner, argv: ["pnpm", "--version"] });
  },
);
it.each([
  [{ ".nvmrc": "# Node version\nv22.21.1 # pinned", ".node-version": "24" }, "v22.21.1"],
  [{ ".node-version": "22.21\n" }, "22.21"],
  [{ ".tool-versions": "python 3.13\nnodejs 22.21.1\n" }, "22.21.1"],
  [{ "mise.toml": '[tools] # versions\nnode = "lts/*"\n[env]\nnode = "other"' }, "lts/*"],
  [{ "package.json": '{"engines":{"node":">=20 <23"}}' }, ">=20 <23"],
  [{ "package.json": '{"engines":{"node":22}}' }, undefined],
])("resolves checkout declarations", (files, expected) => {
  expect(resolveRepositoryNodeRequirement(files)).toBe(expected);
  expect(resolveBuiltNodeRequirement(files)).toBe(expected);
});

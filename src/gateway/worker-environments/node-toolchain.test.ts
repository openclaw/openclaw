import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { snapshotNodeWorkerEnv } from "../../node-host/node-worker-environment.js";
import { DEFAULT_NODE_TOOLCHAIN_SETUP_SH, NODE_TOOLCHAIN_INSTALL_SH } from "./node-toolchain.js";
import { resolveRepositoryNodeRequirement } from "./repository-node-requirement.js";
import { PREPARE_REPOSITORY_NODE_JS } from "./repository-node-toolchain.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const requireModule = createRequire(import.meta.url);

function fixture() {
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
  for (const name of ["node", "npm", "npx", "corepack"]) {
    fs.writeFileSync(path.join(release, "bin", name), "#!/bin/sh\necho v22.21.1\n", {
      mode: 0o755,
    });
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
    const prepare = runInNewContext(`(${PREPARE_REPOSITORY_NODE_JS})`, {
      require: requireModule,
      process: { platform: "linux", arch: "x64", execPath: process.execPath, env: f.env },
      AbortSignal,
      fetch: async (url: string) => {
        fetchUrls.push(url);
        return {
          ok: true,
          text: async () =>
            url.endsWith("index.json")
              ? JSON.stringify([
                  { version: "v24.21.0", files: ["linux-x64"] },
                  { version: "v22.20.0", files: ["linux-x64"] },
                  { version: "v22.21.1", files: ["linux-x64"] },
                ])
              : f.digest + "  node-v22.21.1-linux-x64.tar.gz\n",
        };
      },
    });
    const setupPath: string = await prepare(workspace, home, f.root);
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

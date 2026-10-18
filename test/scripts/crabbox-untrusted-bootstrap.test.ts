import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCrabboxGateTransport } from "../../scripts/pr-lib/crabbox-gate-transport.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const source = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
const historicalPnpmSpec =
  "pnpm@12.1.0+sha512.d9b8276d97f6ec86e49815877f91ee9f63cee61f2063b304e43b6dab8fa07ce8a9afd46d2facd39f921e6a9d06b3c75a81349c7b888c2d22886bae0229901037";
const roots = useAutoCleanupTempDirTracker(afterEach);

function executable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = roots.make("bootstrap-image-");
  const bin = join(root, "bin");
  const image = join(root, "image");
  const origin = join(root, "origin");
  const install = join(root, "install");
  const corepack = join(root, "corepack");
  const stage = join(root, "stage");
  for (const directory of [bin, image, origin, stage]) {
    mkdirSync(directory);
  }
  const nodeStage = join(stage, "node");
  mkdirSync(join(nodeStage, "bin"), { recursive: true });
  executable(
    join(nodeStage, "bin", "node"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  );
  executable(
    join(nodeStage, "bin", "corepack"),
    `#!/bin/bash
set -eu
echo "$1" >> ${JSON.stringify(join(root, "corepack-log"))}
case "$1" in
  enable)
    ln -s corepack "$3/pnpm"
    ln -s corepack "$3/pnpx"
    ;;
  prepare)
    printf '%s\\n' "$2" "$PWD" > ${JSON.stringify(join(root, "prepared-pin"))}
    version="\${2#pnpm@}"
    version="\${version%%+*}"
    if [[ ! -f "$COREPACK_HOME/v1/pnpm/$version/.corepack" ]]; then
      echo pnpm-download >> ${JSON.stringify(join(root, "downloads"))}
    fi
    ;;
  install)
    [[ "$2" == "--frozen-lockfile" ]]
    printf '%s' "$HOME" > ${JSON.stringify(join(root, "install-home"))}
    read -r prepared_pin < ${JSON.stringify(join(root, "prepared-pin"))}
    candidate_pin="$(${JSON.stringify(process.execPath)} -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager')"
    [[ "$prepared_pin" == "$candidate_pin" ]]
    echo frozen >> ${JSON.stringify(join(root, "install-log"))}
    ;;
  *) ;;
esac
`,
  );
  for (const name of ["wrapper", "native"]) {
    mkdirSync(join(stage, name));
  }
  function archive(directory: string, name: string, algorithm: string) {
    const output = join(origin, name);
    execFileSync("tar", [name.endsWith(".xz") ? "-cJf" : "-czf", output, "-C", stage, directory]);
    const bytes = readFileSync(output);
    writeFileSync(join(image, name), bytes);
    return createHash(algorithm).update(bytes).digest("hex");
  }
  const hashes = {
    node: archive("node", "node-v24.21.0-linux-x64.tar.xz", "sha256"),
    wrapper: archive("wrapper", "pnpm-12.11.1.tgz", "sha512"),
    native: archive("native", "exe.linux-x64-12.11.1.tgz", "sha512"),
  };
  const productionSpec = source.match(/^pnpm_spec="([^"]+)"$/mu)?.[1] ?? "";
  const spec = `${productionSpec.split("+")[0]}+sha512.${hashes.wrapper}`;
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: spec }));
  executable(
    join(bin, "curl"),
    `#!/bin/bash
set -eu
case "$*" in
  *latest/api/token*) echo fixture-token; exit ;;
  *security-credentials/*) echo "\${FIXTURE_IAM_STATUS:-404}"; exit ;;
esac
echo node-download >> ${JSON.stringify(join(root, "downloads"))}
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    cp ${JSON.stringify(join(origin, "node-v24.21.0-linux-x64.tar.xz"))} "$2"
    exit
  fi
  shift
done
exit 1
`,
  );
  executable(join(bin, "git"), "#!/bin/sh\necho aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  executable(join(bin, "uname"), "#!/bin/sh\necho x86_64\n");
  executable(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n');
  for (const algorithm of [256, 512]) {
    executable(join(bin, `sha${algorithm}sum`), `#!/bin/sh\nexec shasum -a ${algorithm} "$@"\n`);
  }
  let script = source
    .replaceAll("/usr/bin/curl", join(bin, "curl"))
    .replaceAll("/usr/bin/git", join(bin, "git"))
    .replaceAll("/usr/bin/uname", join(bin, "uname"))
    .replaceAll("/usr/bin/sha", join(bin, "sha"))
    .replaceAll("/usr/bin/mkdir", "/bin/mkdir")
    .replaceAll("/usr/bin/ln", "/bin/ln")
    .replaceAll("/usr/local/bin", bin)
    .replaceAll("sudo ", `${JSON.stringify(join(bin, "sudo"))} `)
    .replace(
      'install_root="/opt/openclaw-untrusted-node-v${node_version}-${node_arch}"',
      `install_root="${install}"`,
    )
    .replaceAll("/opt/openclaw-untrusted-corepack", corepack)
    .replaceAll("/opt/crabbox/toolchain-archives", image);
  // Only the trusted fixture's anchors change; candidate/image state never supplies them.
  script = script
    .replace(productionSpec, spec)
    .replaceAll("fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6", hashes.node)
    .replaceAll(
      "73b921d30b63834e629f6c249a7e9faecfed722b9a1b0f1735952e82047cf26bd4be627cd63b023f532933ce704c5129b5d781e0e9e5446d0449465bbb8f6af1",
      hashes.native,
    );
  const scriptPath = join(root, "bootstrap.sh");
  writeFileSync(scriptPath, script);
  const read = (name: string) => readFileSync(join(root, name), "utf8");
  const exists = (name: string) => existsSync(join(root, name));
  return {
    read,
    exists,
    root,
    image,
    origin,
    install,
    corepack,
    spec,
    run(extraEnv: NodeJS.ProcessEnv = {}, head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
      return spawnSync(
        "bash",
        [scriptPath, head, "/bin/sh", "-c", `echo ran >> ${JSON.stringify(join(root, "ran"))}`],
        { cwd: root, encoding: "utf8", env: { ...process.env, ...extraEnv } },
      );
    },
    runGate(command: string) {
      const transport = buildCrabboxGateTransport({
        bootstrap: script,
        command,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      const launcher = join(root, "launcher.sh");
      writeFileSync(launcher, transport.input);
      return spawnSync("/bin/bash", [launcher, ...transport.args], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
      });
    },
    downloads: () => (exists("downloads") ? read("downloads") : ""),
  };
}

describe("scripts/crabbox-untrusted-bootstrap.sh", () => {
  it.skipIf(process.platform !== "linux").each([37])(
    "streams the full bootstrap with child exit %i and removes its isolated home",
    (exitCode) => {
      const f = fixture();
      const result = f.runGate(`set -euo pipefail; /bin/bash -c 'exit ${exitCode}'`);
      expect(result.status, result.stderr).toBe(exitCode);
      expect(f.read("install-log")).toBe("frozen\n");
      expect(existsSync(f.read("install-home"))).toBe(false);
    },
  );

  it("pins the package manager required by the trusted checkout", () => {
    const script = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      packageManager?: string;
    };
    const pnpmSpec = script.match(/^pnpm_spec="([^"]+)"$/mu)?.[1];

    expect(pnpmSpec).toBe(packageJson.packageManager);
  });

  it("bounds both IMDSv2 identity requests", () => {
    const imdsRequests = source.match(
      /\/usr\/bin\/curl[\s\S]*?http:\/\/169\.254\.169\.254[^\n]*/gu,
    );

    expect(imdsRequests).toHaveLength(2);
    for (const request of imdsRequests ?? []) {
      expect(request).toContain("--connect-timeout 2");
      expect(request).toContain("--max-time 5");
    }
  });

  it("reuses authenticated archives without trusting a previously extracted runtime", () => {
    const f = fixture();
    for (let run = 0; run < 2; run++) {
      mkdirSync(join(f.install, "bin"), { recursive: true });
      executable(join(f.install, "bin", "node"), "#!/bin/sh\nexit 91\n");
      mkdirSync(join(f.corepack, "v1", "pnpm", "12.11.1"), { recursive: true });
      writeFileSync(join(f.corepack, "v1", "pnpm", "12.11.1", ".corepack"), '{"bin":"bad"}');
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
    }
    expect(f.downloads()).toBe("");
    expect(f.read("install-log")).toBe("frozen\nfrozen\n");
    expect(f.read("ran")).toBe("ran\nran\n");
  });

  it("prepares the approved historical pin outside the checkout before frozen installation", () => {
    const f = fixture();
    const spec = historicalPnpmSpec;
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ packageManager: spec }));
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.read("prepared-pin")).toBe(`${spec}\n${f.install}\n`);
    expect(f.downloads()).toBe("pnpm-download\n");
    expect(f.read("install-log")).toBe("frozen\n");
    expect(f.read("ran")).toBe("ran\n");
  });

  it.each(["node", "wrapper", "native"])(
    "rejects a %s cache substitution despite forged adjacent metadata",
    (kind) => {
      const f = fixture();
      const archive =
        kind === "node"
          ? "node-v24.21.0-linux-x64.tar.xz"
          : kind === "wrapper"
            ? "pnpm-12.11.1.tgz"
            : "exe.linux-x64-12.11.1.tgz";
      const bytes = Buffer.from("substituted archive");
      writeFileSync(join(f.image, archive), bytes);
      writeFileSync(
        join(f.image, "SHASUMS256.txt"),
        `${createHash("sha256").update(bytes).digest("hex")}  ${archive}\n`,
      );
      writeFileSync(join(f.image, ".complete"), "");
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(f.downloads()).toContain(kind === "node" ? "node-download" : "pnpm-download");
    },
  );

  it.each([
    ["current-wrong-hash", "packageManager pin differs from trusted main"],
    ["malformed-json", "invalid package.json"],
    ["head", "expected HEAD"],
    ["iam", "IAM credentials endpoint returned 200"],
  ])("rejects %s before Corepack setup, installation, or workload execution", (kind, error) => {
    const f = fixture();
    const manifests: Record<string, string> = {
      "current-wrong-hash": JSON.stringify({ packageManager: `${f.spec}0` }),
      "malformed-json": "{",
    };
    const manifest = manifests[kind];
    if (manifest !== undefined) {
      writeFileSync(join(f.root, "package.json"), manifest);
    }
    const result = f.run(
      kind === "iam" ? { FIXTURE_IAM_STATUS: "200" } : {},
      kind === "head" ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : undefined,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(["corepack-log", "ran", "install-log"].map(f.exists)).toEqual([false, false, false]);
  });

  it("refuses an invalid download after rejecting the image archive", () => {
    const f = fixture();
    for (const directory of [f.image, f.origin]) {
      writeFileSync(join(directory, "node-v24.21.0-linux-x64.tar.xz"), "invalid");
    }
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("differs from the trusted digest");
    expect(existsSync(f.install)).toBe(false);
    expect(f.exists("ran")).toBe(false);
  });

  it("clears Node injection before reading the candidate package manager", () => {
    const f = fixture();
    const injected = join(f.root, "injected.cjs");
    writeFileSync(injected, 'throw new Error("injected Node options executed");');
    const result = f.run({ NODE_OPTIONS: `--require=${injected}`, NODE_PATH: f.root });
    expect(result.status, result.stderr).toBe(0);
  });
});

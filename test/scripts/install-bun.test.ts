import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStandaloneInstaller } from "../../scripts/lib/standalone-installers.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const installer = readStandaloneInstaller(process.cwd(), "install.sh");
const node = requireNodeTool("node");
const version = "2026.10.1";
const revision = "1.4.3-canary.1+abcdef123";
const tag = "openclaw-fixture";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function executable(path: string, source: string) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = tempDirs.make("install-bun-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  for (const path of [bin, home, tmp, join(root, "bun-linux-x64")]) {
    mkdirSync(path);
  }
  const bun = join(root, "bun-linux-x64", "bun");
  executable(
    bun,
    `#!/bin/bash
set -eu
case "$1" in
  --revision) echo '${revision}' ;;
  pm) echo "$HOME/.bun/bin" ;;
  -e) exec "$REAL_NODE" "$@" ;;
  add)
    printf 'add:%s launcher:%s\\n' "$*" "$OPENCLAW_PACKAGE_BUN_LAUNCHER" >> "$FIXTURE_ROOT/effects"
    if command -v node >/dev/null; then echo 'Node visible during Bun install' >&2; exit 77; fi
    mkdir -p "$HOME/.bun/bin" "$HOME/package/scripts/lib"
    if [[ "\${OMIT_PACKAGE_PIN:-0}" != 1 ]]; then
      cp "$FIXTURE_ROOT/\${PACKAGE_PIN:-pin.json}" "$HOME/package/scripts/lib/openclaw-bun.json"
    fi
    printf '#!/bin/sh\\nexec "%s" "%s/package/openclaw.mjs" "$@"\\n#openclaw-bun=%s\\n#openclaw-entry=%s/package/openclaw.mjs\\n' "$0" "$HOME" "$0" "$HOME" > "$HOME/.bun/bin/openclaw"
    chmod +x "$HOME/.bun/bin/openclaw"
    ;;
  */openclaw.mjs)
    shift
    printf 'cli:%s\\n' "$*" >> "$FIXTURE_ROOT/effects"
    case "$1" in
      --version) echo "OpenClaw \${CLI_VERSION:-${version}}" ;;
      daemon) printf '{"service":{"loaded":%s}}\\n' "\${SERVICE_LOADED:-false}" ;;
      gateway) printf '%s' "\${TMPDIR-unset}" > "$FIXTURE_ROOT/service-tmpdir" ;;
    esac
    ;;
  *) exit 78 ;;
esac
`,
  );
  const zip = join(root, "bun.zip");
  const zipped = spawnSync("/usr/bin/zip", ["-q", zip, "bun-linux-x64/bun"], { cwd: root });
  expect(zipped.status).toBe(0);
  const artifact = {
    asset: "bun.zip",
    sha256: sha(readFileSync(zip)),
    executable: "bun-linux-x64/bun",
    executableSha256: sha(readFileSync(bun)),
  };
  const pin = {
    tag,
    revision,
    artifacts: Object.fromEntries(
      ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].map((platform) => [
        platform,
        artifact,
      ]),
    ),
  };
  writeFileSync(join(root, "pin.json"), JSON.stringify(pin));
  writeFileSync(join(root, "registry.json"), JSON.stringify({ latest: version, beta: version }));
  executable(
    join(bin, "curl"),
    `#!/bin/bash
set -eu
out=
while [[ $# -gt 1 ]]; do
  if [[ "$1" == -o ]]; then out="$2"; shift; fi
  shift
done
printf '%s\\n' "$1" >> "$FIXTURE_ROOT/requests"
case "$1" in
  https://registry.test/-/package/openclaw/dist-tags) cp "$FIXTURE_ROOT/registry.json" "$out" ;;
  https://pin.test/v${version}/pin.json) cp "$FIXTURE_ROOT/pin.json" "$out" ;;
  https://release.test/*/bun.zip) cp "$FIXTURE_ROOT/bun.zip" "$out" ;;
  *) echo "Unexpected network request: $1" >&2; exit 90 ;;
esac
`,
  );
  executable(join(bin, "uname"), '#!/bin/sh\necho "${FIXTURE_ARCH:-x86_64}"\n');
  executable(join(bin, "getconf"), '#!/bin/sh\n[ "${FIXTURE_MUSL:-0}" = 0 ]\n');
  executable(
    join(bin, "node"),
    '#!/bin/sh\necho forbidden-node >> "$FIXTURE_ROOT/effects"\nexit 99\n',
  );
  const script = join(root, "install.sh");
  // Use the real entry point; replace only its existing deadline wrapper so these
  // deterministic external-command fixtures never create watchdog sleeps.
  writeFileSync(
    script,
    `${installer}\nbounded_probe_output() { shift; "$@"; }\nparse_args "$@"\nmain\n`,
  );
  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync("/bin/bash", [script, ...args], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        SHELL: "/bin/bash",
        TMPDIR: tmp,
        OSTYPE: "linux-gnu",
        OPENCLAW_INSTALL_SH_NO_RUN: "1",
        OPENCLAW_INSTALL_NPM_REGISTRY: "https://registry.test",
        OPENCLAW_INSTALL_BUN_PIN_URL: "https://pin.test/v{version}/pin.json",
        OPENCLAW_INSTALL_BUN_RELEASE_BASE_URL: "https://release.test",
        FIXTURE_ROOT: root,
        REAL_NODE: node,
        ...env,
      },
    });
  }
  return { root, home, tmp, bun, artifact, pin, run };
}

function output(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  return result.stdout + result.stderr;
}

describe("install.sh Bun runtime", () => {
  it.each([
    ["linux-gnu", "x86_64", "linux-x64"],
    ["linux-gnu", "aarch64", "linux-arm64"],
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x86_64", "darwin-x64"],
  ])("resolves metadata and previews %s/%s without installing", (os, arch) => {
    const f = fixture();
    const result = f.run(["--runtime", "bun", "--dry-run"], {
      OSTYPE: os,
      FIXTURE_ARCH: arch,
      OPENCLAW_HOME: join(f.home, "alternate"),
    });
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain(version);
    expect(output(result)).toContain(tag);
    expect(output(result)).toContain("bun.zip");
    expect(output(result)).toContain(
      join(f.home, "alternate", ".openclaw/tools", `bun-${tag}`, "bun"),
    );

    expect(readFileSync(join(f.root, "requests"), "utf8").split("\n").filter(Boolean)).toEqual([
      "https://registry.test/-/package/openclaw/dist-tags",
      `https://pin.test/v${version}/pin.json`,
    ]);
    expect(existsSync(join(f.root, "effects"))).toBe(false);
    expect(readdirSync(f.tmp)).toEqual([]);
  });

  it("honors environment selection and lets --runtime node retain the default dry run", () => {
    const f = fixture();
    const bun = f.run(["--dry-run"], { OPENCLAW_RUNTIME: "bun", OPENCLAW_BUN_PATH: f.bun });
    expect(bun.status, output(bun)).toBe(0);
    expect(output(bun)).toContain(f.bun);
    const plain = f.run(["--dry-run"]);
    const explicit = f.run(["--runtime", "node", "--dry-run"], { OPENCLAW_RUNTIME: "bun" });
    for (const result of [plain, explicit]) {
      expect(result.status, output(result)).toBe(0);
      expect(output(result)).toContain("Install method:");
      expect(output(result)).not.toContain("Bun pin:");
    }
  });

  it.each([
    [["--runtime", "unknown"], {}, "Invalid --runtime"],
    [["--runtime"], {}, "Missing value"],
    [["--runtime", "bun", "--install-method", "git"], {}, "cannot build git"],
    [["--runtime", "bun"], { FIXTURE_ARCH: "armv7l" }, "x64/arm64"],
    [["--runtime", "bun"], { FIXTURE_MUSL: "1" }, "glibc Linux"],
    [["--runtime", "bun"], { OSTYPE: "msys" }, "Unsupported operating system"],
    [["--runtime", "bun", "--version", "./local.tgz"], {}, "published npm version"],
    [["--runtime", "bun", "--version", "github:openclaw/openclaw"], {}, "published npm version"],
    [["--runtime", "bun", "--bun-path", "relative/bun"], {}, "absolute, executable"],
  ] as const)("refuses invalid requests: %j", (args, env, message) => {
    const f = fixture();
    const result = f.run([...args, "--dry-run"], env);
    expect(result.status, output(result)).not.toBe(0);
    expect(output(result)).toContain(message);
    expect(existsSync(join(f.root, "effects"))).toBe(false);
  });

  it.each([
    "{",
    '{"latest":"2026.10.1","latest":"2026.10.2"}',
    '{"latest":"../bad"}',
    '{"nested":{"latest":"2026.10.1"}}',
    '{"latest":"2026.10.1",}',
    '{"latest":"2026.10.1","unknown":[]}',
    String.raw`{"latest":"2026.10.\u0031"}`,
  ])("refuses invalid or ambiguous registry metadata: %s", (json) => {
    const f = fixture();
    writeFileSync(join(f.root, "registry.json"), json);
    const result = f.run(["--runtime", "bun", "--dry-run"]);
    expect(result.status, output(result)).not.toBe(0);
    expect(existsSync(join(f.root, "effects"))).toBe(false);
  });

  it.each(["archive", "executable", "revision", "missing artifact"])(
    "refuses a bad %s before executing a package",
    (fault) => {
      const f = fixture();
      if (fault === "archive") {
        f.artifact.sha256 = "0".repeat(64);
      }
      if (fault === "executable") {
        f.artifact.executableSha256 = "0".repeat(64);
      }
      if (fault === "revision") {
        f.pin.revision = "1.4.3-canary.1+000000000";
      }
      if (fault === "missing artifact") {
        delete f.pin.artifacts["linux-x64"];
      }
      writeFileSync(join(f.root, "pin.json"), JSON.stringify(f.pin));
      const result = f.run(["--runtime", "bun", "--no-onboard"]);
      expect(result.status, output(result)).not.toBe(0);
      expect(output(result)).toMatch(/checksum mismatch|fork pin|Missing or invalid Bun pin/);
      expect(existsSync(join(f.root, "effects"))).toBe(false);
      expect(readdirSync(f.tmp)).toEqual([]);
      const target = join(f.home, ".openclaw/tools", `bun-${tag}`);
      if (existsSync(target)) {
        expect(readdirSync(target)).toEqual([]);
      }
    },
  );

  it.each([false, true])(
    "installs and re-pins with an unsafe shell profile: %s",
    (unsafeProfile) => {
      const f = fixture();
      const outsideProfile = join(f.root, "outside-profile");
      if (unsafeProfile) {
        writeFileSync(outsideProfile, "# untouched\n");
        symlinkSync(outsideProfile, join(f.home, ".profile"));
      }
      writeFileSync(
        join(f.home, ".bashrc"),
        `export PATH="${f.home}/.bun/bin:$PATH"\nexport PATH="/old/node/bin:$PATH"\n`,
      );
      const result = f.run(["--runtime", "bun", "--version", "beta", "--no-onboard"], {
        SERVICE_LOADED: "true",
      });
      expect(result.status, output(result)).toBe(0);
      if (unsafeProfile) {
        expect(output(result)).toContain("Refusing profile symlink outside your home");
        expect(output(result)).toContain(`export PATH="${f.home}/.bun/bin:$PATH"`);
        expect(readFileSync(outsideProfile, "utf8")).toBe("# untouched\n");
      }
      const target = join(f.home, ".openclaw/tools", `bun-${tag}`, "bun");
      expect(sha(readFileSync(target))).toBe(f.artifact.executableSha256);
      expect(readFileSync(join(f.root, "service-tmpdir"), "utf8")).toBe(f.tmp);
      expect(readFileSync(join(f.root, "effects"), "utf8")).toBe(
        `add:add -g --trust openclaw@${version} launcher:${target}\ncli:--version\ncli:daemon status --json\ncli:gateway install --runtime bun --runtime-path ${target} --force\n`,
      );
      expect(readFileSync(join(f.home, ".bashrc"), "utf8").trim().split("\n").at(-1)).toBe(
        `export PATH="${f.home}/.bun/bin:$PATH"`,
      );
      f.pin.tag = "openclaw-new-pin";
      writeFileSync(join(f.root, "pin.json"), JSON.stringify(f.pin));
      const updated = f.run(["--runtime", "bun", "--no-onboard"], { SERVICE_LOADED: "true" });
      expect(updated.status, output(updated)).toBe(0);
      const updatedTarget = join(f.home, ".openclaw/tools/bun-openclaw-new-pin/bun");
      expect(readFileSync(join(f.root, "effects"), "utf8")).toContain(
        `cli:gateway install --runtime bun --runtime-path ${updatedTarget} --force`,
      );
      expect(readdirSync(f.tmp)).toEqual([]);
    },
  );

  it.each(["./local.tgz", "local.tgz", "local.tar.gz"])(
    "accepts an explicit fork for custom package %s",
    (spec) => {
      const f = fixture();
      const result = f.run([
        "--runtime",
        "bun",
        "--bun-path",
        f.bun,
        "--version",
        spec,
        "--no-onboard",
      ]);
      expect(result.status, output(result)).toBe(0);
      expect(existsSync(join(f.root, "requests"))).toBe(false);
    },
  );

  it("keeps TMPDIR unset for service installation when the caller omits it", () => {
    const f = fixture();
    const result = f.run(["--runtime", "bun", "--no-onboard"], {
      SERVICE_LOADED: "true",
      TMPDIR: undefined,
    });
    expect(result.status, output(result)).toBe(0);
    expect(readFileSync(join(f.root, "service-tmpdir"), "utf8")).toBe("unset");
  });

  it.each(["tag", "revision", "asset", "executable", "sha256", "executableSha256"])(
    "refuses installed pin drift in %s before launching the CLI",
    (field) => {
      const f = fixture();
      const changed = structuredClone(f.pin);
      if (field === "tag" || field === "revision") {
        changed[field] = "changed";
      } else {
        changed.artifacts["linux-x64"] = { ...f.artifact, [field]: "changed" };
      }
      writeFileSync(join(f.root, "other-pin.json"), JSON.stringify(changed));
      const result = f.run(["--runtime", "bun", "--bun-path", f.bun, "--no-onboard"], {
        PACKAGE_PIN: "other-pin.json",
      });
      expect(result.status, output(result)).not.toBe(0);
      expect(output(result)).toContain("Installed package Bun pin differs");
      expect(readFileSync(join(f.root, "effects"), "utf8")).not.toContain("cli:");
    },
  );

  it("checks an explicit binary checksum before executing even --revision", () => {
    const f = fixture();
    const unverified = join(f.root, "unverified-bun");
    executable(unverified, '#!/bin/sh\necho executed > "$FIXTURE_ROOT/effects"\n');
    const result = f.run(["--runtime", "bun", "--bun-path", unverified, "--dry-run"]);
    expect(result.status, output(result)).not.toBe(0);
    expect(output(result)).toContain("fork checksum");
    expect(existsSync(join(f.root, "effects"))).toBe(false);
  });

  it("accepts a historical published package using its verified release tag pin", () => {
    const f = fixture();
    const result = f.run(["--runtime", "bun", "--version", version, "--no-onboard"], {
      OMIT_PACKAGE_PIN: "1",
    });
    expect(result.status, output(result)).toBe(0);
    expect(output(result).match(/Package predates its bundled Bun pin/g)).toHaveLength(1);
    expect(output(result)).toContain(`verified against the v${version} tag pin`);
    expect(readFileSync(join(f.root, "requests"), "utf8")).not.toContain("registry.test");
    expect(readFileSync(join(f.root, "effects"), "utf8")).toContain("cli:--version");
    expect(readFileSync(join(f.root, "effects"), "utf8")).not.toContain("cli:gateway");
  });

  it.each(["missing custom pin", "wrong published version"])("refuses %s", (fault) => {
    const f = fixture();
    const args = ["--runtime", "bun", "--no-onboard"];
    if (fault === "missing custom pin") {
      args.push("--version", "./local.tgz", "--bun-path", f.bun);
    }
    const result = f.run(args, { OMIT_PACKAGE_PIN: "1", CLI_VERSION: "2026.9.9" });
    expect(result.status, output(result)).not.toBe(0);
    expect(output(result)).toContain(
      fault === "missing custom pin" ? "Custom package lacks" : "unexpected version",
    );
    expect(readFileSync(join(f.root, "effects"), "utf8")).not.toContain("cli:gateway");
  });

  it.each(["duplicate key", "escaped value", "path key"])("rejects ambiguous pin: %s", (fault) => {
    const f = fixture();
    let pin = JSON.stringify(f.pin);
    if (fault === "duplicate key") {
      pin = pin.replace("{", '{"tag":"other",');
    }
    if (fault === "escaped value") {
      pin = pin.replace(tag, "openclaw-" + String.raw`\u0066` + "ixture");
    }
    if (fault === "path key") {
      pin = pin.replace('"artifacts":', '"artifacts/linux-x64":');
    }
    writeFileSync(join(f.root, "pin.json"), pin);
    const result = f.run(["--runtime", "bun", "--dry-run"]);
    expect(result.status, output(result)).not.toBe(0);
    expect(output(result)).toContain("Missing or invalid Bun pin");
    expect(existsSync(join(f.root, "effects"))).toBe(false);
  });

  it("refuses stock Bun and invalid macOS SQLite before package installation", () => {
    const f = fixture();
    const stock = join(f.root, "stock-bun");
    executable(stock, "#!/bin/sh\necho 1.4.3+000000000\n");
    const result = f.run(["--runtime", "bun", "--bun-path", stock, "--dry-run"]);
    expect(result.status, output(result)).not.toBe(0);
    expect(output(result)).toContain("stock Bun is unsupported");
    const sqlite = f.run(["--runtime", "bun", "--bun-path", f.bun, "--no-onboard"], {
      OSTYPE: "darwin",
      OPENCLAW_SQLITE_LIBRARY: join(f.root, "missing.dylib"),
    });
    expect(sqlite.status, output(sqlite)).not.toBe(0);
    expect(output(sqlite)).toContain("WAL-safe, extension-capable SQLite");
    expect(existsSync(join(f.root, "effects"))).toBe(false);
  });
});

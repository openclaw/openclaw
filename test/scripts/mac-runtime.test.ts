import { spawnSync } from "node:child_process";
// Exercise publication and provisioning boundaries without signing, service control, or operator state.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, cp, link as hardlink, mkdir, rename, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it as baseIt } from "vitest";
import { readStandaloneInstaller } from "../../scripts/lib/standalone-installers.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  artifactFixture,
  createMacCases,
  expectExit,
  write,
} from "./mac-elevation-artifact.test-support.js";
import {
  compiledMacNativeFixtures,
  runMacFixtureTool,
} from "./mac-native-fixtures.test-support.js";
import { createMacScriptTest, type MacScriptFixture } from "./mac-script-fixture.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function scriptFixture(prefix: string) {
  const root = temps.make(`openclaw-runtime-${prefix}-`);
  const at = (name: string) => path.join(root, name);
  const put = (name: string, contents: string | Buffer, mode?: number) => {
    mkdirSync(path.dirname(at(name)), { recursive: true });
    writeFileSync(at(name), contents);
    if (mode !== undefined) {
      chmodSync(at(name), mode);
    }
  };
  const link = (target: string, name: string) => {
    mkdirSync(path.dirname(at(name)), { recursive: true });
    symlinkSync(target, at(name));
  };
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync("/bin/bash", args, {
      encoding: "utf8",
      env: { HOME: root, PATH: "/usr/bin:/bin", ...env },
    });
  return {
    root,
    at,
    put,
    link,
    run,
    bash: (program: string, env?: NodeJS.ProcessEnv) => run(["-c", program], env),
  };
}

function pythonInventory(root: string, marker: string, program: string, ...args: string[]) {
  const prelude = `import os, pathlib, runpy, sys, unittest
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root = pathlib.Path(sys.argv[1])
rejects = unittest.TestCase().assertRaises
rejects_message = unittest.TestCase().assertRaisesRegex
initial_fds = set(os.listdir('/dev/fd'))
`;
  const epilogue = `\nassert set(os.listdir('/dev/fd')) == initial_fds\nprint(${JSON.stringify(marker)})\n`;
  const result = spawnSync(
    "/usr/bin/python3",
    ["-B", "-c", prelude + program + epilogue, root, ...args],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(marker);
}

async function portabilityFixture(root: string) {
  const { auditMacRuntimePortability } =
    await import("../../scripts/lib/mac-runtime-portability.mjs");
  const { machoFixture } = await import("../helpers/mac-native.js");
  const bun = path.join(root, "bun");
  writeFileSync(bun, machoFixture());
  return { audit: () => auditMacRuntimePortability(root, bun), machoFixture };
}

function loadCommand(id: number, value: string, offset: number) {
  const name = Buffer.from(value + "\0");
  const bytes = Buffer.alloc(Math.ceil((offset + name.length) / 8) * 8);
  bytes.writeUInt32LE(id, 0);
  bytes.writeUInt32LE(bytes.length, 4);
  bytes.writeUInt32LE(offset, 8);
  name.copy(bytes, offset);
  return bytes;
}

function nativeImage(header: Buffer, ...commands: Buffer[]) {
  const bytes = Buffer.concat(commands);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(bytes.length, 20);
  return Buffer.concat([header, bytes]);
}

const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

const packageTimeouts = {
  OPENCLAW_DOCKER_PACKAGE_INVENTORY_TIMEOUT_MS: "123456",
  OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS: "234567",
  OPENCLAW_DOCKER_PACKAGE_TARBALL_CHECK_TIMEOUT_MS: "900000",
};

const materializer = "scripts/materialize-mac-runtime.py";

const inventory = "scripts/lib/mac-native-inventory.py";

type MaterializationFixture = Awaited<ReturnType<typeof materializationFixture>>;

async function observeMaterialization(fixture: MaterializationFixture, prelude: string) {
  // Assert in Vitest: Python atexit exceptions do not change the process exit status.
  const result = await fixture.run("arm64", {
    prelude: `import atexit, json, os, shutil, subprocess
initial_fds = len(os.listdir("/dev/fd"))
def record(**values):
    print(json.dumps(dict(values, initialFds=initial_fds, finalFds=len(os.listdir("/dev/fd")))))
${prelude}`,
  });
  const evidence: Record<string, unknown> = JSON.parse(result.stdout);
  expect(evidence.initialFds).toEqual(expect.any(Number));
  expect(evidence.finalFds).toBe(evidence.initialFds);
  return { result, evidence };
}

function expectUnpublished(
  fixture: MaterializationFixture,
  result: { status: number | null; stderr: string },
  error?: RegExp | string,
) {
  expect(result.status, result.stderr).not.toBe(0);
  expect(existsSync(fixture.destination)).toBe(false);
  if (typeof error === "string") {
    expect(result.stderr).toContain(error);
  } else if (error) {
    expect(result.stderr).toMatch(error);
  }
}

type RuntimeScratchObservation = {
  phase: "pack" | "driver" | "install" | "verify";
  home: string;
  temporary: string;
  createdDirectory: string;
  privateRoot: string | null;
  privateRootMode: number | null;
  packageTimeouts: Record<string, string>;
  product: string;
  productDevice: string;
  productInode: string;
  cpu: string | null;
};

function snapshot(root: string) {
  const records: { path: string; mode: number; kind: string; content?: string }[] = [];
  function visit(file: string) {
    const stat = lstatSync(file);
    const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file";
    records.push({
      path: path.relative(root, file),
      mode: stat.mode & 0o7777,
      kind,
      ...(kind === "link"
        ? { content: readlinkSync(file) }
        : kind === "file"
          ? { content: createHash("sha256").update(readFileSync(file)).digest("hex") }
          : {}),
    });
    if (kind === "directory") {
      for (const name of readdirSync(file).toSorted()) {
        visit(path.join(file, name));
      }
    }
  }
  visit(root);
  return records;
}

async function materializationFixture(mac: MacScriptFixture, complete = false) {
  const root = realpathSync(mac.createTempDir("openclaw-runtime-native-copy-"));
  const source = path.join(root, "canonical");
  const parent = path.join(root, "stage");
  const destination = path.join(parent, "derived");
  const at = (...parts: string[]) => path.join(source, ...parts);
  const put = (name: string, bytes: string | Buffer, mode?: number) => write(at(name), bytes, mode);
  const tool = (command: string, args: string[]) => runMacFixtureTool(command, args, root, mac);
  await mkdir(source);
  await mkdir(parent);
  const binaries = await compiledMacNativeFixtures(root, mac);
  for (const [name, bytes] of Object.entries(
    complete ? binaries : { arm64: binaries.arm64, elf: binaries.elf },
  )) {
    await put(`images/${name}`, bytes);
  }
  await put("nested/win32/build.mjs", "// nonbinary resource remains byte-identical\n", 0o640);
  await put("engine.wasm", Buffer.from("0061736d01000000", "hex"));
  // Java and fat Mach-O share CAFEBABE. Classifier-owned non-native resources survive.
  await put(
    "Example.class",
    Buffer.from("cafebabe0000003400010001000000000000000000000000", "hex"),
  );
  await put("scripts/resource [*]\n.js", "// resource\n");
  await mkdir(path.join(source, "empty"));
  await chmod(path.join(source, "empty"), 0o550);
  await symlink("../nested/win32/build.mjs", path.join(source, "scripts/npm-style"));
  await symlink("nested/win32", path.join(source, "directory-alias"));
  const python = (args: string[], prelude = "") =>
    mac.run(
      "/usr/bin/python3",
      [
        "-B",
        ...(prelude
          ? [
              "-c",
              `${prelude}\nimport runpy, sys\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")`,
            ]
          : []),
        materializer,
        ...args,
      ],
      { encoding: "utf8", env: { HOME: root, TMPDIR: root, PATH: systemPath } },
    );
  return {
    root,
    source,
    parent,
    destination,
    binaries,
    at,
    put,
    tool,
    archs: async (file: string) =>
      (await tool("/usr/bin/lipo", ["-archs", file])).split(" ").toSorted(),
    merge: (incoming: string, prelude = "") => python(["--merge", incoming, destination], prelude),
    async run(
      arch = "arm64",
      options: { source?: string; destination?: string; prelude?: string } = {},
    ) {
      return await python(
        [options.source ?? source, options.destination ?? destination, parent, arch],
        options.prelude,
      );
    },
  };
}

async function stagingFixture(
  mac: MacScriptFixture,
  architectures: readonly string[] = ["arm64", "x86_64"],
) {
  const root = realpathSync(mac.createTempDir("openclaw-runtime-materialization-"));
  const binaries = await compiledMacNativeFixtures(root, mac);
  const scripts = path.join(root, "scripts");
  const destination = path.join(root, "published");
  const calls = path.join(root, "verification-calls");
  const scratchLog = path.join(root, "scratch-observations");
  const tmp = path.join(root, "tmp");
  const script = (name: string, contents: string | Buffer) =>
    write(path.join(scripts, name), contents);
  await mkdir(scripts);
  await mkdir(tmp);
  await write(path.join(root, "operator-sentinel"), "ambient home must remain untouched");
  await write(path.join(tmp, "other-task/sentinel"), "unrelated scratch must survive");
  await cp("scripts/stage-mac-runtime.sh", path.join(scripts, "stage-mac-runtime.sh"));
  await script(
    "lib/desktop-runtime-prune.mjs",
    readFileSync("scripts/lib/desktop-runtime-prune.mjs"),
  );
  await script(
    "lib/desktop-runtime-plugins.mjs",
    'if (process.argv[2] === "plan") console.log(JSON.stringify({releaseTag: "v2026.10.2", pluginIds: []}));',
  );
  await cp(materializer, path.join(scripts, path.basename(materializer)));
  await script("lib/mac-native-inventory.py", readFileSync(inventory));
  await write(path.join(root, "dist/build-info.json"), '{"buildId":"unchanged-build"}');
  await script(
    "record-scratch.cjs",
    `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
module.exports = (phase, product) => {
  const home = fs.realpathSync(process.env.HOME);
  assert(fs.statSync(home).isDirectory(), 'child HOME must already exist');
  assert(!fs.existsSync(path.join(home, 'operator-sentinel')), 'ambient HOME leaked');
  assert.equal(process.env.OPENCLAW_STATE_DIR, undefined, 'ambient state leaked');
  assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN, undefined, 'ambient credential leaked');
  assert.equal(process.env.NODE_OPTIONS, undefined, 'ambient Node options leaked');
  assert.equal(process.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS, undefined, 'unused build control leaked');
  const temporary = fs.realpathSync(os.tmpdir());
  const component = path.relative(${JSON.stringify(tmp)}, temporary).split(path.sep)[0];
  const privateRoot = component && component !== '..' ? path.join(${JSON.stringify(tmp)}, component) : null;
  const createdDirectory = fs.mkdtempSync(path.join(temporary, 'fixture-scratch-'));
  fs.writeFileSync(path.join(createdDirectory, 'sentinel'), phase);
  fs.mkdirSync(path.join(home, '.npm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.npm/cache'), phase);
  const info = fs.statSync(product, { bigint: true });
  fs.appendFileSync(${JSON.stringify(scratchLog)}, JSON.stringify({
    phase, home, temporary, createdDirectory, privateRoot,
    packageTimeouts: Object.fromEntries(${JSON.stringify(Object.keys(packageTimeouts))}.flatMap(name =>
      process.env[name] ? [[name, process.env[name]]] : [])),
    privateRootMode: privateRoot === null ? null : fs.statSync(privateRoot).mode & 0o777,
    product, productDevice: info.dev.toString(), productInode: info.ino.toString(),
    cpu: process.env.npm_config_cpu ?? null,
  }) + '\\n');
};
if (require.main === module) module.exports(process.argv[2], process.argv[3]);
`,
  );
  await script(
    "package-openclaw-for-docker.mjs",
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import recordScratch from './record-scratch.cjs';
assert(process.argv.includes('--pnpm-pack'), 'runtime package must use the repository-pinned packer');
const target = path.join(process.argv[process.argv.indexOf('--output-dir') + 1], process.argv[process.argv.indexOf('--output-name') + 1]);
fs.writeFileSync(target, 'inert package mock');
recordScratch('pack', target);
if (fs.existsSync(${JSON.stringify(path.join(root, "reject-pack"))})) process.exit(41);
console.log(target);
`,
  );
  await script(
    "verify-mac-runtime.mjs",
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import recordScratch from './record-scratch.cjs';
assert.equal(process.argv[3], ${JSON.stringify(path.join(root, "dist/build-info.json"))});
assert.equal(fs.readFileSync(process.argv[2]+'/lib/node_modules/openclaw/dist/build-info.json', 'utf8'), fs.readFileSync(process.argv[3], 'utf8'));
assert.equal(fs.existsSync(path.join(process.argv[2], 'lib/node_modules/openclaw/dist/control-ui/index.html')), true, 'runtime lost Control UI');
assert.equal(fs.existsSync(path.join(process.argv[2], 'bin/node')), false, 'build-time Node leaked');
assert.equal(process.env.OPENCLAW_SQLITE_LIBRARY, path.join(process.argv[2], 'lib/libsqlite3.dylib'));
recordScratch('verify', process.argv[2]);
if (fs.existsSync(${JSON.stringify(path.join(root, "reject-verification"))})) process.exit(42);
`,
  );
  const canonical = path.join(root, "canonical");
  const packageRoot = path.join(canonical, "lib/node_modules/openclaw");
  const packageFile = (name: string, contents: string | Buffer, mode?: number) =>
    write(path.join(packageRoot, name), contents, mode);
  const nativePackages = [
    ["native-darwin-arm64", "darwin", "arm64", binaries.arm64, ["arm64"]],
    ["native-darwin-x64", "darwin", "x64", binaries.x86_64, ["x86_64"]],
    ["native-linux-arm64", "linux", "arm64", binaries.elf, []],
    ["@fixture/native-darwin-arm64", "darwin", "arm64", binaries.arm64, ["arm64"]],
    ["@fixture/native-linux-arm64", "linux", "arm64", binaries.elf, []],
  ] as const;
  for (const [name, os, cpu, bytes] of nativePackages) {
    const nativeRoot = path.join(packageRoot, "node_modules", name);
    await write(
      path.join(nativeRoot, "package.json"),
      JSON.stringify({ name, os: [os], cpu: [cpu] }),
    );
    await write(path.join(nativeRoot, "binding.node"), bytes);
  }
  await packageFile(
    "node_modules/npm/package.json",
    JSON.stringify({ name: "npm", version: "1.0.0" }),
  );
  await packageFile("node_modules/npm/bin/npm", "# inert Node launcher fixture\n", 0o755);
  await packageFile(
    "node_modules/npm/bin/npm-cli.js",
    "// CLI module must remain available to Bun\n",
  );
  await packageFile("dist/control-ui/index.html", "<!doctype html>\n");
  await packageFile("nested/package.json", '{"os":["win32"]}');
  await cp(path.join(root, "dist/build-info.json"), path.join(packageRoot, "dist/build-info.json"));
  await mkdir(path.join(packageRoot, "node_modules/.bin"));
  await symlink(
    "../native-linux-arm64/binding.node",
    path.join(packageRoot, "node_modules/.bin/native"),
  );
  await write(path.join(canonical, "lib/libsqlite3.dylib"), binaries.universalLibrary);
  // The fixture Bun is an explicit execution mock; no native payload is launched.
  await write(
    path.join(canonical, "bin/bun"),
    `#!/bin/bash
set -euo pipefail
[[ "$1" == ${quote(path.join(scripts, "verify-mac-runtime.mjs"))} ]] || exit 97
printf '%s|%s|%s\\n' "$0" "$2" "$3" >> ${quote(calls)}
exec ${quote(testNodeExecPath)} "$@"
`,
    0o755,
  );
  await script(
    "install-cli.sh",
    `
[[ -d "$HOME" ]] || { echo "fixture installer HOME must exist before source" >&2; exit 96; }
node_dir() { printf '%s' "$PREFIX/node"; }
node_bin() { printf '%s/bin/node' "$(node_dir)"; }
install_node() {
  [[ "$1" == darwin && "$2" == "$npm_config_cpu" ]]
  mkdir -p "$(node_dir)/bin"
  ln -s ${quote(testNodeExecPath)} "$(node_bin)"
  printf '%s\\n' "$2" > "$(node_dir)/installed-cpu"
  ${quote(testNodeExecPath)} ${quote(path.join(scripts, "record-scratch.cjs"))} driver "$(node_dir)"
}
install_openclaw() {
  [[ "$(cat "$OPENCLAW_VERSION")" == "inert package mock" ]]
  [[ "$npm_config_os" == darwin && "$npm_config_omit" == dev && "$npm_config_include" == optional ]]
  [[ "$npm_config_cpu" == arm64 || "$npm_config_cpu" == x64 ]]
  [[ "$(cat "$(node_dir)/installed-cpu")" == "$npm_config_cpu" ]]
  [[ "$(command -v node)" == "$(node_bin)" ]]
  mkdir -p "$(node_dir)/lib/node_modules"
  cp -pR ${quote(packageRoot)} "$(node_dir)/lib/node_modules/openclaw"
  # npm excludes other-CPU optional packages even when --force is set.
  local modules="$(node_dir)/lib/node_modules/openclaw/node_modules"
  if [[ "$npm_config_cpu" == arm64 ]]; then
    rm -rf "$modules/native-darwin-x64"
  else
    rm -rf "$modules/native-darwin-arm64" "$modules/@fixture/native-darwin-arm64"
  fi
  ${quote(testNodeExecPath)} ${quote(path.join(scripts, "record-scratch.cjs"))} install "$(node_dir)"
}
`,
  );
  await script(
    "stage-openclaw-bun.sh",
    `#!/bin/bash
set -euo pipefail
destination="$1"
[[ "$2" == darwin ]]
shift 2
[[ "$*" == ${quote(architectures.map((arch) => (arch === "x86_64" ? "x64" : arch)).join(" "))} ]]
mkdir -p "$destination/bin"
cp -p ${quote(path.join(canonical, "bin/bun"))} "$destination/bin/bun"
`,
  );
  await script(
    "build-mac-sqlite.sh",
    `#!/bin/bash
set -euo pipefail
[[ "$1" == ${quote(architectures.length === 1 ? architectures[0]! : "universal")} ]]
cp -p ${quote(path.join(canonical, "lib/libsqlite3.dylib"))} "$2/lib/libsqlite3.dylib"
`,
  );
  const supportedArchitectures = [];
  for (const arch of architectures) {
    if ((await mac.run("/usr/bin/arch", [`-${arch}`, "/usr/bin/true"])).status === 0) {
      supportedArchitectures.push(arch);
    }
  }
  return {
    root,
    destination,
    calls,
    scratchLog,
    nativePackages,
    supportedArchitectures,
    tmp,
    temporaryBefore: snapshot(tmp),
    readScratchObservations(): RuntimeScratchObservation[] {
      return existsSync(scratchLog)
        ? readFileSync(scratchLog, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as RuntimeScratchObservation)
        : [];
    },
    async run(variant: string, tempRoot = tmp, overrides = {}) {
      return await mac.run(
        "/bin/bash",
        [path.join(scripts, "stage-mac-runtime.sh"), destination, ...architectures],
        {
          encoding: "utf8",
          env: {
            HOME: root,
            TMPDIR: tempRoot,
            OPENCLAW_STATE_DIR: path.join(root, "operator-state"),
            PATH: `${path.dirname(testNodeExecPath)}:${systemPath}`,
            OPENCLAW_MAC_SIGNING_VARIANT: variant,
            OPENCLAW_GATEWAY_TOKEN: "synthetic-do-not-forward",
            NODE_OPTIONS: "--no-warnings",
            OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS: "345678",
            ...overrides,
          },
        },
      );
    },
  };
}

function expectRuntimeScratchCleaned(fixture: Awaited<ReturnType<typeof stagingFixture>>) {
  for (const observation of fixture.readScratchObservations()) {
    expect(existsSync(observation.home)).toBe(false);
    expect(existsSync(observation.createdDirectory)).toBe(false);
  }
  expect(snapshot(fixture.tmp)).toEqual(fixture.temporaryBefore);
}

describe.skipIf(process.platform !== "darwin")("Mac runtime materialization", () => {
  const it = createMacScriptTest();
  const cases = createMacCases(it, (mac) => mac);
  const materializations = createMacCases(it, materializationFixture);
  const stages = createMacCases(it, stagingFixture);
  cases.for([
    ["standard", false, ["arm64"]],
    ["elevation-host", true, ["arm64", "x86_64"]],
  ] as const)(
    "isolates %s staging and preserves package budgets (override=%s, architectures=%s)",
    async ([variant, overrideBudgets, architectures], mac) => {
      const fixture = await stagingFixture(mac, architectures);
      const before = snapshot(path.join(fixture.root, "canonical"));
      expectExit(await fixture.run(variant, fixture.tmp, overrideBudgets ? packageTimeouts : {}));
      expect(snapshot(path.join(fixture.root, "canonical"))).toEqual(before);
      const observations = fixture.readScratchObservations();
      expect(observations.map(({ phase }) => phase)).toEqual([
        "pack",
        ...architectures.flatMap(() => ["driver", "install"]),
        ...fixture.supportedArchitectures.map(() => "verify"),
      ]);
      expect(observations.filter(({ phase }) => phase === "install").map(({ cpu }) => cpu)).toEqual(
        architectures.map((arch) => (arch === "x86_64" ? "x64" : arch)),
      );
      const drivers = observations.filter(({ phase }) => phase === "driver");
      expect(new Set(drivers.map(({ product }) => product)).size).toBe(architectures.length);
      expect(drivers.map(({ product }) => product)).toEqual(
        observations.filter(({ phase }) => phase === "install").map(({ product }) => product),
      );
      expect(new Set(observations.map(({ privateRoot }) => privateRoot)).size).toBe(1);
      for (const observation of observations) {
        expect(observation.packageTimeouts).toEqual(
          observation.phase === "pack" && overrideBudgets ? packageTimeouts : {},
        );
        expect(observation.privateRoot).not.toBeNull();
        expect(path.dirname(observation.privateRoot!)).toBe(fixture.tmp);
        expect(observation.privateRootMode).toBe(0o700);
        for (const file of [observation.home, observation.temporary]) {
          expect(path.relative(observation.privateRoot!, file).split(path.sep)[0]).not.toBe("..");
        }
        expect(observation.createdDirectory.startsWith(`${observation.temporary}/`)).toBe(true);
        if (observation.phase !== "verify") {
          expect(observation.product.startsWith(`${observation.privateRoot}/`)).toBe(true);
        } else {
          expect(observation.product.startsWith(`${fixture.tmp}/`)).toBe(false);
          expect(observation.productDevice).toBe(
            statSync(path.dirname(fixture.destination), { bigint: true }).dev.toString(),
          );
        }
      }
      const calls = existsSync(fixture.calls)
        ? readFileSync(fixture.calls, "utf8").trim().split("\n")
        : [];
      expect(calls).toHaveLength(fixture.supportedArchitectures.length);
      for (const call of calls) {
        const [bun, runtime, expected] = call.split("|");
        expect(bun).toBe(`${runtime}/bin/bun`);
        expect(expected).toBe(path.join(fixture.root, "dist/build-info.json"));
        const staging = path.dirname(runtime!);
        expect(path.dirname(staging)).toBe(path.dirname(fixture.destination));
        expect(existsSync(staging)).toBe(false);
        const verified = observations.find(
          ({ phase, product }) => phase === "verify" && product === runtime,
        );
        expect(verified).toBeDefined();
        expect(statSync(fixture.destination, { bigint: true }).ino.toString()).toBe(
          verified!.productInode,
        );
      }
      const ownerMarker = path.join(
        fixture.destination,
        "lib/node_modules/openclaw/openclaw-install-owner.json",
      );
      const markerInfo = lstatSync(ownerMarker);
      expect([markerInfo.isFile(), markerInfo.mode & 0o777]).toEqual([true, 0o644]);
      expect(JSON.parse(readFileSync(ownerMarker, "utf8"))).toMatchObject({
        schemaVersion: 1,
        owner: "macos-app",
      });
      const modules = path.join(fixture.destination, "lib/node_modules/openclaw/node_modules");
      for (const [name, _os, _cpu, bytes, retainedOn] of fixture.nativePackages) {
        const target = path.join(modules, name);
        if (retainedOn.some((arch) => architectures.some((requested) => requested === arch))) {
          expect(readFileSync(path.join(target, "binding.node"))).toEqual(bytes);
        } else {
          expect(existsSync(target)).toBe(false);
        }
      }
      expect(existsSync(path.join(modules, ".bin"))).toBe(false);
      expect(readdirSync(path.join(modules, "npm/bin"))).toEqual(["npm-cli.js"]);
      expect(readFileSync(path.join(modules, "../nested/package.json"), "utf8")).toBe(
        '{"os":["win32"]}',
      );
      expectRuntimeScratchCleaned(fixture);
    },
  );

  stages("rejects unavailable runtime scratch before publication", async (fixture) => {
    const before = snapshot(fixture.root);
    const result = await fixture.run("standard", path.join(fixture.tmp, "unavailable"));
    expect(result.status, result.stderr).not.toBe(0);
    expect(fixture.readScratchObservations()).toEqual([]);
    expect(existsSync(fixture.calls)).toBe(false);
    expect(snapshot(fixture.root)).toEqual(before);
  });

  stages("cleans runtime scratch and product staging after pack failure", async (fixture) => {
    await write(path.join(fixture.root, "reject-pack"), "");
    const before = readdirSync(fixture.root).toSorted();
    expectExit(await fixture.run("standard"), 41);
    expect(fixture.readScratchObservations().map(({ phase }) => phase)).toEqual(["pack"]);
    expect(existsSync(fixture.calls)).toBe(false);
    expect(existsSync(fixture.destination)).toBe(false);
    expectRuntimeScratchCleaned(fixture);
    expect(
      readdirSync(fixture.root)
        .filter((name) => name !== path.basename(fixture.scratchLog))
        .toSorted(),
    ).toEqual(before);
  });

  stages.for(["verification", "occupied", "occupied-link"])(
    "preserves the existing runtime after %s failure",
    async (failure, fixture) => {
      if (failure === "verification") {
        await write(path.join(fixture.root, "reject-verification"), "");
      } else if (failure === "occupied") {
        await write(path.join(fixture.destination, "sentinel"), "owner");
      } else {
        await symlink("missing", fixture.destination);
      }
      const occupied = failure !== "verification";
      const before = occupied ? snapshot(fixture.destination) : [];
      expectExit(await fixture.run("standard"), failure === "verification" ? 42 : 1);
      const calls = readFileSync(fixture.calls, "utf8").trim().split("\n");
      const verifiedCount = failure === "verification" ? 1 : fixture.supportedArchitectures.length;
      expect(calls).toHaveLength(verifiedCount);
      for (const call of calls) {
        expect(existsSync(path.dirname(call.split("|")[1]!))).toBe(false);
      }
      expect(occupied ? snapshot(fixture.destination) : []).toEqual(before);
      expect(fixture.readScratchObservations()).toHaveLength(5 + verifiedCount);
      expectRuntimeScratchCleaned(fixture);
    },
  );

  materializations.for(["resource", "native", "mode", "symlink", "kind"])(
    "rejects a conflicting shared %s before mutating the merged runtime",
    async (kind, fixture) => {
      const shared = fixture.at("shared");
      if (kind === "symlink") {
        await symlink("engine.wasm", shared);
      } else {
        await write(shared, kind === "native" ? fixture.binaries.arm64 : "shared resource\n");
      }
      expectExit(await fixture.run("arm64"));
      if (kind === "mode") {
        await chmod(shared, 0o600);
      } else {
        await unlink(shared);
        if (kind === "symlink") {
          await symlink("Example.class", shared);
        } else if (kind === "kind") {
          await mkdir(shared);
        } else {
          await write(
            shared,
            kind === "native"
              ? Buffer.concat([fixture.binaries.arm64, Buffer.from("different same-CPU bytes")])
              : "different resource\n",
          );
        }
      }
      await fixture.put("000-new-architecture/addon.node", fixture.binaries.x86_64);
      const incoming = path.join(fixture.parent, "second");
      expectExit(
        await fixture.run(kind === "native" ? "arm64" : "x86_64", {
          destination: incoming,
        }),
      );
      const destinationBefore = snapshot(fixture.destination);
      const sourceBefore = snapshot(incoming);
      const result = await fixture.merge(incoming);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("Conflicting shared runtime entry");
      expect(snapshot(fixture.destination)).toEqual(destinationBefore);
      expect(snapshot(incoming)).toEqual(sourceBefore);
    },
  );

  materializations.for([false, true])(
    "merges shared disjoint native slices only after full output verification (corrupt=%s)",
    async (corrupt, fixture) => {
      const relative = "node_modules/esbuild/bin/esbuild";
      await fixture.put(relative, fixture.binaries.arm64, 0o755);
      expectExit(await fixture.run("arm64"));
      await fixture.put(relative, fixture.binaries.x86_64, 0o755);
      const incoming = path.join(fixture.parent, "second");
      expectExit(await fixture.run("x86_64", { destination: incoming }));
      const before = snapshot(fixture.destination);
      const sourceBefore = snapshot(incoming);
      const result = await fixture.merge(
        incoming,
        `
import os, runpy, shutil, subprocess, sys
original_run = subprocess.run
def run(args, **kwargs):
    result = original_run(args, **kwargs)
    if ${corrupt ? "True" : "False"} and args[:2] == ["/usr/bin/lipo", "-create"]:
        os.lseek(kwargs["pass_fds"][0], 0, os.SEEK_SET)
        shutil.copyfile(args[2], args[args.index("-output") + 1])
    return result
subprocess.run = run
`,
      );
      expect(snapshot(incoming)).toEqual(sourceBefore);
      expect(readdirSync(fixture.parent).toSorted()).toEqual(["derived", "second"]);
      if (corrupt) {
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain("Incomplete merged runtime slices");
        expect(snapshot(fixture.destination)).toEqual(before);
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      const merged = path.join(fixture.destination, relative);
      expect(await fixture.archs(merged)).toEqual(["arm64", "x86_64"]);
      expect(statSync(merged).mode & 0o777).toBe(0o755);
      for (const arch of ["arm64", "x86_64"] as const) {
        const thin = path.join(fixture.root, `merged-${arch}`);
        await fixture.tool("/usr/bin/lipo", [merged, "-thin", arch, "-output", thin]);
        expect(readFileSync(thin)).toEqual(fixture.binaries[arch]);
      }
      expect(snapshot(fixture.destination).filter(({ path: name }) => name !== relative)).toEqual(
        before.filter(({ path: name }) => name !== relative),
      );
    },
  );

  materializations(
    "rejects merge source substitution while copying only descriptor-bound bytes",
    async (fixture) => {
      expectExit(await fixture.run("arm64"));
      const name = "new-architecture/addon.node";
      await fixture.put(name, fixture.binaries.x86_64);
      const incoming = path.join(fixture.parent, "second");
      expectExit(await fixture.run("x86_64", { destination: incoming }));
      const outside = path.join(fixture.root, "outside");
      await write(outside, "outside bytes must not be copied");
      const result = await fixture.merge(
        incoming,
        `
import os, runpy, shutil, sys
source = ${JSON.stringify(path.join(incoming, name))}
outside = ${JSON.stringify(outside)}
expected_inode = os.stat(source).st_ino
original_copy = shutil.copyfileobj
def copy(source_stream, destination, *args):
    if os.fstat(source_stream.fileno()).st_ino == expected_inode:
        os.rename(source, source + "-held")
        os.symlink(outside, source)
    return original_copy(source_stream, destination, *args)
shutil.copyfileobj = copy
`,
      );
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(/Inventory.*changed/);
      expect(readFileSync(path.join(fixture.destination, name))).toEqual(fixture.binaries.x86_64);
      expect(readFileSync(outside, "utf8")).toBe("outside bytes must not be copied");
    },
  );

  cases.for(["arm64", "x86_64", "arm64,x86_64"])(
    "retains every resource and eligible native image for %s without changing canonical input",
    async (arch, mac) => {
      const fixture = await materializationFixture(mac, true);
      await fixture.put(
        "lib/node_modules/openclaw/dist/control-ui/index.html",
        "<!doctype html>\n",
      );
      await fixture.put(
        "lib/node_modules/openclaw/dist/control-ui/assets/app.js",
        "// bundled Control UI\n",
      );
      const oddNative = "images/odd [*]?\narm64";
      await rename(fixture.at("images/arm64"), fixture.at(oddNative));
      for (const [name, contents, mode] of [
        ["database.js", "db.connect();\n", 0o644],
        ["unicode.js", "db.label = 'café';\n", 0o644],
        ["setuid.txt", "small inert resource\n", 0o4755],
      ] as const) {
        const resource = fixture.at("scripts", name);
        await write(resource, contents, mode);
      }
      // Establish the source filesystem's actual name equivalence; never guess
      // which Unicode spelling readdir returns or fold component text in the test.
      for (const [name, literal, alias] of [
        ["Library/addon.node", "library/ADDON.NODE", "0-case-alias"],
        ["Café.txt", "Cafe\u0301.txt", "0-unicode-alias"],
      ] as const) {
        await fixture.put(name, "retained lookup resource\n", 0o640);
        await symlink(literal, fixture.at(alias));
      }
      await hardlink(fixture.at("Library/addon.node"), fixture.at("Library/second.node"));
      await symlink("library/SECOND.NODE", fixture.at("0-hardlink-alias"));
      await symlink("library/", fixture.at("0-directory"));
      await symlink("0-DIRECTORY/../engine.wasm", fixture.at("0-parent-alias"));
      await chmod(fixture.source, 0o750);
      const before = snapshot(fixture.source);
      const result = expectExit(await fixture.run(arch));
      const omitted = new Set(
        [
          "coff",
          "pe",
          "elf",
          ...(arch === "arm64,x86_64"
            ? []
            : arch === "arm64"
              ? ["x86_64", "intelLibrary", "intelArchive"]
              : ["arm64", "armLibrary", "armArchive"]),
        ].map((name) => (name === "arm64" ? oddNative : `images/${name}`)),
      );
      expect(snapshot(fixture.destination)).toEqual(
        before.filter((entry) => !omitted.has(entry.path)),
      );
      expect(snapshot(fixture.source)).toEqual(before);
      const outputSecond = statSync(path.join(fixture.destination, "Library/second.node"));
      expect(outputSecond.ino).not.toBe(
        statSync(path.join(fixture.destination, "Library/addon.node")).ino,
      );
      expect(statSync(path.join(fixture.destination, "0-hardlink-alias")).ino).toBe(
        outputSecond.ino,
      );
      expect(result.stderr).toContain(`omitted ${omitted.size} native images`);
      for (const name of omitted) {
        expect(result.stderr).toContain(JSON.stringify(name));
      }
    },
  );

  materializations.for([
    "occupied",
    "occupied-link",
    "inside-source",
    "outside-parent",
    "source-link",
    "parent-alias",
  ])(
    "rejects unsafe construction roots (%s) without touching input or occupants",
    async (kind, fixture) => {
      let source = fixture.source;
      let destination = fixture.destination;
      if (kind === "occupied") {
        await write(path.join(destination, "sentinel"), "owner");
      }
      if (kind === "occupied-link") {
        await symlink(source, destination);
      }
      if (kind === "inside-source") {
        destination = path.join(source, "new-output");
      }
      if (kind === "outside-parent") {
        destination = path.join(fixture.root, "new-output");
      }
      if (kind === "source-link") {
        source = path.join(fixture.root, "source-alias");
        await symlink(fixture.source, source);
      }
      if (kind === "parent-alias") {
        await symlink(fixture.source, path.join(fixture.parent, "alias"));
        destination = path.join(fixture.parent, "alias", "new-output");
      }
      const before = snapshot(fixture.root);
      const result = await fixture.run("arm64", { source, destination });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(/File exists|disjoint|Not a directory/);
      expect(snapshot(fixture.root)).toEqual(before);
    },
  );

  materializations.for([
    "absolute",
    "escape",
    "dangling",
    "omitted",
    "case-omitted",
    "case-cycle",
    "case-file-slash",
    "link-cycle",
    "directory-cycle",
    "indirect-cycle",
  ])("rejects unprovable source links (%s) and leaves no partial output", async (kind, fixture) => {
    const targets: Record<string, string> = {
      absolute: fixture.at("engine.wasm"),
      escape: "../inert.c",
      omitted: "images/elf",
      "case-omitted": "IMAGES/ELF",
      "case-cycle": "LINK",
      "case-file-slash": "IMAGES/ARM64/",
      "directory-cycle": ".",
      "link-cycle": "link",
    };
    const target = targets[kind] ?? "missing";
    if (kind === "indirect-cycle") {
      await mkdir(fixture.at("a"));
      await mkdir(fixture.at("b"));
      await symlink("../b", fixture.at("a/to-b"));
      await symlink("../a", fixture.at("b/to-a"));
    } else {
      await symlink(target, fixture.at("link"));
    }
    const before = snapshot(fixture.source);
    const result = await fixture.run();
    expectUnpublished(fixture, result, /symlink|Cyclic|ELOOP|ENOENT|No such file/);
    expect(snapshot(fixture.source)).toEqual(before);
  });

  materializations.for(["mach", "fat64", "elf", "pe", "coff", "archive"])(
    "fails closed on malformed %s native candidates",
    async (kind, fixture) => {
      const bytes =
        kind === "mach"
          ? Buffer.from("cffaedfe", "hex")
          : kind === "fat64"
            ? Buffer.from("cafebabf", "hex")
            : kind === "elf"
              ? fixture.binaries.elf.subarray(0, 7)
              : kind === "coff"
                ? fixture.binaries.coff.subarray(0, 3)
                : kind === "pe"
                  ? fixture.binaries.pe.subarray(0, 16)
                  : Buffer.from("!<arch>\nmalformed");
      await fixture.put("broken", bytes);
      const before = snapshot(fixture.source);
      const result = await fixture.run();
      expectUnpublished(fixture, result);
      expect(snapshot(fixture.source)).toEqual(before);
    },
  );

  materializations.for([
    "file-exit",
    "file-framing",
    "file-error",
    "file-unknown",
    "lipo",
    "lipo-framing",
    "lipo-unknown",
    "lipo-wrong-fd",
    "lipo-fat-wrong-fd",
    "scan",
    "copy",
    "close",
    "output-link",
  ])("fails closed on %s errors without publishing partial output", async (failure, fixture) => {
    const before = snapshot(fixture.source);
    const result = await fixture.run("arm64", {
      prelude: `
import os, shutil, subprocess
failure = ${JSON.stringify(failure)}
original_run, original_scan, original_copy, original_fdopen = subprocess.run, os.scandir, shutil.copyfileobj, os.fdopen
opened = []
original_symlink = os.symlink
def symlink(target, name, *args, **kwargs):
    if failure == "output-link" and name.endswith("/scripts/npm-style"): target = "../engine.wasm"
    return original_symlink(target, name, *args, **kwargs)
os.symlink = symlink
def run(args, **kwargs):
    if failure == "lipo" and args[0] == "/usr/bin/lipo" or failure == "file-exit" and args[0] == "/usr/bin/file":
        raise OSError("injected tool failure")
    if args[0] == "/usr/bin/file" and failure == "file-unknown":
        return subprocess.CompletedProcess(args, 0, b"unrecognized native format\\0" * len(kwargs["pass_fds"]))
    if args[0] == "/usr/bin/file" and failure in ("file-framing", "file-error"):
        return subprocess.CompletedProcess(args, 0, b"truncated" if failure == "file-framing" else b"ERROR: injected\\0" * len(kwargs["pass_fds"]))
    if args[0] == "/usr/bin/lipo":
        fd = args[-1].encode()
        thin = b"Non-fat file: " + fd + b" is architecture: "
        faults = {
            "lipo-framing": thin + b"arm64???\\n",
            "lipo-unknown": thin + b"unknown\\n",
            "lipo-wrong-fd": b"Non-fat file: " + fd + b"0 is architecture: arm64\\n",
            "lipo-fat-wrong-fd": b"Architectures in the fat file: " + fd + b"0 are: arm64 x86_64 \\n",
        }
        if failure in faults: return subprocess.CompletedProcess(args, 0, faults[failure])
    return original_run(args, **kwargs)
def scan(fd):
    if failure == "scan" and os.fstat(fd).st_ino == original_stat.st_ino: raise OSError("injected scan failure")
    return original_scan(fd)
def copy(source, destination, *args):
    original_copy(source, destination, *args)
    if failure == "copy": raise OSError("injected copy failure")
def fdopen(*args, **kwargs):
    stream = original_fdopen(*args, **kwargs)
    opened.append(stream)
    if failure == "close" and len(opened) == 2:
        original_close = stream.close
        def close():
            original_close()
            raise OSError("injected close failure")
        stream.close = close
    return stream
original_stat = os.stat(${JSON.stringify(fixture.source)})
subprocess.run, os.scandir, shutil.copyfileobj, os.fdopen = run, scan, copy, fdopen
import atexit
@atexit.register
def verify_closed():
    assert all(stream.closed for stream in opened), "leaked source stream"
`,
    });
    expectUnpublished(
      fixture,
      result,
      /injected|Incomplete runtime|Invalid runtime|Uncertain runtime|Unclassified runtime|equivalent output target/,
    );
    expect(result.stderr).not.toContain("leaked source stream");
    expect(snapshot(fixture.source)).toEqual(before);
  });

  materializations.for(["before-open", "before-scan", "after-classification", "symlink-aba"])(
    "rejects source substitution %s without reading outside bytes or publishing",
    async (schedule, fixture) => {
      const inside = fixture.at("images");
      const outside = path.join(fixture.root, "outside");
      const outsideBytes = Buffer.concat([fixture.binaries.arm64, Buffer.from("outside sentinel")]);
      await write(path.join(outside, "arm64"), outsideBytes);
      if (schedule === "symlink-aba") {
        await fixture.put("a.txt", "original resource");
        await fixture.put("b.txt", "substituted resource");
        await symlink("a.txt", fixture.at("alias"));
      }
      const aliasInode =
        schedule === "symlink-aba" ? lstatSync(fixture.at("alias")).ino : undefined;
      const before = snapshot(fixture.source);
      const { result, evidence } = await observeMaterialization(
        fixture,
        `
inside, outside = ${JSON.stringify(inside)}, ${JSON.stringify(outside)}
schedule = ${JSON.stringify(schedule)}
original_stat, original_scan, original_run, original_copy = os.stat, os.scandir, subprocess.run, shutil.copyfileobj
original_open, outside_inode, outside_opened = os.open, os.stat(os.path.join(outside, "arm64")).st_ino, []
def open_fd(*args, **kwargs):
    fd = original_open(*args, **kwargs)
    if os.fstat(fd).st_ino == outside_inode: outside_opened.append(True)
    return fd
os.open = open_fd
inode = os.stat(inside).st_ino
original_readlink = os.readlink
changed = False
copied = []
def readlink(name, *, dir_fd=None):
    global changed
    if not changed and schedule == "symlink-aba" and name == "alias" and dir_fd is not None:
        changed = True
        held = os.path.join(outside, "held-alias")
        os.rename(name, held, src_dir_fd=dir_fd)
        try:
            os.symlink("b.txt", name, dir_fd=dir_fd)
            return original_readlink(name, dir_fd=dir_fd)
        finally:
            os.unlink(name, dir_fd=dir_fd)
            os.rename(held, name, dst_dir_fd=dir_fd)
    return original_readlink(name, dir_fd=dir_fd)
os.readlink = readlink
def replace():
    global changed
    changed = True
    target = os.path.join(inside, "arm64") if schedule == "after-classification" else inside
    os.rename(target, target + "-held")
    os.symlink(os.path.join(outside, "arm64") if schedule == "after-classification" else outside, target)
def info(name, *args, **kwargs):
    result = original_stat(name, *args, **kwargs)
    if not changed and schedule == "before-open" and result.st_ino == inode: replace()
    return result
def scan(fd):
    if not changed and schedule == "before-scan" and os.fstat(fd).st_ino == inode: replace()
    return original_scan(fd)
def run(args, **kwargs):
    result = original_run(args, **kwargs)
    if not changed and schedule == "after-classification" and args[0] == "/usr/bin/file": replace()
    return result
def copy(source, destination, *args):
    original_copy(source, destination, *args)
    destination.flush()
    if destination.name.endswith("/images/arm64"):
        with open(destination.name, "rb") as output: copied.append(output.read().hex())
os.stat, os.scandir, subprocess.run, shutil.copyfileobj = info, scan, run, copy
@atexit.register
def report():
    record(changed=changed, copied=copied, outsideOpened=outside_opened)
`,
      );
      expect(evidence).toMatchObject({
        changed: true,
        outsideOpened: [],
        copied:
          schedule === "before-open" || schedule === "symlink-aba"
            ? []
            : [fixture.binaries.arm64.toString("hex")],
      });
      expectUnpublished(fixture, result, /Inventory|directory|symbolic link/i);
      expect(readFileSync(path.join(outside, "arm64"))).toEqual(outsideBytes);
      if (schedule === "symlink-aba") {
        expect(snapshot(fixture.source)).toEqual(before);
        expect(readlinkSync(fixture.at("alias"))).toBe("a.txt");
        expect(lstatSync(fixture.at("alias")).ino).toBe(aliasInode);
      }
    },
  );

  materializations(
    "rejects in-place source mutation restored after lipo before native omission",
    async (fixture) => {
      const target = fixture.at("images/arm64");
      const replacement = path.join(fixture.root, "replacement");
      await write(replacement, fixture.binaries.x86_64);
      const before = snapshot(fixture.source);
      const { result, evidence } = await observeMaterialization(
        fixture,
        `
target = ${JSON.stringify(target)}
with open(target, "rb") as stream: original = stream.read()
with open(${JSON.stringify(replacement)}, "rb") as stream: replacement = stream.read()
original_info = os.stat(target)
original_run, schedule = subprocess.run, []
def run(args, **kwargs):
    result = original_run(args, **kwargs)
    fds = kwargs.get("pass_fds", ())
    if any(os.fstat(fd).st_ino == original_info.st_ino for fd in fds):
        if args[0] == "/usr/bin/file" and not schedule:
            with open(target, "wb") as stream: stream.write(replacement)
            schedule.append("replaced after file classification")
        elif args[0] == "/usr/bin/lipo":
            assert result.stdout == ("Non-fat file: " + args[-1] + " is architecture: x86_64\\n").encode(), result.stdout
            schedule.append("lipo observed x86_64")
            with open(target, "wb") as stream: stream.write(original)
            os.utime(target, ns=(original_info.st_atime_ns, original_info.st_mtime_ns))
            schedule.append("restored before omission")
    return result
subprocess.run = run
@atexit.register
def report():
    current = os.stat(target)
    record(schedule=schedule, sameInode=current.st_ino == original_info.st_ino,
           changedCtime=current.st_ctime_ns != original_info.st_ctime_ns,
           sameMtime=current.st_mtime_ns == original_info.st_mtime_ns)
`,
      );
      expect(evidence).toMatchObject({
        schedule: [
          "replaced after file classification",
          "lipo observed x86_64",
          "restored before omission",
        ],
        sameInode: true,
        changedCtime: true,
        sameMtime: true,
      });
      expect(snapshot(fixture.source)).toEqual(before);
      expectUnpublished(fixture, result);
    },
  );

  materializations(
    "bounds native batches and rewinds retained handles after real classifier reads",
    async (fixture) => {
      for (let index = 0; index < 130; index++) {
        await fixture.put(`native-${index}`, fixture.binaries.arm64);
        await fixture.put(`resource-${index}.js`, "// ordinary resource\n");
      }
      const before = snapshot(fixture.source);
      const { result, evidence } = await observeMaterialization(
        fixture,
        `
original_run = subprocess.run
batches = []
def run(args, **kwargs):
    result = original_run(args, **kwargs)
    fds = kwargs.get("pass_fds", ())
    if args[0] == "/usr/bin/file": batches.append(len(fds))
    for fd in fds: os.lseek(fd, 0, os.SEEK_END)
    return result
subprocess.run = run
@atexit.register
def report():
    record(batchCount=len(batches), maxBatch=max(batches), classified=sum(batches))
`,
      );
      expectExit(result);
      expect(snapshot(fixture.destination)).toEqual(
        before.filter((entry) => entry.path !== "images/elf"),
      );
      expect(snapshot(fixture.source)).toEqual(before);
      expect(evidence.batchCount).toBeLessThanOrEqual(3);
      expect(evidence.maxBatch).toBeLessThanOrEqual(64);
      expect(evidence.classified).toBe(133);
    },
  );

  materializations(
    "rejects special input files without blocking or publishing",
    async (fixture) => {
      await fixture.tool("/usr/bin/mkfifo", [fixture.at("fifo")]);
      const result = await fixture.run();
      expectUnpublished(fixture, result, "Unsupported runtime filesystem entry");
    },
  );

  cases(
    "feeds the freshly derived universal runtime to the real portable consumer",
    async (mac) => {
      const harness = await artifactFixture(mac);
      const runtime = harness.at("Contents/Resources/runtime");
      const canonical = path.join(harness.home, "canonical");
      await rename(runtime, canonical);
      await write(path.join(canonical, "nested/win32/README.md"), "Windows source is retained\n");
      await write(path.join(canonical, "nested/win32/foreign.node"), harness.binaries.pe);
      const before = snapshot(canonical);
      expectExit(
        await mac.run(
          "/usr/bin/python3",
          ["-B", materializer, canonical, runtime, path.dirname(runtime), "arm64,x86_64"],
          {
            encoding: "utf8",
            env: { HOME: harness.home, TMPDIR: harness.home, PATH: systemPath },
          },
        ),
      );
      expect(snapshot(canonical)).toEqual(before);
      expect(snapshot(runtime)).toEqual(
        before.filter(({ path: name }) => name !== "nested/win32/foreign.node"),
      );
      const result = expectExit(await harness.verify());
      expect(result.stdout).toContain("Elevation artifact verified");
    },
  );
});

describe("Mac app runtime publication", () => {
  baseIt("preserves the default build-time installer Node version", () => {
    const { root, at, put, link, run } = scriptFixture("version");
    put(
      "scripts/lib/desktop-runtime-plugins.mjs",
      'if (process.argv[2] === "plan") console.log(JSON.stringify({releaseTag: "v2026.10.2", pluginIds: []}));',
    );
    link(process.execPath, "bin/node");
    put("scripts/stage-mac-runtime.sh", readFileSync("scripts/stage-mac-runtime.sh"));
    put(
      "scripts/package-openclaw-for-docker.mjs",
      `import fs from "node:fs";
const file = process.argv[process.argv.indexOf("--output-dir") + 1] + "/openclaw.tgz";
fs.writeFileSync(file, "fixture");
console.log(file);
`,
    );
    // Stop at the download boundary after the real installer resolves its
    // version. No downloads, app signing, service control, or native build.
    put(
      "scripts/install-cli.sh",
      `${readStandaloneInstaller(process.cwd(), "install-cli.sh")}
install_node() {
  printf '%s\\n' "$NODE_VERSION" "$DEFAULT_NODE_VERSION" "$NODE_VERSION_REQUESTED" "\${OPENCLAW_CONFIG_PATH:-}" "\${OPENCLAW_GATEWAY_TOKEN:-}"
  exit 77
}
`,
    );
    const result = run([at("scripts/stage-mac-runtime.sh"), at("runtime"), "arm64"], {
      TMPDIR: root,
      PATH: `${at("bin")}:/usr/bin:/bin`,
      OPENCLAW_CONFIG_PATH: "/fixture/operator-config",
      OPENCLAW_GATEWAY_TOKEN: "synthetic-isolation-sentinel",
    });
    expect(result.status, result.stderr).toBe(77);
    const [selected, defaultVersion, requested, config, token] = result.stdout.split("\n");
    expect(selected).toBe(defaultVersion);
    expect(requested).toBe("0");
    expect(config).toBe("");
    expect(token).toBe("");
    expect(existsSync(path.join(root, "runtime"))).toBe(false);
  });

  baseIt
    .skipIf(process.platform !== "darwin")
    .each(["sign", "runtime", "seal", "stage", "success"])(
    "publishes only a verified replacement (%s)",
    (failure) => {
      const { root, at, put, bash } = scriptFixture("publication");
      const target = at("OpenClaw.app");
      const staged = at("candidate.app");
      put("OpenClaw.app/runtime", "old signed runtime");
      put("candidate.app/runtime", "new signed runtime");
      const packageScript = readFileSync("scripts/package-mac-app.sh", "utf8");
      const publication = packageScript.slice(
        packageScript.indexOf('if [[ -n "${SIGN_IDENTITY:-}" ]]'),
      );
      put(
        "candidate.app/Contents/Resources/runtime/bin/bun",
        `#!/bin/bash\nexit ${failure === "runtime" ? 6 : 0}\n`,
        0o755,
      );
      put(
        "scripts/codesign-mac-app.sh",
        `#!/bin/bash\nexit ${failure === "sign" ? 9 : 0}\n`,
        0o755,
      );
      const result = bash(
        `
      set -euo pipefail
      source scripts/lib/mac-app-bundle.sh
      ROOT_DIR=${quote(root)}
      APP_ROOT=${quote(staged)}
      APP_STAGE_DIR=${quote(root)}
      BUILD_ARCHS=(${process.arch === "arm64" ? "arm64" : "x86_64"})
      APP_DESTINATION=${quote(target)}
      codesign_calls=0
      codesign() {
        codesign_calls=$((codesign_calls + 1))
        if [[ ${quote(failure)} == seal && "$codesign_calls" -eq 2 ]]; then return 1; fi
        return 0
      }
      stop_packaged_app_if_running() { :; }
      mv() {
        if [[ "$1" == "$APP_ROOT" && ${quote(failure)} == stage ]]; then return 7; fi
        command mv "$@"
      }
      ${publication}
    `,
      );
      expect(result.status, result.stderr).toBe(
        failure === "success" ? 0 : failure === "runtime" ? 6 : failure === "sign" ? 9 : 1,
      );
      expect(readFileSync(path.join(target, "runtime"), "utf8")).toBe(
        failure === "success" ? "new signed runtime" : "old signed runtime",
      );
    },
  );

  baseIt(
    "provisions packages without invoking the service owner or changing operator state",
    () => {
      const { at, put, link, bash } = scriptFixture("provision");
      const home = at("home");
      const prefix = at("private");
      const sentinel = "operator/.openclaw/state/sentinel";
      mkdirSync(home);
      put(sentinel, "operator-owned");
      const nodeDir = path.join(prefix, "tools", "node-v24.22.1");
      // Only npm/network is replaced. The real install_openclaw implementation
      // must remain a provision-only seam even when a loaded Gateway is reported.
      link(testNodeExecPath, "private/tools/node-v24.22.1/bin/node");
      put(
        "private/tools/node-v24.22.1/bin/npm",
        `#!/bin/bash
case "$1" in
  --version) echo 11.15.0 ;;
  config) echo null ;;
  install)
    mkdir -p "$HOME/../private/tools/node-v24.22.1/lib/node_modules/openclaw/dist"
    touch "$HOME/../private/tools/node-v24.22.1/lib/node_modules/openclaw/dist/entry.js"
    ;;
  *) exit 4 ;;
esac
`,
        0o755,
      );
      const calls = at("service-calls");
      const result = bash(
        `
      set -euo pipefail
      source scripts/install-cli.sh
      PREFIX=${quote(prefix)}
      OPENCLAW_VERSION=/fixture/openclaw.tgz
      is_gateway_daemon_loaded() { echo loaded >> ${quote(calls)}; return 0; }
      refresh_gateway_service_if_loaded() { echo refresh >> ${quote(calls)}; }
      install_openclaw
      test -f "$(node_dir)/lib/node_modules/openclaw/dist/entry.js"
    `,
        {
          HOME: home,
          PATH: `${path.join(nodeDir, "bin")}:/usr/bin:/bin`,
          OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(calls)).toBe(false);
      expect(readFileSync(at(sentinel), "utf8")).toBe("operator-owned");
    },
  );
});

describe.runIf(process.platform === "darwin")("Mac runtime portability inventory", () => {
  const it = createMacScriptTest();
  const cases = createMacCases(it, (mac) => mac);
  it("audits supported thin and fat formats through real otool", async () => {
    const root = temps.make("openclaw-portability-native-");
    const { audit, machoFixture } = await portabilityFixture(root);
    for (const bits of [32, 64]) {
      for (const little of [false, true]) {
        for (const fat of [false, true]) {
          if (fat && little) {
            continue;
          }
          const filename = path.join(root, `${bits}-${little}-${fat} addon`);
          writeFileSync(filename, machoFixture(bits, little, fat, 6));
        }
      }
    }
    symlinkSync("bun", path.join(root, "internal-link"));
    expect(audit()).toBe(7);
  });

  cases.for([
    "Java",
    "fat32 archive",
    "fat64 archive",
    "thin object",
    "fat32 object",
    "fat64 object",
  ])("preserves %s resources without treating them as loadable images", async (kind, mac) => {
    const { nativeObjectFixture, universalArchiveFixture } =
      await import("../helpers/mac-native.js");
    const parent = mac.createTempDir("openclaw-portability-resource-");
    const root = path.join(parent, "runtime");
    mkdirSync(root);
    const { audit } = await portabilityFixture(root);
    const filename = path.join(root, "opaque-resource");
    const format = kind.startsWith("fat32") ? "fat32" : kind.startsWith("fat64") ? "fat64" : "thin";
    const inputs = path.join(parent, "resource-inputs");
    const bytes =
      kind === "Java"
        ? Buffer.from("cafebabe0000003d0001", "hex")
        : kind.endsWith("archive")
          ? await universalArchiveFixture(inputs, format === "fat64", false, mac)
          : await nativeObjectFixture(inputs, format, mac);
    writeFileSync(filename, bytes);
    expect(audit()).toBe(1);
    expect(readFileSync(filename)).toEqual(bytes);
  });

  it.each(["parent-link", "parent-directory", "root", "new-hardlink"])(
    "rejects changed child lookup bindings and closes handles (%s)",
    (mutation) => {
      const root = temps.make("openclaw-native-child-replacement-");
      pythonInventory(
        root,
        "child-binding-rejected",
        `
source, outside = root / 'source', root / 'outside'
(source / 'Library').mkdir(parents=True)
(source / 'Library/addon').write_text('original')
outside.mkdir(); (outside / 'addon').write_text('outside')
with api['open_native_inventory_tree'](source) as tree:
    list(tree.entries())
    parent, name = ('Library',), 'addon'
    mode = sys.argv[2]
    if mode in ('parent-link', 'parent-directory'):
        (source / 'Library').rename(root / 'held')
        if mode == 'parent-link': (source / 'Library').symlink_to(outside)
        else:
            (source / 'Library').mkdir()
            (source / 'Library/addon').write_text('replacement')
    elif mode == 'root':
        source.rename(root / 'held')
        source.mkdir()
    else:
        os.link(source / 'Library/addon', source / 'new-alias')
        parent, name = (), 'new-alias'
    with rejects((OSError, ValueError)): tree.lstat_child(parent, name)
    if mode == 'root':
        with rejects((OSError, ValueError)): tree.validate()
assert (outside / 'addon').read_text() == 'outside'
`,
        mutation,
      );
    },
  );

  it.each(["namespace-root", "namespace-nested", "incomplete"])(
    "rejects incomplete or changed namespaces (%s)",
    (mode) => {
      const root = temps.make("openclaw-native-complete-audit-");
      const directory = path.join(
        root,
        "source",
        ...(mode === "namespace-nested" ? ["child"] : []),
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "resource"), "resource");
      pythonInventory(
        root,
        "complete-audit-rejected",
        `
root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
source = root / 'source'
directory = source / 'child' if mode == 'namespace-nested' else source
resource = directory / 'resource'
original = resource.read_bytes()
with api['open_native_inventory_tree'](source) as tree:
    iterator = tree.entries()
    records = [next(iterator)]
    if mode.startswith('namespace-'):
        if mode == 'namespace-nested': records.append(next(iterator))
        before = directory.stat()
        resource.rename(root / 'hidden')
        records.extend(iterator)
        assert not any(entry.parts and entry.parts[-1] == 'resource' for entry in records)
        (root / 'hidden').rename(resource)
        assert api['content_identity'](directory.stat()) != api['content_identity'](before)
    with rejects_message(ValueError, 'complete' if mode == 'incomplete' else 'changed'): tree.validate()
assert resource.read_bytes() == original
`,
        mode,
      );
    },
  );

  it.each(["stable", "ancestor-symlink", "ancestor-directory", "root-swap"])(
    "audits deep trees with linear opens and bounded handles (%s)",
    (mode) => {
      const root = temps.make("openclaw-native-audit-depth-");
      pythonInventory(
        root,
        "bounded-audit-ok",
        `
root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
source, outside = root / 'source', root / 'outside'
source.mkdir(); outside.mkdir()
(outside / 'a-resource').write_text('outside')
folder = source
for _ in range(12):
    folder = folder / 'branch'
    folder.mkdir()
    (folder / 'a-resource').write_text('resource')
    (folder / 'z-empty').mkdir()
original_open, original_stat = os.open, os.stat
opens, peak, swapped = 0, len(initial_fds), False
def opened(name, flags, *args, **kwargs):
    global opens, peak
    fd = original_open(name, flags, *args, **kwargs)
    opens += bool(flags & os.O_DIRECTORY)
    peak = max(peak, len(os.listdir('/dev/fd')))
    assert api['identity'](os.fstat(fd)) != api['identity'](original_stat(outside)), 'Opened external directory'
    return fd
def stated(name, *args, **kwargs):
    global swapped
    info = original_stat(name, *args, **kwargs)
    if mode != 'stable' and name == 'a-resource' and not swapped:
        swapped = True
        replaced = source if mode == 'root-swap' else source / 'branch'
        replaced.rename(root / 'held')
        if mode == 'ancestor-directory': replaced.mkdir()
        else: replaced.symlink_to(outside)
    return info
with api['open_native_inventory_tree'](source) as tree:
    entries = list(tree.entries())
    directories = sum(isinstance(entry, api['NativeInventoryDirectory']) for entry in entries)
    depth = max(len(entry.parts) for entry in entries)
    os.open, os.stat = opened, stated
    try:
        try: tree.validate()
        except (OSError, ValueError): assert mode != 'stable'
        else:
            assert mode == 'stable', 'Audit accepted a replaced ancestor'
            assert opens <= directories * 3, (opens, directories)
        assert peak <= len(initial_fds) + depth + 3, (peak, depth)
    finally:
        os.open, os.stat = original_open, original_stat
assert swapped == (mode != 'stable')
assert (outside / 'a-resource').read_text() == 'outside'
`,
        mode,
      );
    },
  );

  it.each(["finish", "abort"])(
    "restores classifier cursors and closes borrowed streams on %s",
    async (mode) => {
      const { machoFixture } = await import("../helpers/mac-native.js");
      const root = temps.make("openclaw-native-borrow-");
      mkdirSync(path.join(root, "source"));
      writeFileSync(path.join(root, "source/a-native"), machoFixture());
      writeFileSync(path.join(root, "source/z-invalid"), machoFixture(32, true, true));
      pythonInventory(
        root,
        "borrowed-streams-closed",
        `
source = root / 'source'
class CopyAborted(Exception): pass
borrowed = None
try:
    with api['open_native_inventory_tree'](source) as tree:
        iterator = tree.entries()
        for entry in iterator:
            if not isinstance(entry, api['NativeInventoryFile']): continue
            if borrowed is not None: assert borrowed.closed
            borrowed = entry.stream
            assert borrowed.tell() == 0
            borrowed.seek(7)
            if entry.parts == ('z-invalid',):
                with rejects(ValueError): api['classify_macho_candidates']([(borrowed, 'invalid')])
            else:
                assert api['classify_macho_candidates']([(borrowed, 'native')]) == [b'executable']
            assert borrowed.tell() == 7
            if sys.argv[2] == 'abort': raise CopyAborted()
        tree.validate()
except CopyAborted:
    assert sys.argv[2] == 'abort'
assert borrowed.closed
with rejects(ValueError): borrowed.fileno()
assert next(iterator, None) is None
with rejects(ValueError): tree.validate()
`,
        mode,
      );
    },
  );

  it.each(["file", "dangling"])("rejects %s symlinks outside the runtime", async (kind) => {
    const parent = temps.make("openclaw-portability-link-");
    const root = path.join(parent, "runtime");
    mkdirSync(root);
    const { audit } = await portabilityFixture(root);
    const external = path.join(parent, "external");
    if (kind === "file") {
      writeFileSync(external, "outside");
    }
    symlinkSync(external, path.join(root, "link"));
    expect(audit).toThrow(kind === "dangling" ? /ENOENT/ : /symlink escapes/);
  });

  it("does not borrow loader paths from a different architecture", async () => {
    const root = temps.make("openclaw-portability-slices-");
    const { audit, machoFixture } = await portabilityFixture(root);
    const slice = (cpu: number, subtype: number, folder: string) => {
      const header = machoFixture(64, true, false, 6);
      header.writeUInt32LE(cpu, 4);
      header.writeUInt32LE(subtype, 8);
      return nativeImage(
        header,
        loadCommand(0x8000001c, `@loader_path/${folder}`, 12),
        loadCommand(0xc, "@rpath/libdemo.dylib", 24),
      );
    };
    const slices = [slice(0x01000007, 3, "empty"), slice(0x0100000c, 0x80000002, "valid")] as const;
    const payload = Buffer.alloc(8192 + slices[1].length);
    payload.writeUInt32BE(0xcafebabf, 0);
    payload.writeUInt32BE(2, 4);
    for (const [index, bytes] of slices.entries()) {
      const record = 8 + index * 32;
      const offset = 4096 * (index + 1);
      payload.writeUInt32BE(bytes.readUInt32LE(4), record);
      payload.writeUInt32BE(bytes.readUInt32LE(8), record + 4);
      payload.writeBigUInt64BE(BigInt(offset), record + 8);
      payload.writeBigUInt64BE(BigInt(bytes.length), record + 16);
      payload.writeUInt32BE(12, record + 24);
      bytes.copy(payload, offset);
    }
    const addon = path.join(root, "addon");
    writeFileSync(addon, payload);
    mkdirSync(path.join(root, "empty"));
    mkdirSync(path.join(root, "valid"));
    writeFileSync(path.join(root, "valid/libdemo.dylib"), machoFixture(64, true, false, 6));
    expect(spawnSync("/usr/bin/lipo", ["-archs", addon]).status).toBe(0);
    expect(audit).toThrow(/Nonportable LC_LOAD_DYLIB/);
  });

  it.each([
    ["thin", "/usr/lib/libSystem.B.dylib"],
    ["thin", "/opt/homebrew/lib/nonportable.dylib"],
    ["thin", "/usr/lib/../../opt/homebrew/lib/nonportable.dylib"],
    ["thin", "@loader_path/../../outside.dylib"],
    ["fat64", "/usr/lib/libSystem.B.dylib"],
  ] as const)("audits load dependencies after inventory (%s, %s)", async (format, library) => {
    const root = temps.make("openclaw-portability-load-");
    const { audit, machoFixture } = await portabilityFixture(root);
    const addon = path.join(root, "addon");
    const thin = nativeImage(machoFixture(64, true, false, 6), loadCommand(0xc, library, 24));
    // On-disk fat headers are big endian; the arm64 slice is little endian.
    const payload =
      format === "fat64"
        ? Buffer.concat([machoFixture(64, false, true, 6).subarray(0, 4096), thin])
        : thin;
    if (format === "fat64") {
      payload.writeBigUInt64BE(BigInt(thin.length), 24);
    }
    writeFileSync(addon, payload);
    const load = spawnSync("/usr/bin/otool", ["-l", addon], { encoding: "utf8" });
    expect(load.status, load.stderr).toBe(0);
    expect(load.stdout).toContain(`name ${library} (offset 24)`);
    if (library === "/usr/lib/libSystem.B.dylib") {
      expect(audit()).toBe(2);
    } else {
      expect(audit).toThrow(/Nonportable LC_LOAD_DYLIB/);
    }
  });
});

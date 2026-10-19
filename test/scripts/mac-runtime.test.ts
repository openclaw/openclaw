// Exercise publication and provisioning boundaries without signing, service control, or operator state.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it as baseIt } from "vitest";
import { readStandaloneInstaller } from "../../scripts/lib/standalone-installers.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import "./mac-runtime-materialization.test-support.js";
import { createMacScriptTest } from "./mac-script-fixture.test-support.js";

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
  const prelude = `import os, pathlib, runpy, shutil, sys, unicodedata, unittest
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root = pathlib.Path(sys.argv[1])
rejects = unittest.TestCase().assertRaises
rejects_message = unittest.TestCase().assertRaisesRegex
`;
  const result = spawnSync("/usr/bin/python3", ["-B", "-c", prelude + program, root, ...args], {
    encoding: "utf8",
  });
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
      const nodeDir = path.join(prefix, "tools", "node-v24.21.0");
      // Only npm/network is replaced. The real install_openclaw implementation
      // must remain a provision-only seam even when a loaded Gateway is reported.
      link(testNodeExecPath, "private/tools/node-v24.21.0/bin/node");
      put(
        "private/tools/node-v24.21.0/bin/npm",
        `#!/bin/bash
case "$1" in
  --version) echo 11.15.0 ;;
  config) echo null ;;
  install)
    mkdir -p "$HOME/../private/tools/node-v24.21.0/lib/node_modules/openclaw/dist"
    touch "$HOME/../private/tools/node-v24.21.0/lib/node_modules/openclaw/dist/entry.js"
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

  it.for(["Java", "fat32 archive", "fat64 archive", "thin object", "fat32 object", "fat64 object"])(
    "preserves %s resources without treating them as loadable images",
    (kind, { mac }) =>
      mac.lifetime.run(async () => {
        const { nativeObjectFixture, universalArchiveFixture } =
          await import("../helpers/mac-native.js");
        const parent = mac.createTempDir("openclaw-portability-resource-");
        const root = path.join(parent, "runtime");
        mkdirSync(root);
        const { audit } = await portabilityFixture(root);
        const filename = path.join(root, "opaque-resource");
        const format = kind.startsWith("fat32")
          ? "fat32"
          : kind.startsWith("fat64")
            ? "fat64"
            : "thin";
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
      }),
  );

  it("looks up actual filesystem child names without following links or leaking handles", () => {
    const root = temps.make("openclaw-native-child-lookup-");
    pythonInventory(
      root,
      "child-lookup-ok",
      `
source = root / 'source'
(source / 'Library').mkdir(parents=True)
(source / 'Library/AddOn.node').write_text('resource')
(source / 'Café.txt').write_text('unicode resource')
special = 'slash' + chr(92) + chr(10) + 'name'
(source / special).write_text('literal name')
(root / 'outside').mkdir()
(root / 'outside/probe').write_text('outside')
(source / 'redirect').symlink_to('../outside')
initial_fds = set(os.listdir('/dev/fd'))
with api['open_native_inventory_tree'](source) as tree:
    entries = {entry.parts: entry for entry in tree.entries()}
    queries = [((), 'Library', ('Library',)), ((), 'library', ('Library',)),
               (('Library',), 'addon.node', ('Library', 'AddOn.node')),
               ((), unicodedata.normalize('NFD', 'Café.txt'), ('Café.txt',)),
               ((), special, (special,)), ((), 'redirect', ('redirect',))]
    for parent, name, canonical in queries:
        try: os.stat(source.joinpath(*parent, name), follow_symlinks=False)
        except FileNotFoundError:
            with rejects(FileNotFoundError): tree.lstat_child(parent, name)
        else:
            actual = tree.lstat_child(parent, name)
            assert api['content_identity'](actual) == api['content_identity'](entries[canonical].info)
    for name in ('', '.', '..', '/outside', 'redirect/probe', 'x' + chr(0)):
        with rejects(ValueError): tree.lstat_child((), name)
    with rejects(ValueError): tree.lstat_child(('redirect',), 'probe')
    tree.validate()
with rejects_message(ValueError, 'closed'): tree.lstat_child((), 'Library')
assert set(os.listdir('/dev/fd')) == initial_fds
print('child-lookup-ok')
`,
    );
  });

  it.each([
    "missing",
    "leaf-replacement",
    "parent-link",
    "parent-directory",
    "root",
    "new-hardlink",
  ])("rejects changed child lookup bindings and closes handles (%s)", (mutation) => {
    const root = temps.make("openclaw-native-child-replacement-");
    pythonInventory(
      root,
      "child-binding-rejected",
      `
source, outside = root / 'source', root / 'outside'
(source / 'Library').mkdir(parents=True)
(source / 'Library/addon').write_text('original')
outside.mkdir(); (outside / 'addon').write_text('outside')
initial_fds = set(os.listdir('/dev/fd'))
with api['open_native_inventory_tree'](source) as tree:
    list(tree.entries())
    parent, name = ('Library',), 'addon'
    mode = sys.argv[2]
    if mode == 'missing': (source / 'Library/addon').unlink()
    elif mode == 'leaf-replacement':
        (source / 'Library/addon').unlink()
        (source / 'Library/addon').symlink_to('../../outside/addon')
    elif mode in ('parent-link', 'parent-directory'):
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
assert set(os.listdir('/dev/fd')) == initial_fds
print('child-binding-rejected')
`,
      mutation,
    );
  });

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
initial_fds = set(os.listdir('/dev/fd'))
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
assert set(os.listdir('/dev/fd')) == initial_fds
print('complete-audit-rejected')
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
initial_fds = set(os.listdir('/dev/fd'))
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
assert set(os.listdir('/dev/fd')) == initial_fds
print('bounded-audit-ok')
`,
        mode,
      );
    },
  );

  it.each(["finish", "abort"])(
    "binds classify-and-copy to borrowed files and closes them on %s",
    async (mode) => {
      const { machoFixture } = await import("../helpers/mac-native.js");
      const root = temps.make("openclaw-native-borrow-");
      const source = path.join(root, "source");
      const outside = path.join(root, "outside");
      mkdirSync(path.join(source, "dir"), { recursive: true });
      mkdirSync(path.join(source, "empty"));
      mkdirSync(outside);
      writeFileSync(path.join(source, "dir", "native"), machoFixture());
      writeFileSync(path.join(outside, "native"), machoFixture(64, true, false, 6));
      writeFileSync(path.join(source, "resource.txt"), "ordinary resource");
      writeFileSync(
        path.join(source, "resource.class"),
        Buffer.from("cafebabe0000003d0001", "hex"),
      );
      writeFileSync(path.join(source, "invalid"), machoFixture(32, true, true));
      symlinkSync("../outside", path.join(source, "link"));
      expect(spawnSync("/usr/bin/mkfifo", [path.join(source, "fifo")]).status).toBe(0);
      pythonInventory(
        root,
        "held-file-copy-ok",
        `
source = root / 'source'
original = (source / 'dir/native').read_bytes()
resources = {('resource.txt',): b'ordinary resource', ('resource.class',): bytes.fromhex('cafebabe0000003d0001')}
initial_fds = set(os.listdir('/dev/fd'))
class CopyAborted(Exception): pass
borrowed = None
seen = []
try:
    with api['open_native_inventory_tree'](source) as tree:
        iterator = tree.entries()
        for entry in iterator:
            seen.append((type(entry).__name__, entry.parts))
            if isinstance(entry, api['NativeInventorySymlink']):
                assert entry.target == '../outside'
            if not isinstance(entry, api['NativeInventoryFile']): continue
            assert entry.stream.tell() == 0
            if entry.parts == ('dir', 'native'):
                borrowed = entry.stream
                os.rename(source / 'dir', root / 'retained')
                os.symlink(root / 'outside', source / 'dir')
                assert api['classify_macho_candidates']([(borrowed, 'native')]) == [b'executable']
                assert borrowed.tell() == 0
                with (root / 'copied-native').open('wb') as output:
                    shutil.copyfileobj(borrowed, output)
                assert (root / 'copied-native').read_bytes() == original
                if sys.argv[2] == 'abort': raise CopyAborted()
            else:
                assert borrowed.closed
                if entry.parts == ('invalid',):
                    entry.stream.seek(7)
                    with rejects(ValueError): api['classify_macho_candidates']([(entry.stream, 'invalid')])
                    assert entry.stream.tell() == 7
                    continue
                if entry.header in api['MACHO_MAGICS']:
                    assert api['classify_macho_candidates']([(entry.stream, 'resource')]) == [None]
                assert entry.stream.tell() == 0
                assert entry.stream.read() == resources[entry.parts]
        assert ('NativeInventoryDirectory', ('empty',)) in seen
        assert ('NativeInventorySpecial', ('fifo',)) in seen
        assert ('NativeInventorySymlink', ('link',)) in seen
        try: tree.validate()
        except NotADirectoryError as error: assert error.filename == 'dir'
        except ValueError as error: assert 'changed' in str(error)
        else: raise AssertionError('Replaced pathname was accepted')
except CopyAborted:
    assert sys.argv[2] == 'abort'
assert borrowed.closed
with rejects(ValueError): borrowed.fileno()
assert next(iterator, None) is None
with rejects(ValueError): tree.validate()
assert set(os.listdir('/dev/fd')) == initial_fds
print('held-file-copy-ok')
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
    ["thin", "/System/Library/../../opt/homebrew/lib/nonportable.dylib"],
    ["thin", "@loader_path/../../outside.dylib"],
    ["fat64", "/usr/lib/libSystem.B.dylib"],
    ["fat64", "/opt/homebrew/lib/nonportable.dylib"],
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

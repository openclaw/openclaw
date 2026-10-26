import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectBunCliLauncher as inspect,
  installBunCliLauncher as install,
  parseBunCliLauncher as parse,
  renderBunCliLauncher as render,
} from "../../scripts/lib/bun-cli-launcher.mjs";
import { installPackageBunCliLauncher as postinstall } from "../../scripts/postinstall-bun-cli-launcher.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const lifecycle = vi.hoisted(() => ({
  resolveBinDir: vi.fn<() => string>(),
  probeNode:
    vi.fn<
      typeof import("../../scripts/preinstall-package-manager-warning.mjs").probePackageCliNodeRuntime
    >(),
}));

vi.mock(import("../../scripts/lib/bun-cli-launcher.mjs"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveBunGlobalBinDir: lifecycle.resolveBinDir,
}));

vi.mock(import("../../scripts/preinstall-package-manager-warning.mjs"), async (importOriginal) => ({
  ...(await importOriginal()),
  probePackageCliNodeRuntime: lifecycle.probeNode,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const read = (path: string) => fs.readFileSync(path, "utf8");
const parseInstalled = (target: { path: string }) => parse(read(target.path));
const execute = (target: { path: string }, args: string[] = [], input?: string, cwd?: string) =>
  spawnSync(target.path, args, { env: { PATH: "" }, encoding: "utf8", input, cwd });
type LifecycleOptions = {
  bunVersion?: string;
  agent?: string;
  marker?: string;
  persistentNode?: boolean;
  windows?: boolean;
};
const packageParams = (target: ReturnType<typeof fixture>, options: LifecycleOptions = {}) => ({
  packageRoot: target.packageRoot,
  bunVersion: options.bunVersion ?? "1.4.4",
  env: {
    npm_config_user_agent: options.agent ?? "bun/1.4.4",
    OPENCLAW_PACKAGE_BUN_LAUNCHER: options.marker ?? target.bunPath,
  },
});

function fixture(character = "", field: "bunPath" | "entryPath" = "entryPath", globalLink = false) {
  const root = tempDirs.make("openclaw-bun-launcher-");
  const quoted = (name: string, value: string) => join(root, `${name} 'quoted' ${value}(space)`);
  const packageRoot = quoted("package", field === "entryPath" ? character : "");
  const binDir = join(root, "global-bin");
  const bunPath = quoted("runtime", field === "bunPath" ? character : "");
  fs.mkdirSync(packageRoot);
  fs.mkdirSync(binDir);
  const entryPath = join(packageRoot, "openclaw.mjs");
  fs.writeFileSync(entryPath, "#!/usr/bin/env node\n// Installed entry stays unchanged.\n");
  const path = join(binDir, "openclaw");
  if (globalLink) {
    fs.symlinkSync(entryPath, path);
  }
  lifecycle.resolveBinDir.mockReturnValue(binDir);
  return { root, packageRoot, binDir, bunPath, entryPath, path };
}

describe.skipIf(process.platform === "win32")("POSIX Bun CLI launcher", () => {
  it("executes quoted absolute paths with exact argv, exit status, and termination signal", () => {
    const target = fixture();
    fs.symlinkSync(process.execPath, target.bunPath);
    fs.writeFileSync(
      target.entryPath,
      `import { readFileSync } from "node:fs";
if (process.argv[2] === "signal") process.kill(process.pid, "SIGTERM");
else if (process.argv[2] === "stdin") process.stdout.write(readFileSync(0));
else { process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 23; }
`,
    );
    install(target);

    const argv = [
      "",
      "two words",
      "'quoted'",
      '"double"',
      "$(literal)",
      "`literal`",
      "a\\path",
      "line\nbreak",
      "--flag=value",
    ];
    const result = execute(target, argv);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ stderr: "", status: 23, signal: null });
    expect(JSON.parse(result.stdout)).toEqual(argv);
    const signaled = execute(target, ["signal"]);
    expect(signaled.error).toBeUndefined();
    expect(signaled).toMatchObject({ status: null, signal: "SIGTERM" });
    const input = execute(target, ["stdin"], "original stdin\n");
    expect(input, input.stderr).toMatchObject({ status: 0, stdout: "original stdin\n" });
  });

  it("preserves literal path bytes after released relocation", () => {
    const component = '$store `literal` "double" back\\slash apostrophe\'s two words *glob*';
    const target = fixture(component, "bunPath");
    // A POSIX argv probe avoids Node's separate ESM restriction on backslash filenames.
    fs.writeFileSync(target.bunPath, '#!/bin/sh\n[ -f "$1" ] || exit 98\nprintf \'%s\\0\' "$@"\n', {
      mode: 0o755,
    });
    const content = render(target);
    const liveRoot = join(target.root, `live ${component}`);
    // Published 2026.9.7 relocates raw sourceRoot + '/' bytes before retiring staging.
    fs.writeFileSync(target.path, content.replaceAll(`${target.packageRoot}/`, `${liveRoot}/`), {
      mode: 0o755,
    });
    fs.renameSync(target.packageRoot, liveRoot);

    const args = ["two words", "$literal", ""];
    const result = execute(target, args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\0")).toEqual([join(liveRoot, "openclaw.mjs"), ...args, ""]);
    expect(parseInstalled(target)).toEqual({
      bunPath: target.bunPath,
      entryPath: join(liveRoot, "openclaw.mjs"),
    });
  });

  it.each(["split", "duplicate"])("rejects %s data records before execution", (kind) => {
    const target = fixture();
    fs.symlinkSync(process.execPath, target.bunPath);
    fs.writeFileSync(target.entryPath, 'console.log("must not execute");');
    let content = render(target);
    if (kind === "split") {
      const truncated = join(target.root, "truncated-entry");
      fs.writeFileSync(truncated, 'require("node:fs").writeFileSync("runtime-executed", "bad");');
      const liveRoot = `${truncated}\nprintf injected > data-executed\nsuffix`;
      content = content.replaceAll(`${target.packageRoot}/`, `${liveRoot}/`);
      fs.renameSync(target.packageRoot, liveRoot);
    } else {
      const record = `#openclaw-entry=${target.entryPath}`;
      content = content.replace(record, `${record}\n${record}`);
    }
    fs.writeFileSync(target.path, content, { mode: 0o755 });

    const result = execute(target, [], undefined, target.root);
    expect(result).toMatchObject({ status: 127, stdout: "" });
    expect(result.stderr).toContain("openclaw: Bun launcher target not found");
    expect(fs.existsSync(join(target.root, "runtime-executed"))).toBe(false);
    expect(fs.existsSync(join(target.root, "data-executed"))).toBe(false);
    expect(parse(content)).toBeNull();
  });

  it.each(["runtime", "entry"])("explains a missing %s without executing", (missing) => {
    const target = fixture();
    if (missing === "entry") {
      fs.symlinkSync(process.execPath, target.bunPath);
      fs.unlinkSync(target.entryPath);
    }
    install(target);
    const result = execute(target);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("openclaw: Bun launcher target not found");
    expect(result.stderr).toContain('Run "openclaw doctor" with Bun to repair.');
  });

  it("installs and repairs its missing command without modifying the entry", () => {
    const target = fixture();
    const entry = read(target.entryPath);
    expect(inspect(target).state).toBe("missing");

    expect(install(target)).toEqual({ path: target.path, state: "current" });
    const installed = fs.lstatSync(target.path);
    expect(installed.isSymbolicLink()).toBe(false);
    expect(installed.mode & 0o777).toBe(0o755);
    expect(read(target.entryPath)).toBe(entry);
    expect(parseInstalled(target)).toEqual({
      bunPath: target.bunPath,
      entryPath: target.entryPath,
    });
    install(target);
    expect(fs.statSync(target.path)).toMatchObject({
      ino: installed.ino,
      mtimeMs: installed.mtimeMs,
    });
    expect(fs.readdirSync(target.binDir)).toEqual(["openclaw"]);
    const updated = { ...target, bunPath: join(target.root, "new-bun") };
    expect(inspect(updated).state).toBe("stale");
    install(updated);
    expect(parseInstalled(target)?.bunPath).toBe(updated.bunPath);
    fs.chmodSync(target.path, 0o644);
    expect(inspect(updated).state).toBe("stale");
    install(updated);
    expect(inspect(updated).state).toBe("current");
  });

  it.each(["symlink", "directory", "edited launcher", "foreign package"])(
    "preserves a conflicting %s",
    (kind) => {
      const target = fixture();
      const otherEntry = join(target.root, "other-command");
      fs.writeFileSync(otherEntry, "other owner");
      const content =
        kind === "foreign package"
          ? render({ ...target, entryPath: join(target.root, "another-package/openclaw.mjs") })
          : `${render(target)}echo extra\n`;
      if (kind === "symlink") {
        fs.symlinkSync(otherEntry, target.path);
      } else if (kind === "directory") {
        fs.mkdirSync(target.path);
      } else {
        fs.writeFileSync(target.path, content);
        if (kind === "edited launcher") {
          expect(parse(content)).toBeNull();
        }
      }

      expect(inspect(target).state).toBe("conflict");
      expect(() => install(target)).toThrow("left unchanged");
      expect(read(otherEntry)).toBe("other owner");
      if (kind === "symlink") {
        expect(fs.readlinkSync(target.path)).toBe(otherEntry);
      } else if (kind === "directory") {
        expect(fs.lstatSync(target.path).isDirectory()).toBe(true);
      } else {
        expect(read(target.path)).toBe(content);
      }
      expect(fs.readdirSync(target.binDir)).toEqual(["openclaw"]);
    },
  );
});

it.each(["relative/bun", "/runtime\0next"])("rejects unstable launcher paths: %j", (invalid) => {
  for (const target of [
    { bunPath: invalid, entryPath: "/pkg/openclaw.mjs" },
    { bunPath: "/runtime/bun", entryPath: invalid },
  ]) {
    expect(() => render(target)).toThrow("absolute, single-line");
  }
});

describe.skipIf(process.platform === "win32")("packaged Bun launcher lifecycle", () => {
  beforeEach(() => {
    lifecycle.resolveBinDir.mockReset();
    lifecycle.probeNode.mockReset().mockReturnValue({
      version: "24.22.0",
      execPath: "/runtime/bun",
      bunVersion: "1.4.4",
    });
  });

  it("finishes only its existing global link and refreshes it after a Bun update", () => {
    const target = fixture("", "entryPath", true);
    const params = packageParams(target);
    postinstall(params);
    expect(inspect(target).state).toBe("current");
    const updatedBun = join(target.root, "updated-bun");
    params.env.OPENCLAW_PACKAGE_BUN_LAUNCHER = updatedBun;
    postinstall(params);
    expect(parseInstalled(target)?.bunPath).toBe(updatedBun);
  });

  it.each([
    ["\n", "a newline"],
    ["\r", "a carriage return"],
  ])("preserves symlinks with %j paths", (character, label) => {
    for (const field of ["bunPath", "entryPath"] as const) {
      const target = fixture(character, field, true);
      const reason = `${field === "bunPath" ? "Bun executable path" : "Install path"} contains ${label}, which cannot be stored in a launcher data line`;

      expect(() => render(target)).toThrow(reason);
      expect(() => postinstall(packageParams(target))).not.toThrow();
      expect(fs.readlinkSync(target.path)).toBe(target.entryPath);
      expect(fs.readdirSync(target.binDir)).toEqual(["openclaw"]);
    }
  });

  it.each(["missing", "foreign"])("does not claim a %s global command", (kind) => {
    const target = fixture();
    if (kind === "foreign") {
      fs.writeFileSync(target.path, "other owner");
    }
    postinstall(packageParams(target));
    expect(fs.readdirSync(target.binDir)).toEqual(kind === "missing" ? [] : ["openclaw"]);
    if (kind === "foreign") {
      expect(read(target.path)).toBe("other owner");
    }
  });

  it.each<[string, LifecycleOptions]>([
    ["Node runtime", { bunVersion: "" }],
    ["npm install", { agent: "npm/11.0.0" }],
    ["missing marker", { marker: "" }],
    ["relative marker", { marker: "bun" }],
    ["persistent Node", { persistentNode: true }],
    ["Windows", { windows: true }],
  ])("leaves the Node-shebang bin untouched for %s", (_scenario, options) => {
    const target = fixture("", "entryPath", true);
    if (options.persistentNode) {
      lifecycle.probeNode.mockReturnValue({
        version: "24.22.0",
        execPath: "/runtime/node",
        bunVersion: null,
      });
    }
    if (options.windows) {
      vi.stubGlobal("process", { platform: "win32" });
    }
    try {
      postinstall(packageParams(target, options));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fs.readlinkSync(target.path)).toBe(target.entryPath);
    if (options.windows) {
      expect(lifecycle.probeNode).not.toHaveBeenCalled();
    }
    expect(lifecycle.resolveBinDir).not.toHaveBeenCalled();
  });
});

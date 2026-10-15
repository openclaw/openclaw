import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectBunCliLauncher,
  installBunCliLauncher,
  parseBunCliLauncher,
  renderBunCliLauncher,
} from "../../scripts/lib/bun-cli-launcher.mjs";
import { installPackageBunCliLauncher } from "../../scripts/postinstall-bun-cli-launcher.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const lifecycle = vi.hoisted(() => ({
  resolveBinDir: vi.fn<() => string>(),
  probeNode: vi.fn<() => { bunVersion: string | null } | null>(),
}));

vi.mock("../../scripts/lib/bun-cli-launcher.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/bun-cli-launcher.mjs")>()),
  resolveBunGlobalBinDir: lifecycle.resolveBinDir,
}));

vi.mock("../../scripts/preinstall-package-manager-warning.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/preinstall-package-manager-warning.mjs")
  >()),
  probePackageCliNodeRuntime: lifecycle.probeNode,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const unsupportedPathCharacters = [
  ["\n", "a newline"],
  ["\r", "a carriage return"],
] as const;

function fixture(character = "", field: "bunPath" | "entryPath" = "entryPath") {
  const root = tempDirs.make("openclaw-bun-launcher-");
  const packageRoot = join(
    root,
    `package 'quoted' ${field === "entryPath" ? character : ""}(space)`,
  );
  const binDir = join(root, "global-bin");
  const bunPath = join(root, `runtime 'quoted' ${field === "bunPath" ? character : ""}(space)`);
  mkdirSync(packageRoot);
  mkdirSync(binDir);
  const entryPath = join(packageRoot, "openclaw.mjs");
  writeFileSync(entryPath, "#!/usr/bin/env node\n// Installed entry stays unchanged.\n");
  return { root, packageRoot, binDir, bunPath, entryPath, path: join(binDir, "openclaw") };
}

describe.skipIf(process.platform === "win32")("POSIX Bun CLI launcher", () => {
  it("executes quoted absolute paths with exact argv, exit status, and termination signal", () => {
    const target = fixture();
    symlinkSync(process.execPath, target.bunPath);
    writeFileSync(
      target.entryPath,
      [
        'import { readFileSync } from "node:fs";',
        'if (process.argv[2] === "signal") process.kill(process.pid, "SIGTERM");',
        'else if (process.argv[2] === "stdin") process.stdout.write(readFileSync(0));',
        "else { process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 23; }",
      ].join("\n"),
    );
    installBunCliLauncher(target);

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
    const result = spawnSync(target.path, argv, { env: { PATH: "" }, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(argv);
    expect(result.status).toBe(23);
    expect(result.signal).toBeNull();

    const signaled = spawnSync(target.path, ["signal"], { env: { PATH: "" }, encoding: "utf8" });
    expect(signaled.error).toBeUndefined();
    expect(signaled.status).toBeNull();
    expect(signaled.signal).toBe("SIGTERM");

    const input = spawnSync(target.path, ["stdin"], {
      env: { PATH: "" },
      encoding: "utf8",
      input: "original stdin\n",
    });
    expect(input.status, input.stderr).toBe(0);
    expect(input.stdout).toBe("original stdin\n");
  });

  it("preserves literal path bytes after released relocation", () => {
    const component = '$store `literal` "double" back\\slash apostrophe\'s two words *glob*';
    const target = fixture(component, "bunPath");
    // A POSIX argv probe avoids Node's separate ESM restriction on backslash filenames.
    writeFileSync(target.bunPath, '#!/bin/sh\n[ -f "$1" ] || exit 98\nprintf \'%s\\0\' "$@"\n', {
      mode: 0o755,
    });
    const content = renderBunCliLauncher(target);
    const liveRoot = join(target.root, `live ${component}`);
    // Published 2026.9.7 relocates raw sourceRoot + '/' bytes before retiring staging.
    writeFileSync(target.path, content.replaceAll(`${target.packageRoot}/`, `${liveRoot}/`), {
      mode: 0o755,
    });
    renameSync(target.packageRoot, liveRoot);

    const result = spawnSync(target.path, ["two words", "$literal", ""], {
      env: { PATH: "" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\0")).toEqual([
      join(liveRoot, "openclaw.mjs"),
      "two words",
      "$literal",
      "",
      "",
    ]);
    expect(content.split("\n").filter((line) => line.includes(`${target.packageRoot}/`))).toEqual([
      `#openclaw-entry=${target.entryPath}`,
    ]);
    expect(parseBunCliLauncher(readFileSync(target.path, "utf8"))).toEqual({
      bunPath: target.bunPath,
      entryPath: join(liveRoot, "openclaw.mjs"),
    });
  });

  it.each(["split", "duplicate"])("rejects %s data records before execution", (kind) => {
    const target = fixture();
    symlinkSync(process.execPath, target.bunPath);
    writeFileSync(target.entryPath, 'console.log("must not execute");');
    let content = renderBunCliLauncher(target);
    if (kind === "split") {
      const truncated = join(target.root, "truncated-entry");
      writeFileSync(truncated, 'require("node:fs").writeFileSync("runtime-executed", "bad");');
      const liveRoot = `${truncated}\nprintf injected > data-executed\nsuffix`;
      content = content.replaceAll(`${target.packageRoot}/`, `${liveRoot}/`);
      renameSync(target.packageRoot, liveRoot);
    } else {
      content = content.replace(
        `#openclaw-entry=${target.entryPath}`,
        `#openclaw-entry=${target.entryPath}\n#openclaw-entry=${target.entryPath}`,
      );
    }
    writeFileSync(target.path, content, { mode: 0o755 });

    const result = spawnSync(target.path, [], {
      cwd: target.root,
      env: { PATH: "" },
      encoding: "utf8",
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("openclaw: Bun launcher target not found");
    expect(result.stdout).toBe("");
    expect(existsSync(join(target.root, "runtime-executed"))).toBe(false);
    expect(existsSync(join(target.root, "data-executed"))).toBe(false);
    expect(parseBunCliLauncher(content)).toBeNull();
  });

  it.each(["runtime", "entry"])("explains a missing %s without executing", (missing) => {
    const target = fixture();
    if (missing === "entry") {
      symlinkSync(process.execPath, target.bunPath);
      unlinkSync(target.entryPath);
    }
    installBunCliLauncher(target);
    const result = spawnSync(target.path, [], { env: { PATH: "" }, encoding: "utf8" });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("openclaw: Bun launcher target not found");
    expect(result.stderr).toContain('Run "openclaw doctor" with Bun to repair.');
  });

  it.each(["missing", "symlink"])(
    "installs and repairs its %s command without modifying the entry",
    (kind) => {
      const target = fixture();
      const entry = readFileSync(target.entryPath, "utf8");
      if (kind === "symlink") {
        symlinkSync(target.entryPath, target.path);
      }
      expect(inspectBunCliLauncher(target).state).toBe(kind === "symlink" ? "stale" : "missing");

      expect(installBunCliLauncher(target)).toEqual({ path: target.path, state: "current" });
      expect(lstatSync(target.path).isSymbolicLink()).toBe(false);
      expect(statSync(target.path).mode & 0o777).toBe(0o755);
      expect(readFileSync(target.entryPath, "utf8")).toBe(entry);
      expect(parseBunCliLauncher(readFileSync(target.path, "utf8"))).toEqual({
        bunPath: target.bunPath,
        entryPath: target.entryPath,
      });
      const installed = statSync(target.path);
      installBunCliLauncher(target);
      const unchanged = statSync(target.path);
      expect(unchanged.ino).toBe(installed.ino);
      expect(unchanged.mtimeMs).toBe(installed.mtimeMs);
      expect(readdirSync(target.binDir)).toEqual(["openclaw"]);
      const updated = { ...target, bunPath: join(target.root, "new-bun") };
      expect(inspectBunCliLauncher(updated).state).toBe("stale");
      installBunCliLauncher(updated);
      expect(parseBunCliLauncher(readFileSync(target.path, "utf8"))?.bunPath).toBe(updated.bunPath);
      chmodSync(target.path, 0o644);
      expect(inspectBunCliLauncher(updated).state).toBe("stale");
      installBunCliLauncher(updated);
      expect(inspectBunCliLauncher(updated).state).toBe("current");
    },
  );

  it.each(["file", "symlink", "directory", "edited launcher", "foreign package"])(
    "preserves a conflicting %s",
    (kind) => {
      const target = fixture();
      const otherEntry = join(target.root, "other-command");
      writeFileSync(otherEntry, "other owner");
      const content =
        kind === "edited launcher"
          ? `${renderBunCliLauncher(target)}echo extra\n`
          : kind === "foreign package"
            ? renderBunCliLauncher({
                bunPath: target.bunPath,
                entryPath: join(target.root, "another-package", "openclaw.mjs"),
              })
            : "other owner";
      if (kind === "file") {
        writeFileSync(target.path, content);
      } else if (kind === "symlink") {
        symlinkSync(otherEntry, target.path);
      } else if (kind === "directory") {
        mkdirSync(target.path);
      } else {
        writeFileSync(target.path, content);
        if (kind === "edited launcher") {
          expect(parseBunCliLauncher(content)).toBeNull();
        }
      }

      expect(inspectBunCliLauncher(target).state).toBe("conflict");
      expect(() => installBunCliLauncher(target)).toThrow("left unchanged");
      expect(readFileSync(otherEntry, "utf8")).toBe("other owner");
      if (kind === "symlink") {
        expect(readlinkSync(target.path)).toBe(otherEntry);
      } else if (kind === "directory") {
        expect(lstatSync(target.path).isDirectory()).toBe(true);
      } else {
        expect(readFileSync(target.path, "utf8")).toBe(content);
      }
      expect(readdirSync(target.binDir)).toEqual(["openclaw"]);
    },
  );
});

describe("Bun launcher path contract", () => {
  it.each(["relative/bun", "/runtime\0next"])(
    "rejects an unstable executable or entry path: %j",
    (invalid) => {
      expect(() =>
        renderBunCliLauncher({ bunPath: invalid, entryPath: "/pkg/openclaw.mjs" }),
      ).toThrow("absolute, single-line");
      expect(() => renderBunCliLauncher({ bunPath: "/runtime/bun", entryPath: invalid })).toThrow(
        "absolute, single-line",
      );
    },
  );
});

describe.skipIf(process.platform === "win32")("packaged Bun launcher lifecycle", () => {
  beforeEach(() => {
    lifecycle.resolveBinDir.mockReset();
    lifecycle.probeNode.mockReset().mockReturnValue({ bunVersion: "1.4.3" });
  });

  function lifecycleFixture() {
    const target = fixture();
    symlinkSync(target.entryPath, target.path);
    lifecycle.resolveBinDir.mockReturnValue(target.binDir);
    const env = {
      npm_config_user_agent: "bun/1.4.3",
      OPENCLAW_PACKAGE_BUN_LAUNCHER: target.bunPath,
    };
    return { target, params: { packageRoot: target.packageRoot, env, bunVersion: "1.4.3" } };
  }

  it("finishes only its existing global link and refreshes it after a Bun update", () => {
    const { target, params } = lifecycleFixture();
    installPackageBunCliLauncher(params);
    expect(lifecycle.resolveBinDir).toHaveBeenCalledWith({
      bunPath: target.bunPath,
      cwd: target.packageRoot,
      env: params.env,
    });
    expect(inspectBunCliLauncher(target).state).toBe("current");
    const updatedBun = join(target.root, "updated-bun");
    installPackageBunCliLauncher({
      ...params,
      env: { ...params.env, OPENCLAW_PACKAGE_BUN_LAUNCHER: updatedBun },
    });
    expect(parseBunCliLauncher(readFileSync(target.path, "utf8"))?.bunPath).toBe(updatedBun);
  });

  it.each(unsupportedPathCharacters)(
    "keeps Bun's symlink for paths containing %j",
    (character, label) => {
      for (const field of ["bunPath", "entryPath"] as const) {
        const target = fixture(character, field);
        symlinkSync(target.entryPath, target.path);
        lifecycle.resolveBinDir.mockReturnValue(target.binDir);
        const reason = `${field === "bunPath" ? "Bun executable path" : "Install path"} contains ${label}, which cannot be stored in a launcher data line`;

        expect(() => renderBunCliLauncher(target)).toThrow(reason);
        expect(() => inspectBunCliLauncher(target)).toThrow(reason);
        expect(() => installBunCliLauncher(target)).toThrow(reason);
        expect(() =>
          installPackageBunCliLauncher({
            packageRoot: target.packageRoot,
            bunVersion: "1.4.3",
            env: {
              npm_config_user_agent: "bun/1.4.3",
              OPENCLAW_PACKAGE_BUN_LAUNCHER: target.bunPath,
            },
          }),
        ).not.toThrow();
        expect(readlinkSync(target.path)).toBe(target.entryPath);
        expect(readdirSync(target.binDir)).toEqual(["openclaw"]);
      }
    },
  );

  it.each(["missing", "foreign"])("does not claim a %s global command", (kind) => {
    const target = fixture();
    if (kind === "foreign") {
      writeFileSync(target.path, "other owner");
    }
    lifecycle.resolveBinDir.mockReturnValue(target.binDir);
    installPackageBunCliLauncher({
      packageRoot: target.packageRoot,
      bunVersion: "1.4.3",
      env: { npm_config_user_agent: "bun/1.4.3", OPENCLAW_PACKAGE_BUN_LAUNCHER: target.bunPath },
    });
    expect(readdirSync(target.binDir)).toEqual(kind === "missing" ? [] : ["openclaw"]);
    if (kind === "foreign") {
      expect(readFileSync(target.path, "utf8")).toBe("other owner");
    }
  });

  it.each([
    "Node runtime",
    "npm install",
    "missing marker",
    "relative marker",
    "persistent Node",
    "Windows",
  ])("leaves the Node-shebang bin untouched for %s", (scenario) => {
    const { target, params } = lifecycleFixture();
    if (scenario === "Node runtime") {
      params.bunVersion = "";
    }
    if (scenario === "npm install") {
      params.env.npm_config_user_agent = "npm/11.0.0";
    }
    if (scenario === "missing marker") {
      params.env.OPENCLAW_PACKAGE_BUN_LAUNCHER = "";
    }
    if (scenario === "relative marker") {
      params.env.OPENCLAW_PACKAGE_BUN_LAUNCHER = "bun";
    }
    if (scenario === "persistent Node") {
      lifecycle.probeNode.mockReturnValue({ bunVersion: null });
    }
    if (scenario === "Windows") {
      vi.stubGlobal("process", { platform: "win32" });
    }
    try {
      installPackageBunCliLauncher(params);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(readlinkSync(target.path)).toBe(target.entryPath);
    if (scenario === "Windows") {
      expect(lifecycle.probeNode).not.toHaveBeenCalled();
    }
    expect(lifecycle.resolveBinDir).not.toHaveBeenCalled();
  });
});

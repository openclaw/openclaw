import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeout = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sanitize-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  runCommandWithTimeout.mockReset();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("installPluginFromDir", () => {
  it("sanitizes package.json for npm install and restores it afterwards", async () => {
    const workDir = makeTempDir();
    const pkgDir = path.join(workDir, "plugin");
    fs.mkdirSync(pkgDir, { recursive: true });

    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/sanitize-test",
          version: "0.0.1",
          type: "module",
          dependencies: { zod: "^4.3.6" },
          devDependencies: { openclaw: "workspace:*" },
          openclaw: { extensions: ["./index.ts"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(path.join(pkgDir, "openclaw.plugin.json"), JSON.stringify({}), "utf-8");
    fs.writeFileSync(path.join(pkgDir, "index.ts"), "export {};\n", "utf-8");

    // Should not be copied to the install target.
    fs.mkdirSync(path.join(pkgDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "node_modules", "should-not-copy.txt"), "nope", "utf-8");

    runCommandWithTimeout.mockImplementation(async (argv: string[], opts: { cwd?: string }) => {
      expect(argv.slice(0, 2)).toEqual(["npm", "install"]);
      expect(opts.cwd).toBeTruthy();
      const cwd = opts.cwd as string;
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      expect(pkg.devDependencies).toBeUndefined();
      expect(pkg.openclaw).toBeUndefined();
      expect(pkg.dependencies?.zod).toBe("^4.3.6");
      return { stdout: "", stderr: "", code: 0, signal: null, killed: false };
    });

    const stateDir = makeTempDir();
    const extensionsDir = path.join(stateDir, "extensions");

    const { installPluginFromDir } = await import("./install.js");
    const result = await installPluginFromDir({
      dirPath: pkgDir,
      extensionsDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const installedPkg = JSON.parse(
      fs.readFileSync(path.join(result.targetDir, "package.json"), "utf-8"),
    );
    expect(installedPkg.devDependencies?.openclaw).toBe("workspace:*");
    expect(installedPkg.openclaw?.extensions).toEqual(["./index.ts"]);
    expect(fs.existsSync(path.join(result.targetDir, "node_modules", "should-not-copy.txt"))).toBe(
      false,
    );
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });
});

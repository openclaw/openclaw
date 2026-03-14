import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildShellPath, resolvePosixShell } from "../scripts/run-bash.mjs";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function touchExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
  fs.chmodSync(filePath, 0o755);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePosixShell", () => {
  it("prefers explicit candidates before PATH scanning", () => {
    const preferred = path.join(makeTempDir("openclaw-run-bash-pref-"), "bash.exe");
    touchExecutable(preferred);

    const pathShellDir = makeTempDir("openclaw-run-bash-path-");
    touchExecutable(path.join(pathShellDir, "bash.exe"));

    const resolved = resolvePosixShell({
      platform: "win32",
      preferredCandidates: [preferred],
      pathEnv: pathShellDir,
    });

    expect(resolved).toBe(preferred);
  });

  it("skips Windows and Cygwin shim directories when scanning PATH on Windows", () => {
    const root = makeTempDir("openclaw-run-bash-root-");
    const system32Dir = path.join(root, "Windows", "System32");
    const cygwinDir = path.join(root, "cygwin64", "bin");
    const msysDir = path.join(root, "msys64", "usr", "bin");
    touchExecutable(path.join(system32Dir, "bash.exe"));
    touchExecutable(path.join(cygwinDir, "bash.exe"));
    const msysShell = path.join(msysDir, "sh.exe");
    touchExecutable(msysShell);

    const resolved = resolvePosixShell({
      platform: "win32",
      preferredCandidates: [],
      pathEnv: [system32Dir, cygwinDir, msysDir].join(path.delimiter),
    });

    expect(resolved).toBe(msysShell);
  });
});

describe("buildShellPath", () => {
  it("prepends roaming npm and the current node directory on Windows", () => {
    const built = buildShellPath({
      platform: "win32",
      appData: "C:\\Users\\tester\\AppData\\Roaming",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      pathEnv: "C:\\existing\\bin",
    });

    expect(built).toBe(
      [
        "C:\\Users\\tester\\AppData\\Roaming\\npm",
        "C:\\Program Files\\nodejs",
        "C:\\existing\\bin",
      ].join(path.delimiter),
    );
  });
});

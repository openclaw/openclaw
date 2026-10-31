import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { CommandResolution, ExecutableResolution } from "./exec-command-resolution.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: tempDir }),
    );
  }
  cleanupTempDirs(tempDirs);
});

export function makePathEnv(binDir: string): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT;.COM" }
    : { PATH: binDir };
}

export function makeExecApprovalsTempDir(): string {
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-")),
  );
  tempDirs.add(tempDir);
  return tempDir;
}

export function makeExecutable(dir: string, name: string): string {
  const fileName = process.platform === "win32" ? `${name}.exe` : name;
  const exe = path.join(dir, fileName);
  fs.writeFileSync(exe, "");
  fs.chmodSync(exe, 0o755);
  return exe;
}

export function makeMockExecutableResolution(
  params: Omit<ExecutableResolution, "kind">,
): ExecutableResolution {
  return {
    kind: "executable",
    rawExecutable: params.rawExecutable,
    resolvedPath: params.resolvedPath,
    resolvedRealPath: params.resolvedRealPath,
    executableName: params.executableName,
  };
}

export function makeMockCommandResolution(
  params: Omit<CommandResolution, "kind" | "policy"> & { policy?: ExecutableResolution },
): CommandResolution {
  return {
    kind: "command",
    execution: params.execution,
    policy: params.policy ?? params.execution,
    effectiveArgv: params.effectiveArgv,
    wrapperChain: params.wrapperChain,
    policyBlocked: params.policyBlocked,
    blockedWrapper: params.blockedWrapper,
  };
}

type ShellParserParityFixtureCase = {
  id: string;
  command: string;
  ok: boolean;
  executables: string[];
};

type WrapperResolutionParityFixtureCase = {
  id: string;
  argv: string[];
  expectedRawExecutable: string | null;
};

function loadFixtureCases<T>(name: string): T[] {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", name);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { cases: T[] };
  return fixture.cases;
}

export function loadShellParserParityFixtureCases(): ShellParserParityFixtureCase[] {
  return loadFixtureCases("exec-allowlist-shell-parser-parity.json");
}

export function loadWrapperResolutionParityFixtureCases(): WrapperResolutionParityFixtureCase[] {
  return loadFixtureCases("exec-wrapper-resolution-parity.json");
}

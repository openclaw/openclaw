import fs from "node:fs";
import path from "node:path";
import { trackedMkdtempSync } from "../../test/test-env.js";

export function makePathEnv(binDir: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return { PATH: binDir };
  }
  return { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT;.COM" };
}

export function makeTempDir(): string {
  return trackedMkdtempSync("openclaw-exec-approvals-");
}

export type ShellParserParityFixtureCase = {
  id: string;
  command: string;
  ok: boolean;
  executables: string[];
};

type ShellParserParityFixture = {
  cases: ShellParserParityFixtureCase[];
};

export type WrapperResolutionParityFixtureCase = {
  id: string;
  argv: string[];
  expectedRawExecutable: string | null;
};

type WrapperResolutionParityFixture = {
  cases: WrapperResolutionParityFixtureCase[];
};

export function loadShellParserParityFixtureCases(): ShellParserParityFixtureCase[] {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "exec-allowlist-shell-parser-parity.json",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ShellParserParityFixture;
  return fixture.cases;
}

export function loadWrapperResolutionParityFixtureCases(): WrapperResolutionParityFixtureCase[] {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "exec-wrapper-resolution-parity.json",
  );
  const fixture = JSON.parse(
    fs.readFileSync(fixturePath, "utf8"),
  ) as WrapperResolutionParityFixture;
  return fixture.cases;
}

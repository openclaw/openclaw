// Check No Random Messaging Tmp tests cover check no random messaging tmp script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findMessagingTmpdirCallLines,
  main,
  messagingTmpdirGuardSourceRoots,
} from "../../scripts/check-no-random-messaging-tmp.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import * as repoRoot from "../../scripts/lib/repo-root.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

describe("check-no-random-messaging-tmp", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    previousExitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it("allows plugin test support while rejecting runtime tmpdir calls through the guard", async () => {
    const root = tempDirs.make("openclaw-messaging-tmp-guard-");
    vi.spyOn(repoRoot, "resolveRepoRoot").mockReturnValue(root);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSource = (relativePath: string) => {
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'import os from "node:os";\nconst dir = os.tmpdir();\n');
    };

    writeSource("extensions/browser/src/browser/extension-install.test-support.ts");
    await main();
    expect(process.exitCode).toBe(previousExitCode);
    expect(errorLog).not.toHaveBeenCalled();

    const runtimePaths = [
      "src/channels/runtime.ts",
      "extensions/browser/runtime-api.ts",
      "extensions/browser/src/browser/runtime.ts",
    ];
    runtimePaths.forEach(writeSource);
    await main();
    expect(process.exitCode).toBe(1);
    expect(errorLog).toHaveBeenCalledTimes(5);
    expect(errorLog).toHaveBeenNthCalledWith(
      1,
      "Found os.tmpdir()/tmpdir() usage in messaging/channel runtime sources:",
    );
    expect(new Set(errorLog.mock.calls.slice(1, -1).map(([message]) => message))).toEqual(
      new Set(runtimePaths.map((relativePath) => `- ${relativePath}:2`)),
    );
    expect(errorLog).toHaveBeenLastCalledWith(
      "Use resolvePreferredOpenClawTmpDir() or plugin-sdk temp helpers instead of host tmp defaults.",
    );
  });

  it("finds tmpdir named import calls from node:os", () => {
    const source = `
      import { tmpdir } from "node:os";
      const dir = tmpdir();
    `;
    expect(
      findMessagingTmpdirCallLines(source, "file.ts", parser.parseSourceFile("file.ts", source)),
    ).toEqual([3]);
  });

  it("finds tmpdir calls imported from os", () => {
    const source = `
      import os from "os";
      const dir = os.tmpdir();
    `;
    expect(
      findMessagingTmpdirCallLines(source, "file.ts", parser.parseSourceFile("file.ts", source)),
    ).toEqual([3]);
  });

  it("ignores mentions in comments and strings", () => {
    const source = `
      // os.tmpdir()
      const text = "tmpdir()";
    `;
    expect(
      findMessagingTmpdirCallLines(source, "file.ts", parser.parseSourceFile("file.ts", source)),
    ).toStrictEqual([]);
  });

  it("ignores tmpdir symbols that are not imported from node:os", () => {
    const source = `
      const tmpdir = () => "/tmp";
      const dir = tmpdir();
    `;
    expect(
      findMessagingTmpdirCallLines(source, "file.ts", parser.parseSourceFile("file.ts", source)),
    ).toStrictEqual([]);
  });

  it("guards src/media against host tmpdir usage", () => {
    expect(messagingTmpdirGuardSourceRoots).toContain("src/media");
  });
});

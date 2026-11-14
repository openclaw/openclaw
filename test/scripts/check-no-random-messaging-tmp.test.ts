// Check No Random Messaging Tmp tests cover check no random messaging tmp script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-no-random-messaging-tmp.mts";
import * as repoRoot from "../../scripts/lib/repo-root.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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
    const writeSource = (
      relativePath: string,
      source = 'import os from "node:os";\nconst dir = os.tmpdir();\n',
    ) => {
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source);
    };

    writeSource("extensions/browser/src/browser/extension-install.test-support.ts");
    writeSource("src/channels/local.ts", 'const tmpdir = () => "/tmp";\nconst dir = tmpdir();');
    await main();
    expect(process.exitCode).toBe(previousExitCode);
    expect(errorLog).not.toHaveBeenCalled();

    const runtimePaths = [
      "src/channels/runtime.ts",
      "src/infra/outbound/runtime.ts",
      "src/line/runtime.ts",
      "src/media/runtime.ts",
      "src/media-understanding/runtime.ts",
      "extensions/browser/runtime-api.ts",
      "extensions/browser/src/browser/runtime.ts",
    ];
    runtimePaths.forEach((file) => writeSource(file));
    const namedImport = "src/channels/named.ts";
    writeSource(namedImport, 'import { tmpdir } from "node:os";\nconst dir = tmpdir();');
    runtimePaths.push(namedImport);
    const defaultImport = "src/channels/default.ts";
    writeSource(defaultImport, 'import os from "os";\nconst dir = os.tmpdir();');
    runtimePaths.push(defaultImport);
    await main();
    expect(process.exitCode).toBe(1);
    expect(errorLog).toHaveBeenCalledTimes(runtimePaths.length + 2);
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
});

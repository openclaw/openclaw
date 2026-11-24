import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pinnedBun from "../../scripts/lib/pinned-bun.mts";
import { resolveTestRuntime } from "../../scripts/lib/test-runtime.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { cleanRunnerEnv, repoRoot } from "./run-vitest.test-support.js";

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "labels the selected Bun executable and its revision under a Node launcher",
  () => {
    const bun = path.join(tempDirs.make("oc-test-runtime-"), "bun");
    fs.writeFileSync(
      bun,
      '#!/bin/sh\nif [ "$1" = --revision ]; then echo 1.4.4-canary.1+fixture; else echo bun-test-invoked; fi\n',
      { mode: 0o755 },
    );
    const result = spawnSync(resolveTestNodeExecPath(), ["scripts/run-vitest.mjs", "--version"], {
      cwd: repoRoot,
      env: cleanRunnerEnv({ OPENCLAW_BUN_PATH: bun }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("bun-test-invoked");
    expect(result.stderr).toContain("[vitest] test runtime: Bun 1.4.4-canary.1+fixture");
  },
);

describe("test runtime policy", () => {
  it.each(["node", "bun"] as const)("honors explicit %s without probing Bun", (runtime) => {
    const resolve = vi.spyOn(pinnedBun, "resolvePinnedBun");
    expect(resolveTestRuntime({ OPENCLAW_VITEST_RUNTIME: ` ${runtime} `, CI: "1" })).toBe(runtime);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects invalid explicit runtimes", () => {
    expect(() => resolveTestRuntime({ OPENCLAW_VITEST_RUNTIME: "deno" })).toThrow(
      "expected node or bun",
    );
  });

  it.each(["1", "true", "custom", "0"])("keeps CI=%s on Node without staging", (CI) => {
    const resolve = vi.spyOn(pinnedBun, "resolvePinnedBun");
    expect(resolveTestRuntime({ CI })).toBe("node");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "false"])("defaults local CI=%s to the available fork", (CI) => {
    vi.spyOn(pinnedBun, "resolvePinnedBun").mockReturnValue({ command: "/cache/bin/bun" });
    expect(resolveTestRuntime({ CI })).toBe("bun");
  });

  it("falls back to Node with one actionable notice per process", () => {
    vi.spyOn(pinnedBun, "resolvePinnedBun").mockReturnValue({ reason: "offline" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveTestRuntime({})).toBe("node");
    expect(resolveTestRuntime({})).toBe("node");
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "[openclaw] Bun fork unavailable (offline); using Node. Set OPENCLAW_VITEST_RUNTIME=node to silence.",
    );
  });
});

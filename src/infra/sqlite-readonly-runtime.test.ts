import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createReadinessChecker } from "../gateway/server/readiness.js";
import { readChildRuntimeViability } from "./child-runtime-viability.js";
import { createSqliteReadOnlyWorkerSession } from "./sqlite-readonly-worker-session.js";

const originalExecPath = process.execPath;
const directories: string[] = [];
afterEach(async () => {
  process.execPath = originalExecPath;
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function runtime(source: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-"));
  directories.push(dir);
  const executable = path.join(dir, "node");
  await fs.writeFile(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  process.execPath = executable;
  return executable;
}

function session() {
  return createSqliteReadOnlyWorkerSession({
    env: {},
    cwd: process.cwd(),
    transport: { kind: "native" },
    argv: [],
    retainLifetime: false,
    requestArgs: () => [],
    readBudget: () => ({ timeoutMs: 5_000, size: "fixture" }),
    deadlineOwnedByCaller: () => true,
    timeoutError: () => new Error("unexpected timeout"),
    closeTimeoutMs: 5_000,
  });
}

it
  .skipIf(process.platform === "win32")
  .each(["loader", "removed", "symbol", "dyld-symbol", "musl", "version", "permission"])(
  "reports a %s failure through the real read-only spawn and live readiness, without poisoning ordinary crashes",
  async (kind) => {
    const readiness = createReadinessChecker({
      startedAt: Date.now(),
      channelManager: {
        getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
        getAutostartSuppression: () => null,
        isAmbientAutostartSuppressed: () => false,
      },
    });
    // An ordinary worker failure must not mark a working executable as unavailable.
    const ordinaryExit = kind === "symbol" || kind === "musl" ? 127 : 1;
    await runtime(
      'if [ "$1" = "--version" ]; then echo v26.12.0; exit 0; fi\n' +
        (kind === "symbol"
          ? 'echo "node: symbol lookup error: /fixture/plugin.node: undefined symbol: plugin_value" >&2\n'
          : kind === "dyld-symbol"
            ? 'echo "dyld: lazy symbol binding failed: Symbol not found: _plugin_value" >&2\n'
            : kind === "musl"
              ? 'echo "Error loading shared library libaddon.so: No such file or directory (needed by /fixture/plugin.node)" >&2\n'
              : kind === "version"
                ? "echo \"node: /fixture/libstdc++.so.6: version 'GLIBCXX_3.4.29' not found (required by /fixture/plugin.node)\" >&2\n"
                : "") +
        // Admit the request before exiting so the control observes a worker crash, not EPIPE.
        `dd bs=1 count=1 <&3 >/dev/null 2>&1\nexit ${ordinaryExit}`,
    );
    const crashed = session();
    await expect(crashed.run("fixture", { mode: "staging-create" })).rejects.toThrow(
      `SQLite read-only worker exited with code ${ordinaryExit}`,
    );
    await crashed.close();
    expect(readChildRuntimeViability().available).toBe(true);
    expect(readiness().ready).toBe(true);

    const executable = await runtime(
      kind === "symbol"
        ? 'echo "node: symbol lookup error: /fixture/libnode.so: undefined symbol: runtime_value" >&2\nexit 127'
        : kind === "dyld-symbol"
          ? 'echo "dyld: lazy symbol binding failed: Symbol not found: _runtime_value" >&2\nexit 134'
          : kind === "musl"
            ? 'echo "Error loading shared library libnode.so: No such file or directory (needed by /fixture/node)" >&2\nexit 127'
            : kind === "version"
              ? "echo \"node: /fixture/libc.so.6: version 'GLIBC_2.28' not found (required by /fixture/node)\" >&2\nexit 1"
              : 'echo "dyld[123]: Library not loaded: /fixture/libsimdutf.36.dylib" >&2\nexit 134',
    );
    if (kind === "removed") {
      await fs.unlink(executable);
    } else if (kind === "permission") {
      await fs.chmod(executable, 0o600);
    }
    const broken = session();
    await expect(broken.run("fixture", { mode: "staging-create" })).rejects.toMatchObject({
      code: "NODE_RUNTIME_UNAVAILABLE",
      message: `The Node.js runtime this Gateway started with (${executable}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
    });
    await broken.close();
    expect(readChildRuntimeViability()).toEqual({ execPath: executable, available: false });
    expect(readiness()).toMatchObject({ ready: false, failing: ["child-runtime"] });
    // No second doomed worker: the owner rejects before spawning again.
    expect(() => session()).toThrow("Restart the Gateway.");
  },
);

it("publishes a removed runtime observed by readiness before another worker spawn", async () => {
  const { registerChildRuntimeRecovery } = await import("./child-runtime-viability.js");
  const executable = await runtime("echo v26.12.0");
  const recover = vi.fn(async () => ({ status: "report-only" as const, reason: "test service" }));
  const release = registerChildRuntimeRecovery(recover);
  const readiness = createReadinessChecker({
    startedAt: Date.now(),
    channelManager: {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
  try {
    expect(readiness().ready).toBe(true);
    await fs.unlink(executable);
    expect(readiness()).toMatchObject({ ready: false, failing: ["child-runtime"] });
    expect(readiness().ready).toBe(false);
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(() => session()).toThrow("Restart the Gateway.");
  } finally {
    release();
  }
});

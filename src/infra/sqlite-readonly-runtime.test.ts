import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createReadinessChecker } from "../gateway/server/readiness.js";
import { readChildRuntimeViability } from "./child-runtime-viability.js";
import { createSqliteReadOnlyWorkerSession } from "./sqlite-readonly-worker-session.js";

const originalExecPath = process.execPath;
const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  process.execPath = originalExecPath;
});

async function runtime(source: string) {
  const executable = path.join(directories.make("openclaw-runtime-"), "node");
  await fs.writeFile(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  process.execPath = executable;
  return executable;
}

function diagnostic(kind: string, addon = false) {
  const owner = addon ? "plugin.node" : "node";
  const value = addon ? "plugin_value" : "runtime_value";
  const messages: Record<string, string> = {
    symbol: `node: symbol lookup error: /fixture/${addon ? owner : "libnode.so"}: undefined symbol: ${value}`,
    "dyld-symbol": `dyld: lazy symbol binding failed: Symbol not found: _${value}`,
    musl: `Error loading shared library ${addon ? "libaddon.so" : "libnode.so"}: No such file or directory (needed by /fixture/${owner})`,
    version: `node: /fixture/${addon ? "libstdc++.so.6" : "libc.so.6"}: version '${addon ? "GLIBCXX_3.4.29" : "GLIBC_2.28"}' not found (required by /fixture/${owner})`,
  };
  const message =
    messages[kind] ?? (addon ? "" : "dyld[123]: Library not loaded: /fixture/libsimdutf.36.dylib");
  return message ? `echo "${message}" >&2` : "";
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

async function runWorker() {
  const worker = session();
  try {
    return await worker.run("fixture", { mode: "staging-create" });
  } finally {
    await worker.close();
  }
}

function readinessChecker() {
  return createReadinessChecker({
    startedAt: Date.now(),
    channelManager: {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
}

it
  .skipIf(process.platform === "win32")
  .each(["loader", "removed", "symbol", "dyld-symbol", "musl", "version", "permission"])(
  "reports a %s failure through the real read-only spawn and live readiness, without poisoning ordinary crashes",
  async (kind) => {
    const readiness = readinessChecker();
    const ordinaryExit = kind === "symbol" || kind === "musl" ? 127 : 1;
    await runtime(
      'if [ "$1" = "--version" ]; then echo v26.12.0; exit 0; fi\n' +
        // Admit the request before exiting so the control observes a worker crash, not EPIPE.
        `${diagnostic(kind, true)}\ndd bs=1 count=1 <&3 >/dev/null 2>&1\nexit ${ordinaryExit}`,
    );
    await expect(runWorker()).rejects.toThrow(
      `SQLite read-only worker exited with code ${ordinaryExit}`,
    );
    expect([readChildRuntimeViability().available, readiness().ready]).toEqual([true, true]);

    const brokenExit = kind === "symbol" || kind === "musl" ? 127 : kind === "version" ? 1 : 134;
    const executable = await runtime(`${diagnostic(kind)}\nexit ${brokenExit}`);
    if (kind === "removed") {
      await fs.unlink(executable);
    } else if (kind === "permission") {
      await fs.chmod(executable, 0o600);
    }
    await expect(runWorker()).rejects.toMatchObject({
      code: "NODE_RUNTIME_UNAVAILABLE",
      message: `The Node.js runtime this Gateway started with (${executable}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
    });
    expect(readChildRuntimeViability()).toEqual({ execPath: executable, available: false });
    expect(readiness()).toMatchObject({ ready: false, failing: ["child-runtime"] });
    expect(() => session()).toThrow("Restart the Gateway.");
  },
);

it("publishes a removed runtime observed by readiness before another worker spawn", async () => {
  const { registerChildRuntimeRecovery } = await import("./child-runtime-viability.js");
  const executable = await runtime("echo v26.12.0");
  const recover = vi.fn(async () => ({ status: "report-only" as const, reason: "test service" }));
  const release = registerChildRuntimeRecovery(recover);
  using _ = { [Symbol.dispose]: release };
  const readiness = readinessChecker();
  expect(readiness().ready).toBe(true);
  await fs.unlink(executable);
  expect(readiness()).toMatchObject({ ready: false, failing: ["child-runtime"] });
  expect(readiness().ready).toBe(false);
  await Promise.resolve();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(() => session()).toThrow("Restart the Gateway.");
});

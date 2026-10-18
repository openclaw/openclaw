import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getProcessSupervisor } from "./index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(() => vi.unstubAllEnvs());

async function waitForRootExit(pid: number, signal: AbortSignal) {
  // Startup is intentionally blocked on private input, so no root exit promise is exposed yet.
  while (existsSync(`/proc/${pid}`)) {
    await delay(10, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`Root ${pid} did not exit before private input was released`, {
        cause: error,
      });
    });
  }
}

it.skipIf(process.platform !== "linux").for(["consume", "cancel"] as const)(
  "observes root output before settling private input after root exit: %s",
  { timeout: 15_000 },
  async (operation, { signal }) => {
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
    const cwd = tempDirs.make("openclaw-supervisor-private-input-");
    const release = path.join(cwd, "read-secret");
    const receipt = path.join(cwd, "receipt.json");
    const identities = path.join(cwd, "pids.json");
    const data = Buffer.alloc(1024 * 1024, 0x5a);
    const expectedHash = createHash("sha256").update(data).digest("hex");
    const reader = `
      const fs = require("node:fs");
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        const bytes = fs.readFileSync(3);
        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
          length: bytes.length,
          sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
        }));
      }, 10);
    `;
    const launcher = `
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      ${fixtureReceiptClientSource(receipts.endpoint)}
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(reader)}], {
        stdio: ["ignore", 1, 2, 3],
      });
      child.unref();
      fs.writeFileSync(${JSON.stringify(identities)}, JSON.stringify({root: process.pid, child: child.pid}));
      sendReceipt(${JSON.stringify(identities)}, "ready");
      fs.writeSync(1, "root stdout\\n");
      fs.writeSync(2, "root stderr\\n");
      fixtureReceiptSocket.ref();
      fixtureReceiptSocket.end(() => process.exit(23));
    `;
    const observed = { stdout: "", stderr: "" };
    const output = createDeferred();
    const observeOutput = () => {
      if (observed.stdout === "root stdout\n" && observed.stderr === "root stderr\n") {
        output.resolve();
      }
    };
    const supervisor = getProcessSupervisor();
    const runId = `private-input-${path.basename(cwd)}`;
    const releaseScope = supervisor.acquireScopeCleanup(runId, { processTree: "transport-only" });
    let ready = false;
    const starting = supervisor.spawn({
      runId,
      scopeKey: runId,
      mode: "child",
      argv: [process.execPath, "--input-type=module", "-e", launcher],
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      exactEnv: true,
      stdinMode: "pipe-closed",
      timeoutMs: 10_000,
      secretInput: { fd: 3, createData: () => data },
      onStdout: (chunk) => {
        observed.stdout += chunk;
        observeOutput();
      },
      onStderr: (chunk) => {
        observed.stderr += chunk;
        observeOutput();
      },
    });
    void starting.then(
      () => {
        ready = true;
      },
      () => undefined,
    );
    try {
      await withinTest(
        Promise.race([
          receipts.waitFor(identities, "ready"),
          starting.then(
            () => {
              if (!existsSync(identities)) {
                throw new Error(
                  "Root and reader identities were not recorded before startup settled",
                );
              }
            },
            (error: unknown) => {
              if (!existsSync(identities)) {
                throw error;
              }
            },
          ),
        ]),
        signal,
      );
      const { root } = JSON.parse(readFileSync(identities, "utf8")) as { root: number };
      await waitForRootExit(root, signal);
      await withinTest(
        awaitGateBeforeSettlement(
          output.promise,
          starting,
          "Root output was not observed before private input settled",
        ),
        signal,
      );
      expect(observed).toEqual({ stdout: "root stdout\n", stderr: "root stderr\n" });
      expect(ready).toBe(false);
      expect(existsSync(receipt)).toBe(false);
      if (operation === "consume") {
        writeFileSync(release, "read");
      } else {
        supervisor.cancel(runId);
      }
      const run = await withinTest(starting, signal);
      await expect(withinTest(run.wait(), signal)).resolves.toMatchObject({
        reason: operation === "consume" ? "exit" : "manual-cancel",
        exitCode: operation === "consume" ? 23 : null,
        exitSignal: null,
        ...observed,
      });
      if (operation === "consume") {
        // The reader writes its receipt before exit; run.wait() joins its inherited output EOF.
        expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
          length: data.length,
          sha256: expectedHash,
        });
      } else {
        await withinTest(Promise.resolve(run.waitForExtinction?.()), signal);
        expect(existsSync(receipt)).toBe(false);
      }
      expect(data.every((byte) => byte === 0)).toBe(true);
    } finally {
      writeFileSync(release, "read");
      supervisor.cancel(runId);
      await starting.then(
        (run) => run.wait(),
        () => undefined,
      );
      await releaseScope();
    }
  },
);

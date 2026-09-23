import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getProcessSupervisor } from "./index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform !== "linux").each(["consume", "cancel"] as const)(
  "observes root output before settling private input after root exit: %s",
  async (operation) => {
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
      const fs = require("node:fs");
      const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(reader)}], {
        stdio: ["ignore", 1, 2, 3],
      });
      child.unref();
      fs.writeFileSync(${JSON.stringify(identities)}, JSON.stringify({root: process.pid, child: child.pid}));
      fs.writeSync(1, "root stdout\\n");
      fs.writeSync(2, "root stderr\\n");
      process.exit(23);
    `;
    const observed = { stdout: "", stderr: "" };
    const supervisor = getProcessSupervisor();
    const runId = `private-input-${path.basename(cwd)}`;
    const releaseScope = supervisor.acquireScopeCleanup(runId, { processTree: "transport-only" });
    let ready = false;
    const starting = supervisor.spawn({
      runId,
      scopeKey: runId,
      mode: "child",
      argv: [process.execPath, "-e", launcher],
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      exactEnv: true,
      stdinMode: "pipe-closed",
      timeoutMs: 10_000,
      secretInput: { fd: 3, createData: () => data },
      onStdout: (chunk) => {
        observed.stdout += chunk;
      },
      onStderr: (chunk) => {
        observed.stderr += chunk;
      },
    });
    void starting.then(
      () => {
        ready = true;
      },
      () => undefined,
    );
    try {
      await expect.poll(() => existsSync(identities)).toBe(true);
      const { root } = JSON.parse(readFileSync(identities, "utf8")) as { root: number };
      await expect.poll(() => existsSync(`/proc/${root}`)).toBe(false);
      await expect
        .poll(() => observed)
        .toEqual({ stdout: "root stdout\n", stderr: "root stderr\n" });
      expect(ready).toBe(false);
      expect(existsSync(receipt)).toBe(false);
      if (operation === "consume") {
        writeFileSync(release, "read");
      } else {
        supervisor.cancel(runId);
      }
      const run = await starting;
      await expect(run.wait()).resolves.toMatchObject({
        reason: operation === "consume" ? "exit" : "manual-cancel",
        exitCode: operation === "consume" ? 23 : null,
        exitSignal: null,
        ...observed,
      });
      if (operation === "consume") {
        await expect.poll(() => existsSync(receipt)).toBe(true);
        expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
          length: data.length,
          sha256: expectedHash,
        });
      } else {
        await run.waitForExtinction?.();
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
  15_000,
);

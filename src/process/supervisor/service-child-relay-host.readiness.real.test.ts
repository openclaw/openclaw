import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createProcessSupervisor } from "./supervisor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32").each(["consume", "cancel"] as const)(
  "drains real relay output while private input is pending: %s",
  async (operation) => {
    const cwd = tempDirs.make("openclaw-relay-readiness-");
    const release = path.join(cwd, "consume");
    const secret = Buffer.alloc(1024 * 1024, 0x5a);
    const expectedHash = createHash("sha256").update(secret).digest("hex");
    const body = "x".repeat(512 * 1024) + "\nfinal tail\n";
    const script = `
      const fs = require("node:fs");
      fs.writeSync(1, "x".repeat(512 * 1024) + "\\nfinal tail\\n");
      fs.writeSync(2, "stderr tail\\n");
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        const data = fs.readFileSync(3);
        fs.writeSync(1, require("node:crypto").createHash("sha256").update(data).digest("hex"));
      }, 10);
    `;
    const supervisor = createProcessSupervisor();
    const scope = `relay-${path.basename(cwd)}`;
    const closeScope = supervisor.acquireScopeCleanup(scope, { processTree: "required-all" });
    const observed = { stdout: "", stderr: "" };
    const nativeAdmission = createDeferredCore();
    let launchGrants = 0;
    let ready = false;
    const starting = supervisor.spawn({
      mode: "child",
      scopeKey: scope,
      argv: [process.execPath, "-e", script],
      cwd,
      stdinMode: "pipe-closed",
      timeoutMs: 10_000,
      secretInput: { fd: 3, createData: () => secret },
      initiateSpawn(launch, settlement) {
        launchGrants++;
        if (!settlement) {
          throw new Error("Relay launch did not retain native admission");
        }
        void settlement.then(() => nativeAdmission.resolve(), nativeAdmission.reject);
        return launch();
      },
      onStdout: (chunk) => {
        observed.stdout += chunk;
      },
      onStderr: (chunk) => {
        observed.stderr += chunk;
      },
    });
    void starting.then(() => {
      ready = true;
    }, nativeAdmission.reject);
    try {
      await nativeAdmission.promise;
      expect(launchGrants).toBe(1);
      await expect
        .poll(() => observed, { timeout: 5_000 })
        .toEqual({
          stdout: body,
          stderr: "stderr tail\n",
        });
      expect(ready).toBe(false);
      if (operation === "consume") {
        writeFileSync(release, "consume");
      } else {
        supervisor.cancelScope(scope);
      }
      const run = await starting;
      const result = await run.wait();
      expect(result.reason).toBe(operation === "consume" ? "exit" : "manual-cancel");
      expect(result.stdout).toBe(body + (operation === "consume" ? expectedHash : ""));
      expect(result.stderr).toBe("stderr tail\n");
      expect(secret.every((byte) => byte === 0)).toBe(true);
      if (operation === "consume") {
        await closeScope();
      } else {
        await expect(closeScope()).rejects.toThrow("construction aborted");
      }
    } finally {
      writeFileSync(release, "consume");
      supervisor.cancelScope(scope);
      await starting.then(
        (run) => run.wait(),
        () => undefined,
      );
      await closeScope().catch(() => undefined);
    }
  },
  15_000,
);

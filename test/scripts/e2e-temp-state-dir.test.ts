import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createE2eStateDir } from "../../scripts/e2e/lib/temp-state-dir.ts";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe("E2E temp state dirs", () => {
  it.each([false, true])(
    "cleans only generated state dirs (caller-provided=%s)",
    async (provided) => {
      const root = provided ? dirs.make("openclaw-e2e-temp-state-existing-") : "";
      const state = await createE2eStateDir("openclaw-e2e-temp-state-test-", {
        OPENCLAW_STATE_DIR: root,
      });
      expect(state).toMatchObject(
        provided ? { created: false, stateDir: root } : { created: true },
      );
      expect(existsSync(state.stateDir)).toBe(true);
      state.cleanup();
      expect(existsSync(state.stateDir)).toBe(provided);
    },
  );

  it.runIf(process.platform !== "win32")("retries failed state cleanup", async () => {
    const root = dirs.make("openclaw-e2e-temp-state-retry-");
    const lockedParent = path.join(root, "locked");
    mkdirSync(lockedParent);

    const prefix = `${path.relative(tmpdir(), lockedParent)}${path.sep}state-`;
    const state = await createE2eStateDir(prefix, { OPENCLAW_STATE_DIR: "" });

    try {
      chmodSync(lockedParent, 0o500);
      expect(() => state.cleanup()).toThrow();
      expect(existsSync(state.stateDir)).toBe(true);
    } finally {
      chmodSync(lockedParent, 0o700);
    }

    state.cleanup();
    expect(existsSync(state.stateDir)).toBe(false);
  });

  it("cleans generated state dirs on termination signals", async ({ signal }) => {
    const root = dirs.make("openclaw-e2e-temp-state-signal-");
    const scriptPath = path.join(root, "probe.mjs");
    const helperUrl = pathToFileURL(path.resolve("scripts/e2e/lib/temp-state-dir.ts")).href;
    writeFileSync(
      scriptPath,
      `import { createE2eStateDir } from ${JSON.stringify(helperUrl)};

const state = await createE2eStateDir(${JSON.stringify(`${path.relative(tmpdir(), root)}${path.sep}state-`)}, {
  OPENCLAW_STATE_DIR: "",
});
state.registerExitCleanup();
process.send(state.stateDir);
setInterval(() => {}, 1000);
`,
    );

    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const closed = once(child, "close");
    const ready = once(child, "message").then(([stateDir]) => {
      if (typeof stateDir !== "string") {
        throw new Error("Expected generated state directory readiness");
      }
      return stateDir;
    });
    try {
      const stateDir = await withinTest(
        awaitGateBeforeSettlement(ready, closed, "Timed out waiting for state directory readiness"),
        signal,
      );
      expect(existsSync(stateDir)).toBe(true);

      child.kill("SIGTERM");
      expect(await withinTest(closed, signal)).toEqual([null, "SIGTERM"]);
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await closed;
    }
  });
});

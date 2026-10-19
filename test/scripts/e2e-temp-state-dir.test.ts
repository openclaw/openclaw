// E2E Temp State Dir tests cover e2e temp state dir script behavior.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createE2eStateDir } from "../../scripts/e2e/lib/temp-state-dir.ts";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

describe("E2E temp state dirs", () => {
  it("cleans generated state dirs", async () => {
    const state = await createE2eStateDir("openclaw-e2e-temp-state-test-", {
      OPENCLAW_STATE_DIR: "",
    });

    expect(state.created).toBe(true);
    expect(existsSync(state.stateDir)).toBe(true);
    state.cleanup();
    expect(existsSync(state.stateDir)).toBe(false);
  });

  it("leaves caller-provided state dirs alone", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-e2e-temp-state-existing-"));
    try {
      const state = await createE2eStateDir("openclaw-e2e-temp-state-test-", {
        OPENCLAW_STATE_DIR: root,
      });

      expect(state).toMatchObject({ created: false, stateDir: root });
      state.cleanup();
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "retries generated state cleanup after a failed removal",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-e2e-temp-state-retry-"));
      const lockedParent = path.join(root, "locked");
      mkdirSync(lockedParent);

      const state = await createE2eStateDir(
        `${path.relative(tmpdir(), lockedParent)}${path.sep}state-`,
        {
          OPENCLAW_STATE_DIR: "",
        },
      );

      try {
        chmodSync(lockedParent, 0o500);
        expect(() => state.cleanup()).toThrow();
        expect(existsSync(state.stateDir)).toBe(true);
      } finally {
        chmodSync(lockedParent, 0o700);
      }

      state.cleanup();
      expect(existsSync(state.stateDir)).toBe(false);

      rmSync(root, { force: true, recursive: true });
    },
  );

  it("cleans generated state dirs on termination signals", async ({ signal }) => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-e2e-temp-state-signal-"));
    try {
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
      const closed = waitForExit(child);
      const ready = new Promise<string>((resolve, reject) => {
        child.once("message", (stateDir: unknown) => {
          if (typeof stateDir === "string") {
            resolve(stateDir);
          } else {
            reject(new Error("Expected generated state directory readiness"));
          }
        });
      });
      try {
        const stateDir = await withinTest(
          awaitGateBeforeSettlement(
            ready,
            closed,
            `Timed out waiting for ${path.join(root, "state-path")}`,
          ),
          signal,
        );
        expect(existsSync(stateDir)).toBe(true);

        child.kill("SIGTERM");
        const exit = await withinTest(closed, signal);
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        expect(existsSync(stateDir)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        await closed;
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

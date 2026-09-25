import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";

const dirs = createTempDirTracker();
afterEach(() => dirs.cleanup());

it.each([false, true])(
  "keeps runtime logs out of the receipt when failure=%s",
  async (failure) => {
    const root = dirs.make("review-output-");
    const worker = path.join(root, "worker.mts");
    const outcome = { status: "succeeded", summary: "Reviewed", facts: {}, artifacts: [] };
    await fs.writeFile(
      worker,
      `const { writeSupervisedReviewOutcome } = await import(${JSON.stringify(new URL("./supervised-review-output.ts", import.meta.url).href)});
const { createSubsystemLogger } = await import(${JSON.stringify(new URL("../logging/subsystem.ts", import.meta.url).href)});
try {
  await writeSupervisedReviewOutcome(async () => {
    createSubsystemLogger("agent/cli-backend").info("native reviewer startup");
    console.log("reviewer console output");
    if (${failure}) throw new Error("private provider exception");
    return ${JSON.stringify(outcome)};
  });
} catch { process.exitCode = 7; }
`,
    );
    const result = await promisify(execFile)(
      process.execPath,
      resolveRuntimeWorkerArgv(pathToFileURL(worker)),
      {
        cwd: root,
        timeout: 20_000,
        env: { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_LOG_LEVEL: "info" },
      },
    ).catch((error: unknown) => {
      if (!failure) {
        throw error;
      }
      expect(error).toMatchObject({ code: 7 });
      return error as { stdout: string; stderr: string };
    });
    expect(result.stdout).toBe(failure ? "" : JSON.stringify(outcome));
    expect(result.stderr).toContain("native reviewer startup");
    expect(result.stderr).toContain("reviewer console output");
    expect(result.stderr).not.toContain("private provider exception");
  },
  30_000,
);

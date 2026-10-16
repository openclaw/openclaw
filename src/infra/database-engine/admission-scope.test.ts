import { fork } from "node:child_process";
import { getEnvironmentData } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import { assertEngineStoreExecutionAllowed, withEngineStoreAdmission } from "./admission-scope.js";

describe("engine admission scope", () => {
  it("ends synchronous admission when a callback returns or throws", () => {
    expect(withEngineStoreAdmission(() => "admitted")).toBe("admitted");
    expect(() => withEngineStoreAdmission(() => Promise.resolve())).toThrow("remain synchronous");
    expect(() =>
      withEngineStoreAdmission(() => {
        throw new Error("failed admission");
      }),
    ).toThrow("failed admission");
    // This test also runs in the thread pool; the subprocess proves the main-thread boundary.
    expect(withEngineStoreAdmission(assertEngineStoreExecutionAllowed)).toBeUndefined();
  });

  it("refuses main-thread construction and use after boot admission", async () => {
    const url = new URL("./admission-main.test-support.ts", import.meta.url);
    const child = fork(url, [], {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    const connection = getEnvironmentData("openclaw.test.workboard.connection");
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", (code) => {
          reject(new Error(`Main-thread probe exited ${code} before replying: ${stderr}`));
        });
        child.send({ connection: typeof connection === "string" ? connection : undefined });
      });
      expect(result).toMatchObject({ constructionRefused: true });
      if (typeof connection === "string") {
        expect(result).toMatchObject({ scopeRead: { value: 7 }, retainedReadRefused: true });
      }
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill();
        });
      }
    }
  });
});

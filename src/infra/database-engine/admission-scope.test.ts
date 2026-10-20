import { fork } from "node:child_process";
import { getEnvironmentData, Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import { assertEngineStoreExecutionAllowed, withEngineStoreAdmission } from "./admission-scope.js";

describe("engine admission scope", () => {
  it.each([
    { role: undefined, allowed: false, changeRefused: false },
    { role: "gateway", allowed: false, changeRefused: true },
    { role: "cli-oneshot", allowed: true, changeRefused: true },
  ])("enforces the immutable main-thread role: $role", async (expected) => {
    const url = new URL("./admission-role.test-support.ts", import.meta.url);
    const child = fork(url, [], {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
    });
    try {
      const result = new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Role probe exited before replying")));
      });
      child.send({ role: expected.role });
      expect(await result).toEqual({
        allowed: expected.allowed,
        changeRefused: expected.changeRefused,
        ...(expected.role === "cli-oneshot" ? { gatewayRefused: true } : {}),
      });
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
    }
  });

  it("allows worker execution without a process role", async () => {
    const url = new URL("./admission-role.test-support.ts", import.meta.url);
    const worker = new Worker(url, { execArgv: resolveRuntimeWorkerThreadExecArgv(url) });
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", () => reject(new Error("Worker exited before replying")));
      });
      expect(result).toEqual({ allowed: true, changeRefused: false });
    } finally {
      await worker.terminate();
    }
  });

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

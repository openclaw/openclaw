import { fork } from "node:child_process";
import type { EventEmitter } from "node:events";
import { getEnvironmentData, Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import { assertEngineStoreExecutionAllowed, withEngineStoreAdmission } from "./admission-scope.js";

function receive(probe: EventEmitter, failure = () => "Probe exited before replying") {
  return new Promise<unknown>((resolve, reject) => {
    probe.once("message", resolve);
    probe.once("error", reject);
    probe.once("exit", () => reject(new Error(failure())));
  });
}

async function probeChild(url: URL, input: object, check: (result: unknown) => void) {
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
  try {
    const pending = receive(child, () => "Probe exited before replying: " + stderr);
    child.send(input);
    const result = await pending;
    check(result);
    expect(await exited).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  }
}

it.each([
  { role: undefined, allowed: false, changeRefused: false },
  { role: "gateway", allowed: false, changeRefused: true },
  { role: "cli-oneshot", allowed: true, changeRefused: true },
])("enforces the immutable main-thread role: $role", async ({ role, ...expected }) => {
  await probeChild(
    new URL("./admission-role.test-support.ts", import.meta.url),
    { role },
    (result) => {
      expect(result).toEqual({
        ...expected,
        ...(role === "cli-oneshot" ? { gatewayRefused: true } : {}),
      });
    },
  );
});

it("allows worker execution without a process role", async () => {
  const url = new URL("./admission-role.test-support.ts", import.meta.url);
  const worker = new Worker(url, { execArgv: resolveRuntimeWorkerThreadExecArgv(url) });
  try {
    expect(await receive(worker)).toEqual({ allowed: true, changeRefused: false });
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
  expect(withEngineStoreAdmission(assertEngineStoreExecutionAllowed)).toBeUndefined();
});

it("refuses main-thread construction and use after boot admission", async () => {
  const connection = getEnvironmentData("openclaw.test.workboard.connection");
  await probeChild(
    new URL("./admission-main.test-support.ts", import.meta.url),
    { connection: typeof connection === "string" ? connection : undefined },
    (result) =>
      expect(result).toMatchObject({
        constructionRefused: true,
        ...(typeof connection === "string"
          ? { scopeRead: { value: 7 }, retainedReadRefused: true }
          : {}),
      }),
  );
});

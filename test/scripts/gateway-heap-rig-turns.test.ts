import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { configureHeapRigTurns } from "../../scripts/lib/gateway-heap-rig-turns.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["response preparation", "session creation"])(
  "does not launch a turn when admission closes during %s",
  async (closeAt) => {
    const driver = await configureHeapRigTurns({}, tempDirs.make("heap-rig-turns-"), 19549);
    let admissionOpen = true;
    const rpc = vi.fn(async (method: string, params: { key?: string }) => {
      if (closeAt === "session creation" && method === "sessions.create") {
        admissionOpen = false;
        return { ok: true, key: params.key, sessionId: "synthetic-session" };
      }
      throw new Error("Expired admission launched a Gateway request");
    });
    const turn = driver.runTurn(rpc, 0, {
      agentId: "main",
      canStart: () => admissionOpen,
    });
    if (closeAt === "response preparation") {
      admissionOpen = false;
    }

    await expect(turn).resolves.toBeNull();
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(
      closeAt === "session creation" ? ["sessions.create"] : [],
    );
  },
);

it.each(["code", "subagent"])("emits executable %s code through chat.send", async (kind) => {
  const driver = await configureHeapRigTurns({}, tempDirs.make("heap-rig-turns-"), 19549);
  const stopBeforeDispatch = new Error("fixture stops before Gateway execution");
  const rpc = vi.fn(async (method: string, params: { key?: string }) => {
    if (method === "sessions.create") {
      return { ok: true, key: params.key, sessionId: "synthetic-session" };
    }
    throw stopBeforeDispatch;
  });

  await expect(
    driver.runTurn(rpc, 0, { kind, agentId: "main", canStart: () => true }),
  ).rejects.toBe(stopBeforeDispatch);

  const control = JSON.parse(await readFile(driver.responseControlPath, "utf8"));
  const item = control.responses[0].events.find(
    (event: { type: string }) => event.type === "response.output_item.done",
  ).item;
  const { code } = JSON.parse(item.arguments);
  expect(() => new Script(`(async () => { ${code} })`)).not.toThrow();
  expect(rpc).toHaveBeenLastCalledWith(
    "chat.send",
    expect.objectContaining({ sessionKey: "agent:main:heap-rig-pool-0", agentId: "main" }),
    120_000,
  );
});

it("refuses pool replacement when the existing session cannot be deleted", async () => {
  const driver = await configureHeapRigTurns({}, tempDirs.make("heap-rig-turns-"), 19549);
  const rejectedSend = new Error("Gateway rejected the send before admission");
  const rpc = vi.fn(async (method: string, params: { key?: string }) => {
    if (method === "sessions.create") {
      return { ok: true, key: params.key, sessionId: "synthetic-session" };
    }
    if (method === "sessions.patch") {
      return { ok: true };
    }
    if (method === "sessions.delete") {
      return { ok: true, key: params.key, deleted: false };
    }
    throw rejectedSend;
  });
  await expect(driver.runTurn(rpc, 0, { kind: "code", agentId: "main" })).rejects.toBe(
    rejectedSend,
  );
  rpc.mockClear();

  await expect(driver.runTurn(rpc, 32, { agentId: "main" })).rejects.toThrow(
    "Synthetic session cleanup failed",
  );

  expect(rpc.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "sessions.delete"]);
  for (const [, params] of rpc.mock.calls) {
    expect(params).toMatchObject({
      key: "agent:main:heap-rig-pool-0",
      expectedSessionId: "synthetic-session",
    });
  }
  expect(driver.counts.created).toBe(1);
  expect(driver.counts.deleted).toBe(0);
});

it("counts source bytes and separates executed and idle functions in the main census", async () => {
  const { fork } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = tempDirs.make("main-module-census-");
  const fixture = join(root, "fixture.mjs");
  const source =
    'export function called() { return "🦞"; }\nexport function idle() { return 42; }\n' +
    "export const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));\n";
  await writeFile(fixture, source);
  const driver = join(root, "driver.mjs");
  await writeFile(
    driver,
    `process.on("message", async (message) => {
    if (message.action === "exercise") {
      const module = await import(${JSON.stringify(pathToFileURL(fixture).href)});
      module.called();
      process.send({ exercised: true });
    }
  });\nprocess.channel.ref();\nprocess.send({ ready: true });\n`,
  );
  const child = fork(driver, [], {
    execPath: resolveTestNodeExecPath(),
    execArgv: [
      "--import",
      new URL("../../scripts/perf/main-module-census-preload.mjs", import.meta.url).href,
    ],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const receive = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      child.once("message", (message) => resolve(message as Record<string, unknown>));
      child.once("error", reject);
    });
  const command = async (action: string, output?: string) => {
    const response = receive();
    child.send({ channel: "main-module-census", id: action, action, output });
    expect(await response).not.toHaveProperty("error");
  };
  try {
    await receive();
    await command("coverage-start");
    const exercised = receive();
    child.send({ action: "exercise" });
    expect(await exercised).toEqual({ exercised: true });
    const output = join(root, "census.json");
    await command("capture", output);
    const census = JSON.parse(await readFile(output, "utf8"));
    const script = census.scripts.find((row: { url: string }) => row.url.endsWith("/fixture.mjs"));
    expect(script.sourceBytes).toBe(Buffer.byteLength(source));
    const wasm = census.scripts.find((row: { url: string }) => row.url.startsWith("wasm:"));
    expect(wasm).toMatchObject({ sourceBytes: 0, bytecodeBytes: 8 });
    const coverage = census.execution.find(
      (row: { scriptId: string }) => row.scriptId === script.scriptId,
    );
    expect(coverage.functions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionName: "called",
          ranges: expect.arrayContaining([expect.objectContaining({ count: 1 })]),
        }),
        expect.objectContaining({
          functionName: "idle",
          ranges: expect.arrayContaining([expect.objectContaining({ count: 0 })]),
        }),
      ]),
    );
    await command("stats");
  } finally {
    child.kill();
    await exited;
  }
});

import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { defaultRuntime } from "../runtime.js";
import { registerLogsCli } from "./logs-cli.js";
import { CliPluginInvocationResources } from "./plugin-invocation-resources.js";
import {
  registerSignalExitGate,
  waitForCliSignalExit,
  waitForSignalExitBarriers,
} from "./signal-exit-barrier.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn<typeof import("./gateway-rpc.js").callGatewayFromCli>(),
  readConfig: vi.fn<() => object>(),
  readTail: vi.fn<typeof import("../logging/log-tail.js").readConfiguredLogTail>(),
  readService: vi.fn<typeof import("./logs-cli.runtime.js").readSystemdServiceRuntime>(),
  readJournal: vi.fn<typeof import("./logs-cli.runtime.js").execFileUtf8Tail>(),
  delay:
    vi.fn<(ms: number, value: undefined, options: { signal?: AbortSignal }) => Promise<void>>(),
}));

vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));

// mock-isolation: No real Gateway config, credentials, or transport in command lifecycle proof.
vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
  isGatewayTransportError: () => false,
}));

// mock-isolation: Keep local config and its database outside this command fixture.
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: mocks.readConfig,
}));

// mock-isolation: Local file I/O is controlled at the log source boundary.
vi.mock("../logging/log-tail.js", () => ({ readConfiguredLogTail: mocks.readTail }));

// mock-isolation: Journal and service commands must never spawn in this lifecycle fixture.
vi.mock("./logs-cli.runtime.js", () => ({
  readSystemdServiceRuntime: mocks.readService,
  execFileUtf8Tail: mocks.readJournal,
  resolveGatewaySystemdServiceName: () => "openclaw-gateway",
}));

vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCli: mocks.callGateway,
}));

let delayStarted = createDeferred<{ ms: number; signal?: AbortSignal }>();
const stdout: string[] = [];
const stderr: string[] = [];
const stopCommands: Array<() => void> = [];
const finishIo: Array<() => void> = [];
const commands: Array<Promise<unknown>> = [];

async function expectCancelled(code: number) {
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(await waitForCliSignalExit()).toBe(code);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.readConfig.mockReturnValue({});
  mocks.readService.mockResolvedValue({ status: "stopped" });
  delayStarted = createDeferred();
  for (const list of [stdout, stderr, stopCommands, finishIo, commands]) {
    list.length = 0;
  }
  for (const [stream, output] of [
    [process.stdout, stdout],
    [process.stderr, stderr],
  ] as const) {
    vi.spyOn(stream, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  }
  vi.spyOn(defaultRuntime, "exit");
  // The fake clock controls the node:timers/promises seam, including cancellation.
  mocks.delay.mockImplementation(
    (ms, _value, { signal }) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, ms);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        finishIo.push(() => {
          signal?.removeEventListener("abort", abort);
          clearTimeout(timer);
          reject(new Error("fixture stopped"));
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
        delayStarted.resolve({ ms, signal });
      }),
  );
});

afterEach(async () => {
  for (const stop of stopCommands) {
    stop();
  }
  for (const finish of finishIo) {
    finish();
  }
  await Promise.allSettled(commands);
  await waitForCliSignalExit();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function startLogs(args: string[] = [], dispose = vi.fn(async () => {})) {
  const resources = new CliPluginInvocationResources();
  resources.adopt({ release: dispose });
  const program = new Command();
  registerLogsCli(program);
  const command = (async () => {
    try {
      return await resources.run(() =>
        program.parseAsync(["logs", "--follow", "--json", ...args], { from: "user" }),
      );
    } finally {
      await resources.release();
    }
  })();
  // Same command-completion gate and resource owner used by executable CLI cleanup.
  const finished = command.then(
    () => {},
    () => {},
  );
  const releaseGate = registerSignalExitGate(finished, (signal) => {
    resources.beginClose(new DOMException(`CLI stopping (${signal})`, "AbortError"));
  });
  void command.then(releaseGate, releaseGate);
  stopCommands.push(() => {
    releaseGate();
    resources.beginClose();
  });
  commands.push(command);
  return {
    command,
    dispose,
    admitted: <T>(gate: PromiseLike<T>, message: string) =>
      awaitGateBeforeSettlement(gate, command, message),
  };
}

const disconnected = () => new Error("gateway closed (1006 abnormal closure): disconnected");
const journalPage = (line: string) => ({
  stdout: `${line}\n-- cursor: s=abc`,
  code: 0,
  truncated: false,
});

it.each([
  { mode: "rpc", signal: "SIGINT", code: 130 },
  { mode: "rpc", signal: "SIGTERM", code: 143 },
  { mode: "poll", signal: "SIGINT", code: 130 },
  { mode: "retry", signal: "SIGINT", code: 130 },
  { mode: "local-file", signal: "SIGINT", code: 130 },
] as const)("cancels $mode work and preserves $signal status", async ({ mode, signal, code }) => {
  const started = createDeferred<AbortSignal | undefined>();
  if (mode === "rpc") {
    mocks.callGateway.mockImplementationOnce(
      (_method, _opts, _params, extra) =>
        new Promise((_resolve, reject) => {
          finishIo.push(() => reject(new Error("fixture stopped")));
          extra?.signal?.addEventListener("abort", () => reject(disconnected()), { once: true });
          started.resolve(extra?.signal);
        }),
    );
  } else if (mode === "retry") {
    mocks.callGateway.mockRejectedValueOnce(disconnected());
  } else if (mode === "local-file") {
    mocks.readConfig.mockImplementation(() => {
      throw new Error("invalid config");
    });
    mocks.readTail.mockResolvedValueOnce({
      file: "/logs/gateway.log",
      cursor: 8,
      size: 8,
      lines: ["local line"],
      truncated: false,
      reset: false,
    });
  } else {
    mocks.callGateway.mockResolvedValueOnce({
      file: "/logs/gateway.log",
      cursor: 8,
      lines: ["rpc line"],
    });
  }
  const { command, dispose, admitted } = startLogs(
    mode === "retry" ? ["--url", "ws://localhost:18789"] : [],
  );
  const activeSignal =
    mode === "rpc"
      ? await admitted(started.promise, "RPC not admitted")
      : (await admitted(delayStarted.promise, "Delay not admitted")).signal;
  expect(activeSignal).toBeDefined();
  if (mode !== "rpc") {
    expect((await delayStarted.promise).ms).toBeGreaterThan(0);
  } else {
    expect({ stdout, stderr }).toEqual({ stdout: [], stderr: [] });
    expect(mocks.readService).not.toHaveBeenCalled();
  }
  const outputBeforeStop = { stdout: [...stdout], stderr: [...stderr] };
  await waitForSignalExitBarriers(signal);
  await command;
  expect(activeSignal?.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  expect(mocks.callGateway).toHaveBeenCalledTimes(mode === "local-file" ? 0 : 1);
  expect(mocks.readTail).toHaveBeenCalledTimes(mode === "local-file" ? 1 : 0);
  expect({ stdout, stderr }).toEqual(outputBeforeStop);
  await expectCancelled(code);
});

it("preserves terminal RPC failure output and the runtime exit outcome", async () => {
  mocks.callGateway.mockRejectedValueOnce(new Error("logs request denied"));
  const { command, dispose } = startLogs();
  await expect(command).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(defaultRuntime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
  expect(stderr.join(" ")).toContain(
    '"type":"error","message":"logs request denied","error":"logs request denied"',
  );
  expect(stdout).toEqual([]);
  expect(dispose).toHaveBeenCalledOnce();
  expect(mocks.delay).not.toHaveBeenCalled();
  expect(mocks.readService).not.toHaveBeenCalled();
  expect(await waitForCliSignalExit()).toBeUndefined();
});

it("joins cancelled journal recovery before releasing command resources", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const probeStarted = createDeferred<AbortSignal | undefined>();
  const finishProbe = createDeferred();
  const journalStarted = createDeferred();
  const finishJournal = createDeferred<ReturnType<typeof journalPage>>();
  const order: string[] = [];
  mocks.callGateway
    .mockRejectedValueOnce(disconnected())
    .mockImplementationOnce(async (_method, _opts, _params, extra) => {
      finishIo.push(() => finishProbe.reject(new Error("fixture stopped")));
      probeStarted.resolve(extra?.signal);
      await finishProbe.promise;
      order.push("probe settled");
      return { cursor: 10, lines: ["late recovery line"] };
    });
  mocks.readService.mockResolvedValue({ status: "running", pid: 2557 });
  mocks.readJournal
    .mockResolvedValueOnce(journalPage("journal bridge line"))
    .mockImplementationOnce(() => {
      finishIo.push(() => finishJournal.reject(new Error("fixture stopped")));
      journalStarted.resolve();
      return finishJournal.promise;
    });
  const dispose = vi.fn(async () => {
    order.push("resources released");
  });
  const { command, admitted } = startLogs([], dispose);
  const probeSignal = await admitted(probeStarted.promise, "No recovery probe");
  const waiting = await admitted(delayStarted.promise, "No journal interval");
  await vi.advanceTimersByTimeAsync(waiting.ms);
  await admitted(journalStarted.promise, "No next journal page");
  const stopping = waitForSignalExitBarriers("SIGTERM");
  expect(probeSignal?.aborted).toBe(true);
  // Cancellation may race successful I/O; never print it or admit another probe.
  finishJournal.resolve(journalPage("late journal line"));
  await vi.advanceTimersByTimeAsync(0);
  expect(dispose).not.toHaveBeenCalled();
  finishProbe.resolve();
  await stopping;
  await command;
  expect(order).toEqual(["probe settled", "resources released"]);
  expect(mocks.callGateway).toHaveBeenCalledTimes(2);
  expect(mocks.readJournal).toHaveBeenCalledTimes(2);
  expect(mocks.readTail).not.toHaveBeenCalled();
  expect(stdout.join("")).toContain("journal bridge line");
  expect(stdout.join("")).not.toContain("late");
  expect(stderr).toEqual([]);
  await expectCancelled(143);
});

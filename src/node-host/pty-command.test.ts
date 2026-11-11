import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import {
  decodeNodePtyResumeParams,
  decodeNodePtyStartParams,
  runNodePtyCommand,
} from "./pty-command.js";

const { nodePtySpawn } = vi.hoisted(() => ({ nodePtySpawn: vi.fn() }));

vi.mock("@lydell/node-pty", () => ({ spawn: nodePtySpawn }));

type TerminalPtyHandle = Awaited<ReturnType<NonNullable<Parameters<typeof runNodePtyCommand>[2]>>>;
const command = { file: "/usr/bin/codex", args: [], cols: 80, rows: 24 };
const resize = { kind: "resize", cols: 100, rows: 30 };
function createPtyFixture() {
  const controller = new AbortController();
  const pty = {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn<TerminalPtyHandle["onData"]>(),
    onExit: vi.fn<TerminalPtyHandle["onExit"]>(),
  } satisfies TerminalPtyHandle;
  const io = {
    signal: controller.signal,
    emitChunk: vi.fn(async () => {}),
    onInput: vi.fn<OpenClawPluginNodeHostCommandIo["onInput"]>(),
  } satisfies OpenClawPluginNodeHostCommandIo;
  const input = (payload: object) => io.onInput.mock.lastCall?.[0](JSON.stringify(payload));
  return {
    pty,
    io,
    controller,
    data: (chunk: string) => pty.onData.mock.lastCall?.[0](chunk),
    exit: (event: { exitCode: number; signal?: number }) => pty.onExit.mock.lastCall?.[0](event),
    input,
    sendInputs: () => {
      input({ kind: "data", data: "keys" });
      input(resize);
    },
    run: (
      params: Partial<Parameters<typeof runNodePtyCommand>[0]> = {},
      spawn?: Parameters<typeof runNodePtyCommand>[2],
    ) => runNodePtyCommand({ ...command, ...params }, io, spawn),
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  nodePtySpawn.mockReset();
});

it("validates closed resume params", () => {
  const validate = (value: unknown) => {
    if (typeof value !== "string" || !value) {
      throw new Error("bad thread");
    }
    return value;
  };
  const params = { threadId: "id", cols: 80, rows: 24 };
  expect(decodeNodePtyResumeParams(JSON.stringify(params), validate)).toEqual(params);
  expect(() =>
    decodeNodePtyResumeParams(JSON.stringify({ ...params, argv: ["sh"] }), validate),
  ).toThrow("unknown terminal resume parameter: argv");
});

it.each([{ rows: 2001 }, { initialMessage: "x".repeat(16385) }])(
  "rejects unsafe native-start params %#",
  (override) => {
    expect(() =>
      decodeNodePtyStartParams(
        JSON.stringify({ cwd: process.cwd(), cols: 80, rows: 24, ...override }),
      ),
    ).toThrow("INVALID_REQUEST");
  },
);

it("refuses a selected node directory removed after decoding instead of falling home", async () => {
  const cwd = tempDirs.make("native-start-");
  const input = { cwd, initialMessage: "--help", cols: 100, rows: 30 };
  const params = decodeNodePtyStartParams(JSON.stringify(input));
  expect(params).toEqual(input);
  await fs.rm(cwd, { recursive: true });
  const spawn = vi.fn();
  await expect(
    createPtyFixture().run(
      { file: "codex", args: ["--", params.initialMessage!], ...params, requiredCwd: true },
      spawn,
    ),
  ).rejects.toThrow("existing absolute directory");
  expect(spawn).not.toHaveBeenCalled();
});

it.each(["source", "abort"] as const)(
  "closes PTY admission when %s authority changes during loading",
  async (change) => {
    const { controller, run } = createPtyFixture();
    let sourceCurrent = true;
    const pending = run({
      file: "/synthetic/codex",
      args: ["resume", "thread-1"],
      assertCurrent: () => {
        if (!sourceCurrent) {
          throw new Error("source revoked");
        }
      },
    });
    if (change === "source") {
      sourceCurrent = false;
    } else {
      controller.abort();
    }
    await expect(pending).rejects.toThrow(
      change === "source" ? "source revoked" : "PTY construction aborted",
    );
    expect(nodePtySpawn).not.toHaveBeenCalled();
  },
);

it.each(["abort", "dead PTY exit"])("relays PTY I/O and ignores input after %s", async (mode) => {
  const { pty, io, controller, data, input, sendInputs, exit, run } = createPtyFixture();
  const spawn = vi.fn<NonNullable<Parameters<typeof runNodePtyCommand>[2]>>(async () => pty);
  const result = run(
    {
      args: ["resume", "id"],
      cwd: "/missing/catalog/cwd",
      requiredCwd: false,
      env: { CODEX_HOME: "/catalog/codex-home" },
      pathEnv: "/shell/bin:/usr/bin",
    },
    spawn,
  );
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  expect(spawn.mock.calls[0]?.[0]).toMatchObject({
    cwd: os.homedir(),
    env: {
      PATH: "/shell/bin:/usr/bin",
      CODEX_HOME: "/catalog/codex-home",
      OPENCLAW_TERMINAL: "1",
    },
  });

  data("output");
  await vi.waitFor(() => expect(io.emitChunk).toHaveBeenCalledWith("output"));
  expect(pty.pause).toHaveBeenCalledOnce();
  expect(pty.resume).toHaveBeenCalledOnce();
  input({ kind: "resize", cols: 0, rows: 30 });
  input({ kind: "resize", cols: 80, rows: 2001 });
  expect(pty.resize).not.toHaveBeenCalled();
  if (mode === "dead PTY exit") {
    for (const operation of [pty.write, pty.resize]) {
      operation.mockImplementation(() => {
        throw new Error("dead PTY");
      });
    }
  }
  expect(sendInputs).not.toThrow();
  expect(pty.write).toHaveBeenCalledWith("keys");
  expect(pty.resize).toHaveBeenCalledWith(100, 30);

  const event = mode === "abort" ? { exitCode: 130, signal: 15 } : { exitCode: 0 };
  if (mode === "abort") {
    controller.abort();
    expect(pty.kill).toHaveBeenCalledOnce();
    sendInputs();
  }
  exit(event);
  expect(sendInputs).not.toThrow();
  expect(pty.write).toHaveBeenCalledTimes(1);
  expect(pty.resize).toHaveBeenCalledTimes(1);
  await expect(result).resolves.toEqual(event);
});

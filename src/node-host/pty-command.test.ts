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
function createPtyFixture() {
  let onData: ((chunk: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  let onInput: ((payloadJSON: string) => void) | undefined;
  const controller = new AbortController();
  const pty = {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: (callback) => {
      onData = callback;
    },
    onExit: (callback) => {
      onExit = callback;
    },
  } satisfies TerminalPtyHandle;
  const io = {
    signal: controller.signal,
    emitChunk: vi.fn(async () => {}),
    onInput: (callback) => {
      onInput = callback;
    },
  } satisfies OpenClawPluginNodeHostCommandIo;
  return {
    pty,
    io,
    controller,
    data: (chunk: string) => onData?.(chunk),
    exit: (event: { exitCode: number; signal?: number }) => onExit?.(event),
    input: (payload: object) => onInput?.(JSON.stringify(payload)),
    ready: () => vi.waitFor(() => expect(onInput).toBeDefined()),
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
  expect(decodeNodePtyResumeParams('{"threadId":"id","cols":80,"rows":24}', validate)).toEqual({
    threadId: "id",
    cols: 80,
    rows: 24,
  });
  expect(() =>
    decodeNodePtyResumeParams('{"threadId":"id","cols":80,"rows":24,"argv":["sh"]}', validate),
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
  const params = decodeNodePtyStartParams(
    JSON.stringify({ cwd, initialMessage: "--help", cols: 100, rows: 30 }),
  );
  expect(params).toEqual({ cwd, initialMessage: "--help", cols: 100, rows: 30 });
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
    nodePtySpawn.mockImplementation(() => {
      throw new Error("unexpected PTY spawn");
    });
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

it("relays output, data, resize, abort, and exit", async () => {
  const { pty, io, controller, data, input, exit, run } = createPtyFixture();
  const spawn = vi.fn(async () => pty);
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
  const spawnCalls = spawn.mock.calls as unknown as Array<
    [{ cwd?: string; env?: Record<string, string> }]
  >;
  expect(spawnCalls[0]?.[0]).toMatchObject({
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
  input({ kind: "data", data: "keys" });
  input({ kind: "resize", cols: 100, rows: 30 });
  expect(pty.write).toHaveBeenCalledWith("keys");
  expect(pty.resize).toHaveBeenCalledWith(100, 30);

  controller.abort();
  expect(pty.kill).toHaveBeenCalledOnce();
  input({ kind: "data", data: "after abort" });
  input({ kind: "resize", cols: 120, rows: 40 });
  expect(pty.write).toHaveBeenCalledTimes(1);
  expect(pty.resize).toHaveBeenCalledTimes(1);
  exit({ exitCode: 130, signal: 15 });
  await expect(result).resolves.toEqual({ exitCode: 130, signal: 15 });
});

it("ignores input after exit without touching a dead PTY", async () => {
  const { pty, input, exit, ready, run } = createPtyFixture();
  pty.write.mockImplementation(() => {
    throw new Error("dead PTY write");
  });
  pty.resize.mockImplementation(() => {
    throw new Error("dead PTY resize");
  });
  const result = run(
    {},
    vi.fn(async () => pty),
  );
  await ready();

  expect(() => input({ kind: "data", data: "racing" })).not.toThrow();
  expect(() => input({ kind: "resize", cols: 100, rows: 30 })).not.toThrow();
  expect(pty.write).toHaveBeenCalledOnce();
  expect(pty.resize).toHaveBeenCalledOnce();
  pty.write.mockClear();
  pty.resize.mockClear();

  exit({ exitCode: 0 });
  expect(() => input({ kind: "data", data: "late" })).not.toThrow();
  expect(() => input({ kind: "resize", cols: 100, rows: 30 })).not.toThrow();

  await expect(result).resolves.toEqual({ exitCode: 0 });
  expect(pty.write).not.toHaveBeenCalled();
  expect(pty.resize).not.toHaveBeenCalled();
});

it.runIf(process.platform === "win32")(
  "uses a configured COMSPEC override for Windows batch commands",
  async () => {
    const previousComSpec = process.env.ComSpec;
    const ambientComSpec = "C:\\Windows\\System32\\ambient-cmd.exe";
    const configuredComSpec = "C:\\Windows\\System32\\configured-cmd.exe";
    process.env.ComSpec = ambientComSpec;
    try {
      const { pty, run } = createPtyFixture();
      nodePtySpawn.mockReturnValueOnce({
        ...pty,
        onExit: (callback: (event: { exitCode: number }) => void) => {
          queueMicrotask(() => callback({ exitCode: 0 }));
        },
      });

      await expect(
        run({
          file: "C:\\tools\\catalog-command.cmd",
          args: ["resume", "thread title"],
          env: { COMSPEC: configuredComSpec },
        }),
      ).resolves.toEqual({ exitCode: 0 });

      expect(nodePtySpawn).toHaveBeenCalledWith(
        configuredComSpec,
        ["/d", "/s", "/c", 'C:\\tools\\catalog-command.cmd resume "thread title"'],
        expect.objectContaining({
          env: expect.objectContaining({ COMSPEC: configuredComSpec }),
        }),
      );
      const spawnedEnv = nodePtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>;
      expect(Object.keys(spawnedEnv).filter((key) => key.toUpperCase() === "COMSPEC")).toEqual([
        "COMSPEC",
      ]);
    } finally {
      if (previousComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = previousComSpec;
      }
    }
  },
);

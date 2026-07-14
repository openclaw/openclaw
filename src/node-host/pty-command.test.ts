import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { TerminalPtyHandle } from "../process/terminal-pty.js";
import { decodeNodePtyResumeParams, runNodePtyCommand } from "./pty-command.js";

describe("node PTY command", () => {
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

  it("relays output, data, resize, abort, and exit", async () => {
    let onData: ((chunk: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    let onInput: ((payloadJSON: string) => void) | undefined;
    const pty = {
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      onData: (callback: (chunk: string) => void) => {
        onData = callback;
      },
      onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
        onExit = callback;
      },
    } satisfies TerminalPtyHandle;
    const abort = new AbortController();
    const emitChunk = vi.fn(async () => {});
    const io: OpenClawPluginNodeHostCommandIo = {
      signal: abort.signal,
      emitChunk,
      onInput: (callback) => {
        onInput = callback;
      },
    };
    const spawn = vi.fn(async () => pty);
    const result = runNodePtyCommand(
      {
        file: "/usr/bin/codex",
        args: ["resume", "id"],
        cwd: "/missing/catalog/cwd",
        cols: 80,
        rows: 24,
      },
      io,
      spawn,
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const spawnCalls = spawn.mock.calls as unknown as Array<[{ cwd?: string }]>;
    expect(spawnCalls[0]?.[0].cwd).toBe(os.homedir());

    onData?.("output");
    await vi.waitFor(() => expect(emitChunk).toHaveBeenCalledWith("output"));
    expect(pty.pause).toHaveBeenCalledOnce();
    expect(pty.resume).toHaveBeenCalledOnce();
    onInput?.(JSON.stringify({ kind: "data", data: "keys" }));
    onInput?.(JSON.stringify({ kind: "resize", cols: 100, rows: 30 }));
    expect(pty.write).toHaveBeenCalledWith("keys");
    expect(pty.resize).toHaveBeenCalledWith(100, 30);

    abort.abort();
    expect(pty.kill).toHaveBeenCalledOnce();
    onExit?.({ exitCode: 130, signal: 15 });
    await expect(result).resolves.toEqual({ exitCode: 130, signal: 15 });
  });
});

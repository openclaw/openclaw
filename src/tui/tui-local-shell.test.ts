import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { decodeWindowsOutputBuffer } from "../infra/windows-encoding.js";
import { createLocalShellRunner } from "./tui-local-shell.js";

const createSelector = () => {
  const selector = {
    onSelect: undefined as ((item: { value: string; label: string }) => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    render: () => ["selector"],
    invalidate: () => {},
  };
  return selector;
};

function createShellHarness(params?: {
  spawnCommand?: typeof import("node:child_process").spawn;
  decodeOutputBuffer?: typeof decodeWindowsOutputBuffer;
  env?: Record<string, string>;
}) {
  const messages: string[] = [];
  const chatLog = {
    addSystem: (line: string) => {
      messages.push(line);
    },
  };
  const tui = { requestRender: vi.fn() };
  const openOverlay = vi.fn();
  const closeOverlay = vi.fn();
  let lastSelector: ReturnType<typeof createSelector> | null = null;
  const createSelectorSpy = vi.fn(() => {
    lastSelector = createSelector();
    return lastSelector;
  });
  const spawnCommand = params?.spawnCommand ?? vi.fn();
  const { runLocalShellLine } = createLocalShellRunner({
    chatLog,
    tui,
    openOverlay,
    closeOverlay,
    createSelector: createSelectorSpy,
    spawnCommand,
    ...(params?.decodeOutputBuffer ? { decodeOutputBuffer: params.decodeOutputBuffer } : {}),
    ...(params?.env ? { env: params.env } : {}),
  });
  return {
    messages,
    openOverlay,
    createSelectorSpy,
    spawnCommand,
    runLocalShellLine,
    getLastSelector: () => lastSelector,
  };
}

describe("createLocalShellRunner", () => {
  it("logs denial on subsequent ! attempts without re-prompting", async () => {
    const harness = createShellHarness();

    const firstRun = harness.runLocalShellLine("!ls");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "no", label: "No" });
    await firstRun;

    await harness.runLocalShellLine("!pwd");

    expect(harness.messages).toContain("local shell: not enabled");
    expect(harness.messages).toContain("local shell: not enabled for this session");
    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(harness.spawnCommand).not.toHaveBeenCalled();
  });

  it("sets OPENCLAW_SHELL when running local shell commands", async () => {
    const spawnCommand = vi.fn((_command: string, _options: unknown) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      return {
        stdout,
        stderr,
        on: (event: string, callback: (...args: unknown[]) => void) => {
          if (event === "close") {
            setImmediate(() => callback(0, null));
          }
        },
      };
    });

    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      env: { PATH: "/tmp/bin", USER: "dev" },
    });

    const firstRun = harness.runLocalShellLine("!echo hi");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await firstRun;

    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(spawnCommand).toHaveBeenCalledTimes(1);
    const spawnOptions = spawnCommand.mock.calls[0]?.[1] as { env?: Record<string, string> };
    expect(spawnOptions.env?.OPENCLAW_SHELL).toBe("tui-local");
    expect(spawnOptions.env?.PATH).toBe("/tmp/bin");
    expect(harness.messages).toContain("local shell: enabled for this session");
  });

  it("decodes Windows codepage shell output across split chunks", async () => {
    const spawnCommand = vi.fn((_command: string, _options: unknown) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.on("newListener", (event) => {
        if (event !== "close") {
          return;
        }
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from([0xd0, 0xa1]));
          child.stdout.emit("data", Buffer.from([0xca, 0xd4]));
          child.stderr.emit("data", Buffer.from([0xa3]));
          child.stderr.emit("data", Buffer.from([0xbb]));
          child.emit("close", 0, null);
        });
      });
      return child;
    });

    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      decodeOutputBuffer: (params) =>
        decodeWindowsOutputBuffer({ ...params, platform: "win32", windowsEncoding: "gbk" }),
    });

    const firstRun = harness.runLocalShellLine("!echo cjk");
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await firstRun;

    expect(harness.messages).toContain("[local] 小试");
    expect(harness.messages).toContain("[local] ；");
  });
});

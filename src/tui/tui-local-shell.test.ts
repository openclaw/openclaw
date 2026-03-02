import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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

describe("createLocalShellRunner", () => {
  it("logs denial on subsequent ! attempts without re-prompting", async () => {
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
    const spawnCommand = vi.fn();

    const { runLocalShellLine } = createLocalShellRunner({
      chatLog,
      tui,
      openOverlay,
      closeOverlay,
      createSelector: createSelectorSpy,
      spawnCommand,
    });

    const firstRun = runLocalShellLine("!ls");
    expect(openOverlay).toHaveBeenCalledTimes(1);
    const selector = lastSelector as ReturnType<typeof createSelector> | null;
    selector?.onSelect?.({ value: "no", label: "No" });
    await firstRun;

    await runLocalShellLine("!pwd");

    expect(messages).toContain("local shell: not enabled");
    expect(messages).toContain("local shell: not enabled for this session");
    expect(createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("sets OPENCLAW_SHELL when running local shell commands", async () => {
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

    const { runLocalShellLine } = createLocalShellRunner({
      chatLog,
      tui,
      openOverlay,
      closeOverlay,
      createSelector: createSelectorSpy,
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      env: { PATH: "/tmp/bin", USER: "dev" },
    });

    const firstRun = runLocalShellLine("!echo hi");
    expect(openOverlay).toHaveBeenCalledTimes(1);
    const selector = lastSelector as ReturnType<typeof createSelector> | null;
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await firstRun;

    expect(createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(spawnCommand).toHaveBeenCalledTimes(1);
    const spawnOptions = spawnCommand.mock.calls[0]?.[1] as { env?: Record<string, string> };
    expect(spawnOptions.env?.OPENCLAW_SHELL).toBe("tui-local");
    expect(spawnOptions.env?.PATH).toBe("/tmp/bin");
    expect(messages).toContain("local shell: enabled for this session");
  });
});

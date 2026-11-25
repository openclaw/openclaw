import { AsyncLocalStorage } from "node:async_hooks";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { TuiProcessTerminal } from "./tui-process-terminal.js";

afterEach(() => vi.restoreAllMocks());

it("retains startup context for terminal events and their async continuations", async () => {
  const context = new AsyncLocalStorage<string>();
  const observed: string[] = [];
  let inputDone = Promise.resolve();
  let resizeDone = Promise.resolve();
  let input: (data: string) => void = () => {
    throw new Error("terminal input handler was not installed");
  };
  let resize: () => void = () => {
    throw new Error("terminal resize handler was not installed");
  };
  vi.spyOn(ProcessTerminal.prototype, "start").mockImplementation((onInput, onResize) => {
    input = onInput;
    resize = onResize;
  });
  const terminal = new TuiProcessTerminal();
  context.run("tui-owner", () =>
    terminal.start(
      (data) => {
        observed.push(`${context.getStore()}:input:${data}`);
        inputDone = Promise.resolve().then(() => {
          observed.push(`${context.getStore()}:input-tail`);
        });
      },
      () => {
        observed.push(`${context.getStore()}:resize`);
        resizeDone = Promise.resolve().then(() => {
          observed.push(`${context.getStore()}:resize-tail`);
        });
      },
    ),
  );

  await context.run("terminal-emitter", async () => {
    input("prompt");
    await inputDone;
    resize();
    await resizeDone;
    expect(context.getStore()).toBe("terminal-emitter");
  });
  expect(observed).toEqual([
    "tui-owner:input:prompt",
    "tui-owner:input-tail",
    "tui-owner:resize",
    "tui-owner:resize-tail",
  ]);
});

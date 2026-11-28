import { expect, it, vi } from "vitest";
import {
  detectUnsafeExecControlShellCommand,
  rejectUnsafeExecControlShellCommand,
} from "./exec-control-command-guard.js";

const clock = vi.hoisted(() => ({ now: 0 }));
const reset = vi.hoisted(() => vi.fn());

// mock-isolation: emulate the parser deadline without a slow real timer.
vi.mock("web-tree-sitter", () => ({
  Parser: class {
    static init = async () => {};
    reset = reset;

    setLanguage() {
      return this;
    }

    parse(_source: string, _oldTree: unknown, options: { progressCallback: () => boolean }) {
      clock.now = 501;
      options.progressCallback();
      return null;
    }
  },
  Language: { load: async () => ({}) },
}));

it("reports a parser deadline as a command work limit", async () => {
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  try {
    clock.now = 0;
    await expect(detectUnsafeExecControlShellCommand("echo ready")).resolves.toBe(
      "incomplete-analysis",
    );
    expect(reset).toHaveBeenCalledOnce();

    clock.now = 0;
    await expect(rejectUnsafeExecControlShellCommand("echo ready")).rejects.toThrow(/work limit/);
  } finally {
    now.mockRestore();
  }
});

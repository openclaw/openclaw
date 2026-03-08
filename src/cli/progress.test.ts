import { describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.ts";

const mocks = vi.hoisted(() => {
  const spinnerStart = vi.fn();
  const spinnerStop = vi.fn();
  const spinnerMessage = vi.fn();
  const spinnerFactory = vi.fn(() => ({
    start: spinnerStart,
    stop: spinnerStop,
    message: spinnerMessage,
  }));
  const supportsOscProgress = vi.fn(() => false);
  const createOscProgressController = vi.fn();
  return {
    spinnerStart,
    spinnerStop,
    spinnerMessage,
    spinnerFactory,
    supportsOscProgress,
    createOscProgressController,
  };
});

vi.mock("@clack/prompts", () => ({
  spinner: mocks.spinnerFactory,
}));

vi.mock("osc-progress", () => ({
  supportsOscProgress: mocks.supportsOscProgress,
  createOscProgressController: mocks.createOscProgressController,
}));

import { createCliProgress } from "./progress.js";

describe("cli progress", () => {
  it("logs progress when non-tty and fallback=log", () => {
    const writes: string[] = [];
    const stream = {
      isTTY: false,
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
      }),
    } as unknown as NodeJS.WriteStream;

    const progress = createCliProgress({
      label: "Indexing memory...",
      total: 10,
      stream,
      fallback: "log",
    });
    progress.setPercent(50);
    progress.done();

    const output = writes.join("");
    expect(output).toContain("Indexing memory... 0%");
    expect(output).toContain("Indexing memory... 50%");
  });

  it("does not log without a tty when fallback is none", () => {
    const write = vi.fn();
    const stream = {
      isTTY: false,
      write,
    } as unknown as NodeJS.WriteStream;

    const progress = createCliProgress({
      label: "Nope",
      total: 2,
      stream,
      fallback: "none",
    });
    progress.setPercent(50);
    progress.done();

    expect(write).not.toHaveBeenCalled();
  });

  it("suppresses spinner output when TERM=dumb", () => {
    withEnv({ TERM: "dumb" }, () => {
      const write = vi.fn();
      const stream = {
        isTTY: true,
        write,
      } as unknown as NodeJS.WriteStream;

      const progress = createCliProgress({
        label: "Waiting for agent reply...",
        stream,
      });
      progress.done();

      expect(mocks.spinnerFactory).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    });
  });
});

// Claw banner tests: static/animated gating and the final-frame invariant.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { sleep } from "../utils/sleep.js";
import { printClawBanner } from "./claw-banner.js";

vi.mock("../../packages/terminal-core/src/theme.js", { spy: true });
vi.mock("../utils/sleep.js", { spy: true });

const stdoutProperties = new Map(
  ["columns", "isTTY"].map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]),
);
beforeEach(() => {
  Object.defineProperties(process.stdout, {
    columns: { value: 120, configurable: true, writable: true },
    isTTY: { value: true, configurable: true, writable: true },
  });
  vi.stubEnv("CI", "");
  vi.stubEnv("VITEST", "");
  vi.mocked(isRich).mockReturnValue(true);
  vi.mocked(sleep).mockResolvedValue(undefined);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [key, descriptor] of stdoutProperties) {
    if (descriptor) {
      Object.defineProperty(process.stdout, key, descriptor);
    } else {
      Reflect.deleteProperty(process.stdout, key);
    }
  }
});

function captureOutput() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

const runtimeStub = () => {
  const log = vi.fn();
  return { runtime: { log } as unknown as RuntimeEnv, log };
};

async function runAnimated() {
  const chunks = captureOutput();
  const pauses: number[] = [];
  const { runtime } = runtimeStub();
  vi.mocked(sleep).mockImplementation(async (ms) => {
    pauses.push(ms);
  });
  const result = await printClawBanner(runtime);
  return { chunks, pauses, result };
}

async function runStatic() {
  const { runtime, log } = runtimeStub();
  process.stdout.isTTY = false;
  await printClawBanner(runtime);
  process.stdout.isTTY = true;
  return stripAnsi(String(log.mock.calls[0]?.[0]))
    .split("\n")
    .filter((row) => row.length > 0);
}

describe("printClawBanner", () => {
  it("falls back to the plain title on narrow terminals", async () => {
    const { runtime, log } = runtimeStub();
    process.stdout.columns = 50;
    await printClawBanner(runtime);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("OPENCLAW");
    expect(output).not.toContain("█");
  });

  it("wipes, shimmers once, and snips once within the startup pause budget", async () => {
    const staticRows = await runStatic();
    const { chunks, pauses, result } = await runAnimated();
    expect(result).toBe("completed");
    expect(pauses.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(400);
    expect(pauses).toEqual([...Array<number>(13).fill(20), 35, 35]);
    expect(chunks[0]).toBe("\x1b[?25l");
    expect(chunks).toContain("\x1b[?25h");
    const frames = chunks.filter((chunk) => chunk.includes("\x1b[K"));
    expect(frames).toHaveLength(16);
    expect(
      frames.flatMap((frame, index) => {
        const [first = "", second = ""] = stripAnsi(frame).split("\n");
        return first.slice(0, 20).trimEnd() === "•●•.:.        .:.•●•" &&
          second.slice(0, 20).trimEnd() === ":●●●•:        :•●●●:"
          ? [index]
          : [];
      }),
    ).toEqual([13]);
    const finalRows = stripAnsi(frames[frames.length - 1] ?? "")
      .split("\n")
      .filter((row) => row.length > 0);
    expect(finalRows).toEqual(staticRows);
  });

  it("installs scoped signal handlers only while animating", async () => {
    const before = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    let during = -1;
    let duringSigterm = -1;
    const { runtime } = runtimeStub();
    vi.mocked(sleep).mockImplementation(async () => {
      during = Math.max(during, process.listenerCount("SIGINT"));
      duringSigterm = Math.max(duringSigterm, process.listenerCount("SIGTERM"));
    });
    await printClawBanner(runtime);
    expect(during).toBe(before + 1);
    expect(duringSigterm).toBe(beforeSigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it.each([
    { signal: "SIGINT" as const, code: 130 },
    { signal: "SIGTERM" as const, code: 143 },
  ])("unwinds $signal after restoring its cursor and listeners", async ({ signal, code }) => {
    const previous = process.listeners(signal);
    const chunks = captureOutput();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("forced native exit");
    });
    const { runtime } = runtimeStub();
    vi.mocked(sleep).mockImplementation(async () => {
      const handler = process.listeners(signal).find((listener) => !previous.includes(listener));
      if (!handler) {
        throw new Error("banner signal owner missing");
      }
      handler(signal);
    });
    try {
      await expect(printClawBanner(runtime)).rejects.toEqual(new ExitError(code));
      expect(exit).not.toHaveBeenCalled();
      expect(chunks.at(-1)).toBe("\x1b[?25h");
      expect(process.listeners(signal)).toEqual(previous);
    } finally {
      exit.mockRestore();
    }
  });

  it("settles on the static frame when parallel work finishes first", async () => {
    const staticRows = await runStatic();
    const chunks = captureOutput();
    const beforeSigint = process.listenerCount("SIGINT");
    let settle!: () => void;
    const settleWhen = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const { runtime } = runtimeStub();
    vi.mocked(sleep).mockImplementation(() => new Promise<void>(() => {}));
    const banner = printClawBanner(runtime, { settleWhen });

    expect(chunks[0]).toBe("\x1b[?25l");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    settle();
    await expect(banner).resolves.toBe("settled");

    const frames = chunks.filter((chunk) => chunk.includes("\x1b[K"));
    const finalRows = stripAnsi(frames.at(-1) ?? "")
      .split("\n")
      .filter((row) => row.length > 0);
    expect(finalRows).toEqual(staticRows);
    expect(chunks.at(-2)).toBe("\x1b[?25h");
    expect(chunks.at(-1)).toBe("\n");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
  });
});

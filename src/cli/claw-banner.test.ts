// Claw banner tests: static/animated gating and the final-frame invariant.
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { RuntimeEnv } from "../runtime.js";
import { printClawBanner } from "./claw-banner.js";

const runtimeStub = () => {
  const log = vi.fn();
  return { runtime: { log } as unknown as RuntimeEnv, log };
};

async function runAnimated() {
  const chunks: string[] = [];
  const pauses: number[] = [];
  const { runtime } = runtimeStub();
  const result = await printClawBanner(runtime, {
    columns: 120,
    isTty: true,
    rich: true,
    env: {},
    sleep: async (ms) => {
      pauses.push(ms);
    },
    write: (chunk) => chunks.push(chunk),
  });
  return { chunks, pauses, result };
}

async function runStatic() {
  const { runtime, log } = runtimeStub();
  await printClawBanner(runtime, { columns: 120, isTty: false, env: {} });
  return stripAnsi(String(log.mock.calls[0]?.[0]))
    .split("\n")
    .filter((row) => row.length > 0);
}

describe("printClawBanner", () => {
  it("falls back to the plain title on narrow terminals", async () => {
    const { runtime, log } = runtimeStub();
    await printClawBanner(runtime, { columns: 50, isTty: true, rich: true, env: {} });
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
    await printClawBanner(runtime, {
      columns: 120,
      isTty: true,
      rich: true,
      env: {},
      sleep: async () => {
        during = Math.max(during, process.listenerCount("SIGINT"));
        duringSigterm = Math.max(duringSigterm, process.listenerCount("SIGTERM"));
      },
      write: () => {},
    });
    expect(during).toBe(before + 1);
    expect(duringSigterm).toBe(beforeSigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("settles on the static frame when parallel work finishes first", async () => {
    const staticRows = await runStatic();
    const chunks: string[] = [];
    const beforeSigint = process.listenerCount("SIGINT");
    let settle!: () => void;
    const settleWhen = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const { runtime } = runtimeStub();
    const banner = printClawBanner(runtime, {
      columns: 120,
      isTty: true,
      rich: true,
      env: {},
      settleWhen,
      sleep: () => new Promise<void>(() => {}),
      write: (chunk) => chunks.push(chunk),
    });

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

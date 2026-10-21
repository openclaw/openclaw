import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { sleep } from "../utils/sleep.js";
import { printClawBanner } from "./claw-banner.js";

vi.mock("../../packages/terminal-core/src/theme.js", { spy: true });
vi.mock("../utils/sleep.js", { spy: true });

const chunks: string[] = [];
const log = vi.fn();
const runtime = { log } as unknown as RuntimeEnv;
const stdoutProperties = new Map(
  ["columns", "isTTY"].map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]),
);
beforeEach(() => {
  chunks.length = 0;
  log.mockClear();
  Object.defineProperties(process.stdout, {
    columns: { value: 120, configurable: true, writable: true },
    isTTY: { value: true, configurable: true, writable: true },
  });
  vi.stubEnv("CI", "");
  vi.stubEnv("VITEST", "");
  vi.mocked(isRich).mockReturnValue(true);
  vi.mocked(sleep).mockResolvedValue(undefined);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
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

const rows = (frame: string) => stripAnsi(frame).split("\n").filter(Boolean);
const frames = (output: string[]) => output.filter((chunk) => chunk.includes("\x1b[K"));
const listenerCounts = () =>
  [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")] as const;

async function runStatic() {
  process.stdout.isTTY = false;
  await printClawBanner(runtime);
  process.stdout.isTTY = true;
  return rows(String(log.mock.calls[0]?.[0]));
}

describe("printClawBanner", () => {
  it("falls back to the plain title on narrow terminals", async () => {
    process.stdout.columns = 50;
    await printClawBanner(runtime);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("OPENCLAW");
    expect(output).not.toContain("█");
  });

  it("wipes, shimmers once, and snips once within the startup pause budget", async () => {
    const staticRows = await runStatic();
    const pauses: number[] = [];
    vi.mocked(sleep).mockImplementation(async (ms) => {
      pauses.push(ms);
    });
    expect(await printClawBanner(runtime)).toBe("completed");
    expect(pauses).toEqual([...Array<number>(13).fill(20), 35, 35]);
    expect(chunks[0]).toBe("\x1b[?25l");
    expect(chunks).toContain("\x1b[?25h");
    const animation = frames(chunks);
    expect(animation).toHaveLength(16);
    const openClaws = "•●•.:.        .:.•●•\n:●●●•:        :•●●●:";
    expect(
      animation.flatMap((frame, index) =>
        rows(frame)
          .slice(0, 2)
          .map((row) => row.slice(0, 20))
          .join("\n") === openClaws
          ? [index]
          : [],
      ),
    ).toEqual([13]);
    expect(rows(animation.at(-1) ?? "")).toEqual(staticRows);
  });

  it("installs scoped signal handlers only while animating", async () => {
    const before = listenerCounts();
    let during: [number, number] = [-1, -1];
    vi.mocked(sleep).mockImplementation(async () => {
      const counts = listenerCounts();
      during = [Math.max(during[0], counts[0]), Math.max(during[1], counts[1])];
    });
    await printClawBanner(runtime);
    expect(during).toEqual(before.map((count) => count + 1));
    expect(listenerCounts()).toEqual(before);
  });

  it.each([
    { signal: "SIGINT" as const, code: 130 },
    { signal: "SIGTERM" as const, code: 143 },
  ])("unwinds $signal after restoring its cursor and listeners", async ({ signal, code }) => {
    const previous = process.listeners(signal);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("forced native exit");
    });
    vi.mocked(sleep).mockImplementation(async () => {
      const handler = process.listeners(signal).find((listener) => !previous.includes(listener));
      if (!handler) {
        throw new Error("banner signal owner missing");
      }
      handler(signal);
    });
    await expect(printClawBanner(runtime)).rejects.toEqual(new ExitError(code));
    expect(exit).not.toHaveBeenCalled();
    expect(chunks.at(-1)).toBe("\x1b[?25h");
    expect(process.listeners(signal)).toEqual(previous);
  });

  it("settles on the static frame when parallel work finishes first", async () => {
    const staticRows = await runStatic();
    const beforeSigint = process.listenerCount("SIGINT");
    const { promise: settleWhen, resolve: settle } = createDeferredCore();
    vi.mocked(sleep).mockImplementation(() => new Promise<void>(() => {}));
    const banner = printClawBanner(runtime, { settleWhen });

    expect(chunks[0]).toBe("\x1b[?25l");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    settle();
    await expect(banner).resolves.toBe("settled");

    expect(rows(frames(chunks).at(-1) ?? "")).toEqual(staticRows);
    expect(chunks.slice(-2)).toEqual(["\x1b[?25h", "\n"]);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
  });
});

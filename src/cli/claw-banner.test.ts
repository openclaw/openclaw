import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { sleep } from "../utils/sleep.js";
import { printClawBanner } from "./claw-banner.js";

vi.mock("../../packages/terminal-core/src/theme.js", { spy: true });
vi.mock("../utils/sleep.js", { spy: true });

const chunks: string[] = [];
const runtime = { log: (line: string) => chunks.push(line) } as unknown as RuntimeEnv;
const stdoutProperties = new Map(
  ["columns", "isTTY"].map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]),
);
beforeEach(() => {
  chunks.length = 0;
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
  return rows(chunks.pop()!);
}

it("falls back to the plain title on narrow terminals", async () => {
  process.stdout.columns = 50;
  await printClawBanner(runtime);
  const output = chunks.join("");
  expect(output).toContain("OPENCLAW");
  expect(output).not.toContain("█");
});

it("wipes, shimmers once, and snips once within the startup pause budget", async () => {
  const staticRows = await runStatic();
  const before = listenerCounts();
  let pausedMs = 0;
  vi.mocked(sleep).mockImplementation(async (ms) => {
    pausedMs += ms;
    expect(listenerCounts()).toEqual(before.map((count) => count + 1));
  });
  expect(await printClawBanner(runtime)).toBe("completed");
  expect(listenerCounts()).toEqual(before);
  expect(pausedMs).toBe(330);
  expect(chunks[0]).toBe("\x1b[?25l");
  expect(chunks).toContain("\x1b[?25h");
  const animation = frames(chunks);
  const openClaws = "•●•.:.        .:.•●•\n:●●●•:        :•●●●:";
  const claws = animation.map((frame) => rows(frame).slice(0, 2).join("\n"));
  expect(claws.filter((claw) => claw === openClaws)).toHaveLength(1);
  expect(rows(animation.at(-1) ?? "")).toEqual(staticRows);
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

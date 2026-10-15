import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { runCommandWithTimeout, type CommandOptions } from "./exec.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const digestStdin = `const input=require('node:fs').readFileSync(0);
process.stdout.write(require('node:crypto').createHash('sha256').update(input).digest('hex'));`;

function createInputFile() {
  const root = temporary.make("openclaw-command-stdin-");
  const file = path.join(root, "input");
  const bytes = Buffer.alloc(16_384).fill(Buffer.from([0, 255, 10, 128]));
  fs.writeFileSync(file, bytes);
  return { file, digest: createHash("sha256").update(bytes).digest("hex") };
}

it("inherits binary file input before the caller closes its descriptor", async () => {
  const { file, digest } = createInputFile();
  const descriptor = fs.openSync(file, "r");
  let running: ReturnType<typeof runCommandWithTimeout>;
  try {
    running = runCommandWithTimeout([process.execPath, "-e", digestStdin], {
      stdinFileDescriptor: descriptor,
      timeoutMs: 5_000,
      killProcessTree: true,
    });
  } finally {
    fs.closeSync(descriptor);
  }
  const result = await running;
  expect(result).toMatchObject({ code: 0, termination: "exit", stdout: digest, stderr: "" });
});

it("settles cancellation without closing the caller's file descriptor", async () => {
  const { file, digest } = createInputFile();
  const descriptor = fs.openSync(file, "r");
  const controller = new AbortController();
  let outputBytes = 0;
  try {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", `setInterval(()=>{},1000);${digestStdin}`],
      {
        stdinFileDescriptor: descriptor,
        signal: controller.signal,
        timeoutMs: 5_000,
        killProcessTree: true,
        onOutputChunk: (chunk, stream) => {
          if (stream === "stdout") {
            outputBytes += chunk.length;
            if (outputBytes === digest.length) {
              controller.abort();
            }
          }
        },
      },
    );
    expect(result).toMatchObject({ termination: "signal", stdout: digest });
    expect(result.pid).toBeTypeOf("number");
    expect(isPidAlive(result.pid!)).toBe(false);
    expect(fs.fstatSync(descriptor).isFile()).toBe(true);
  } finally {
    fs.closeSync(descriptor);
  }
});

it.each<{ options: CommandOptions; message: string }>([
  {
    options: { stdinFileDescriptor: 0, input: "payload" },
    message: "either input or stdinFileDescriptor",
  },
  {
    options: { stdinFileDescriptor: 0, beforeInput: () => undefined },
    message: "admission requires explicit input",
  },
  { options: { stdinFileDescriptor: -1 }, message: "nonnegative integer" },
  { options: { stdinFileDescriptor: 0.5 }, message: "nonnegative integer" },
])(
  "rejects ambiguous or invalid file input before spawning: $options",
  async ({ options, message }) => {
    const root = temporary.make("openclaw-command-stdin-rejected-");
    const marker = path.join(root, "spawned");
    await expect(
      runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
          marker,
        ],
        { ...options, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(message);
    expect(fs.existsSync(marker)).toBe(false);
  },
);

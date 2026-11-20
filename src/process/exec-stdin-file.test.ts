import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { runCommandWithTimeout, type CommandOptions } from "./exec.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const digestStdin = `const input=require('node:fs').readFileSync(0);
process.stdout.write(require('node:crypto').createHash('sha256').update(input).digest('hex'));`;
const spawnMarker = "require('node:fs').writeFileSync(process.argv[1], 'spawned')";

function inputFixture() {
  const file = path.join(temporary.make("openclaw-command-stdin-"), "input");
  const bytes = Buffer.alloc(16_384).fill(Buffer.from([0, 255, 10, 128]));
  fs.writeFileSync(file, bytes);
  const descriptor = fs.openSync(file, "r");
  const run = (source = digestStdin, options: CommandOptions = {}) =>
    runCommandWithTimeout([process.execPath, "-e", source], {
      stdinFileDescriptor: descriptor,
      timeoutMs: 5_000,
      killProcessTree: true,
      ...options,
    });
  return { file, descriptor, run, digest: createHash("sha256").update(bytes).digest("hex") };
}

it("inherits binary file input before the caller closes its descriptor", async () => {
  const { descriptor, digest, run } = inputFixture();
  const running = run();
  fs.closeSync(descriptor);
  expect(await running).toMatchObject({ code: 0, termination: "exit", stdout: digest, stderr: "" });
});

it.each(["descriptor", "path"])(
  "settles %s input cancellation without closing the caller's descriptor",
  async (mode) => {
    const { file, descriptor, digest, run } = inputFixture();
    const controller = new AbortController();
    let outputBytes = 0;
    try {
      const result = await run(`setInterval(()=>{},1000);${digestStdin}`, {
        ...(mode === "path" ? { inputFile: file, stdinFileDescriptor: undefined } : {}),
        signal: controller.signal,
        onOutputChunk: (chunk, stream) => {
          outputBytes += stream === "stdout" ? chunk.length : 0;
          if (outputBytes === digest.length) {
            controller.abort();
          }
        },
      });
      expect(result).toMatchObject({
        termination: "signal",
        stdout: digest,
        pid: expect.any(Number),
      });
      expect(isPidAlive(result.pid!)).toBe(false);
      expect(fs.fstatSync(descriptor).isFile()).toBe(true);
    } finally {
      fs.closeSync(descriptor);
    }
  },
);

it.each<[CommandOptions, string]>([
  [{ stdinFileDescriptor: 0, input: "payload" }, "either input or stdinFileDescriptor"],
  [{ stdinFileDescriptor: 0, beforeInput: () => undefined }, "admission requires explicit input"],
  [{ stdinFileDescriptor: -1 }, "nonnegative integer"],
  [{ stdinFileDescriptor: 0.5 }, "nonnegative integer"],
  [{ inputFile: "file", input: "payload" }, "cannot be combined"],
  [{ inputFile: "file", stdinFileDescriptor: 0 }, "cannot be combined"],
  [{ inputFile: "file", beforeInput: () => undefined }, "admission requires explicit input"],
])("rejects ambiguous or invalid file input before spawning: %j", async (options, message) => {
  const marker = path.join(temporary.make("openclaw-command-stdin-rejected-"), "spawned");
  await expect(
    runCommandWithTimeout([process.execPath, "-e", spawnMarker, marker], {
      ...options,
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow(message);
  expect(fs.existsSync(marker)).toBe(false);
});

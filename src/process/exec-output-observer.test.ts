import { expect, it } from "vitest";
import { runExec } from "./exec.js";

it.each([0, 7])(
  "observes both streams before settlement without changing exit %s",
  async (code) => {
    const received = { stdout: "", stderr: "" };
    let settled = false;
    const observations: boolean[] = [];
    const command = runExec(
      process.execPath,
      [
        "-e",
        `console.log('out'); console.error('err'); setTimeout(() => process.exit(${code}), 80)`,
      ],
      {
        timeoutMs: 2_000,
        logOutput: false,
        onOutputChunk: (chunk, stream) => {
          received[stream] += chunk.toString();
          observations.push(settled);
        },
      },
    );
    if (code === 0) {
      await expect(command).resolves.toEqual({ stdout: "out\n", stderr: "err\n" });
    } else {
      await expect(command).rejects.toMatchObject({ code, stdout: "out\n", stderr: "err\n" });
    }
    settled = true;
    expect(received).toEqual({ stdout: "out\n", stderr: "err\n" });
    expect(observations.length).toBeGreaterThanOrEqual(2);
    expect(observations).not.toContain(true);
  },
);

it.each([0, 7])(
  "keeps exit %s and buffered output when a diagnostic observer throws",
  async (code) => {
    const command = runExec(
      process.execPath,
      ["-e", `console.log('retained'); process.exitCode = ${code}`],
      {
        timeoutMs: 2_000,
        onOutputChunk: () => {
          throw new Error("diagnostic unavailable");
        },
      },
    );
    if (code === 0) {
      await expect(command).resolves.toEqual({ stdout: "retained\n", stderr: "" });
    } else {
      await expect(command).rejects.toMatchObject({ code, stdout: "retained\n", stderr: "" });
    }
  },
);

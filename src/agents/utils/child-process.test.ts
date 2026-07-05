import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { waitForChildProcess } from "./child-process.js";

describe.skipIf(process.platform === "win32")("waitForChildProcess", () => {
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

  afterEach(() => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    child = undefined;
  });

  it("drains active descendant output after the parent exits", async () => {
    const command =
      'printf "HEAD\\n"; ( for i in 1 2 3 4 5 6; do sleep 0.05; printf "TICK$i\\n"; done ) &';
    child = spawn("/bin/sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await expect(waitForChildProcess(child)).resolves.toBe(0);
    expect(output).toContain("HEAD");
    expect(output).toContain("TICK6");
  });

  it("releases a quiet inherited pipe after the idle grace", async () => {
    child = spawn("/bin/sh", ["-c", 'printf "DONE\\n"; ( sleep 30 ) &'], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const startedAt = Date.now();
    await expect(waitForChildProcess(child)).resolves.toBe(0);
    expect(output).toContain("DONE");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds draining from a continuously writing descendant", async () => {
    child = spawn(
      "/bin/sh",
      ["-c", 'printf "HEAD\\n"; ( while :; do printf "TICK\\n"; sleep 0.03; done ) &'],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const startedAt = Date.now();
    await expect(waitForChildProcess(child)).resolves.toBe(0);
    expect(output).toContain("TICK");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

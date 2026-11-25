import { deepStrictEqual, ok } from "node:assert/strict";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnCommand } from "../exec-spawn.js";
import { BrokerChild } from "./child.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

describe.skipIf(!supportsSpawnBrokerCommandTransport())("spawn broker pipe handoff", () => {
  let host: SpawnBrokerHost;
  beforeAll(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterAll(() => host.close());
  const spawn = (source: string, stdin: "pipe" | "ignore" = "ignore") =>
    host.spawn(process.execPath, ["-e", source], { stdio: [stdin, "pipe", "pipe"] });

  it("preserves async iteration and resume requested immediately after readiness", async () => {
    const source =
      "process.stdout.write('a'.repeat(2**21));process.stderr.write('b'.repeat(2**21))";
    const child = spawn(source);
    await child.ready();
    const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
    const output = text(child.stdout!);
    void output.catch(() => {});
    child.stderr!.resume();
    await closed;
    expect(await output).toBe("a".repeat(2 * 1024 * 1024));
  });

  it.each(
    (["native", "unbuffered", "buffered"] as const).flatMap((transport) =>
      [0, 137, 2 * 1024 * 1024 + 137].map((size) => ({ transport, size })),
    ),
  )(
    "retains $size early bytes and EOF while a busy host delays $transport handle acknowledgements",
    async ({ transport, size }) => {
      const source = `
        const bytes = Buffer.from(Array.from({length:${size}}, (_, i) => i % 251));
        process.stdout.write(bytes); process.stderr.write(bytes);
        process.stdin.resume();
      `;
      const options = {
        stdin: size > 137 ? "pipe" : "ignore",
        encoding: "buffer",
        buffer: transport === "buffered",
        maxBuffer: size + 1,
      } as const;
      const command =
        transport === "native"
          ? undefined
          : runWithSpawnBroker(host, () => spawnCommand([process.execPath, "-e", source], options));
      const child = command?.nodeChildProcess ?? spawn(source, options.stdin);
      ok(child instanceof BrokerChild, "Fixture did not use the broker");
      await Promise.resolve();
      for (const resumeAt = performance.now() + 200; performance.now() < resumeAt;) {
        /* Model an event-loop stall during asynchronous descriptor transfer. */
      }
      await child.ready();
      expect(child.stdout!.readableEnded).toBe(false);
      expect(child.stderr!.readableEnded).toBe(false);
      if (child.stdin) {
        expect(child.stdin).toHaveProperty("readable", false);
      }
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      child.stdout!.on("data", (chunk: Buffer) => chunks.stdout.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => chunks.stderr.push(chunk));
      const closed = once(child, "close");
      child.stdin?.end();
      await closed;
      await command;
      const expected = Buffer.from(Array.from({ length: size }, (_, index) => index % 251));
      deepStrictEqual(Buffer.concat(chunks.stdout), expected);
      deepStrictEqual(Buffer.concat(chunks.stderr), expected);
    },
  );
});

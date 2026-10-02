import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnBrokerCommand } from "./execa-client.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker pipe handoff", () => {
  let host: SpawnBrokerHost;
  beforeAll(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterAll(async () => {
    await host.close();
  });

  it("preserves async iteration and resume requested immediately after readiness", async () => {
    const child = host.spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('a'.repeat(2*1024*1024));process.stderr.write('b'.repeat(2*1024*1024))",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await child.ready();
    const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
    const output = (async () => {
      let text = "";
      for await (const chunk of child.stdout!) {
        text += chunk;
      }
      return text;
    })();
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
          : spawnBrokerCommand(host, [process.execPath, "-e", source], options, options);
      const child =
        command?.nodeChildProcess ??
        host.spawn(process.execPath, ["-e", source], {
          stdio: [options.stdin, "pipe", "pipe"],
        });
      // The command starts, but the host cannot acknowledge its first pipe yet.
      await Promise.resolve();
      const resumeAt = performance.now() + 200;
      while (performance.now() < resumeAt) {
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

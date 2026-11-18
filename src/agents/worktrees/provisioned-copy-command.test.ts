import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { ProvisionCopyDetails } from "../../infra/fs-safe-copy-worker-contract.js";
import { createProvisionCopyCommand } from "./provisioned-copy-command.js";

afterEach(() => vi.restoreAllMocks());

it.each(["mixed", "legacy", "incomplete"] as const)(
  "reports confirmed clone and fallback work without guessing for %s cp output",
  async (scenario) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new childProcess.ChildProcess(), { stdin, stdout, stderr });
    vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const instrumented = String(args[1]?.[1]).includes("--debug");
      queueMicrotask(() => stdout.write(instrumented ? "R\n" : "R"));
      stdin.on("data", () => {
        if (!instrumented) {
          stdout.write(".");
          return;
        }
        if (scenario !== "legacy") {
          stdout.write("'/proc/self/fd/3/10' -> '/proc/self/fd/3/20/10'\ncopy off");
          stdout.write("load: no, reflink: yes, sparse detection: unknown\n");
          if (scenario === "mixed") {
            stdout.write(
              "'/proc/self/fd/3/11' -> '/proc/self/fd/3/20/11'\n" +
                "copy offload: no, reflink: Invalid cross-device link, sparse detection: zeros\n",
            );
          }
        }
        stdout.write(".\n");
      });
      stdin.on("finish", () => {
        stdout.end();
        stderr.end();
        child.emit("close", 0);
      });
      // Only the child transport is simulated; the production protocol consumes its streams.
      return child;
    });
    const details: ProvisionCopyDetails = {
      copier: "linux-batched",
      batchCount: 0,
      sourceBytes: 8192,
      spawnCount: 0,
      spawnMs: 0,
      childMs: 0,
      authorityChecks: 0,
      authorityMs: 0,
    };
    const command = createProvisionCopyCommand(3, 1, details);
    try {
      expect(await command.ready()).toBeUndefined();
      await command.copy(20, [
        { fd: 10, bytes: 3072 },
        { fd: 11, bytes: 5120 },
      ]);
      if (scenario === "mixed") {
        expect(details).toMatchObject({
          clonedFiles: 1,
          clonedBytes: 3072,
          copiedFiles: 1,
          copiedBytes: 5120,
          reflinkFallbackReason: "Invalid cross-device link",
        });
        expect(details.unreportedFiles).toBeUndefined();
      } else {
        expect(details).toMatchObject({ unreportedFiles: 2, unreportedBytes: 8192 });
        expect(details.clonedFiles).toBeUndefined();
        expect(details.copiedFiles).toBeUndefined();
      }
    } finally {
      await command.close();
    }
  },
);

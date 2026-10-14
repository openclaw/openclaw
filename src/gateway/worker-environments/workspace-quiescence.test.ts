import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";

describe("worker workspace quiescence", () => {
  it.each(["transport", "acknowledgement", "cleanup", "owner-closed", "legacy"] as const)(
    "recovers only an owned native nonce after failed acquisition (%s)",
    async (failure) => {
      const owner = new AbortController();
      const commands: WorkerWorkspaceCommand[] = [];
      const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) => {
        commands.push(command);
        if (command.quiescence?.action === "release") {
          if (failure === "cleanup") {
            throw new Error("recovery unavailable");
          }
          return {
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit" as const,
          };
        }
        if (failure === "owner-closed") {
          owner.abort();
        }
        if (failure !== "acknowledgement") {
          throw new Error("acquisition response lost");
        }
        return {
          stdout: "not an acknowledgement",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      });
      const acquiring = createWorkerWorkspaceQuiescence({
        ownerSignal: owner.signal,
        sharedHost: true,
        nativeWatchdog: async () => failure !== "legacy",
        runWorkspaceCommand,
      })("/workspace");
      if (failure === "cleanup") {
        await expect(acquiring).rejects.toMatchObject({
          errors: [
            expect.objectContaining({ message: "acquisition response lost" }),
            expect.objectContaining({ message: "recovery unavailable" }),
          ],
        });
      } else {
        await expect(acquiring).rejects.toThrow(
          failure === "acknowledgement" ? "invalid acknowledgement" : "acquisition response lost",
        );
      }
      if (failure === "owner-closed" || failure === "legacy") {
        expect(commands).toHaveLength(1);
      } else {
        expect(commands).toHaveLength(2);
        expect(commands[1]?.quiescence).toEqual({
          action: "release",
          nonce: commands[0]?.quiescence?.nonce,
        });
        expect(commands[1]?.transportRetry).toBe("never");
      }
    },
  );

  it.each([false, true])(
    "drains active renewal before release (owner closes: %s)",
    async (closes) => {
      const owner = new AbortController();
      const nonce = "c".repeat(32);
      const { promise: renewalBlocked, resolve: finishRenewal } = createDeferred();
      const runWorkspaceCommand = vi.fn(async (command: { argv: readonly string[] }) => {
        if (command.argv.includes("final")) {
          await renewalBlocked;
          return {
            stdout: `renewed ${nonce}\n`,
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit" as const,
          };
        }
        return {
          stdout: `quiesced ${nonce}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      });
      const quiesce = createWorkerWorkspaceQuiescence({
        ownerSignal: owner.signal,
        sharedHost: true,
        runWorkspaceCommand,
      });
      const lease = await quiesce(String.raw`C:\Users\angry\workspace`);

      const assertion = lease.assertActive();
      await vi.waitFor(() => expect(runWorkspaceCommand).toHaveBeenCalledTimes(2));
      const release = lease.resume();
      await expect(lease.assertActive()).rejects.toThrow("already released");
      expect(runWorkspaceCommand).toHaveBeenCalledTimes(2);
      if (closes) {
        owner.abort();
      }
      finishRenewal();
      await assertion;
      await release;

      expect(runWorkspaceCommand).toHaveBeenCalledTimes(closes ? 2 : 3);
    },
  );

  it("releases only local renewal state when the owner closes before quiescence acknowledges", async () => {
    const owner = new AbortController();
    const runWorkspaceCommand = vi.fn(async () => {
      owner.abort();
      return {
        stdout: `quiesced ${"e".repeat(32)}\n`,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    });
    const lease = await createWorkerWorkspaceQuiescence({
      ownerSignal: owner.signal,
      sharedHost: true,
      runWorkspaceCommand,
    })("/workspace");

    try {
      await expect(lease.assertActive()).rejects.toThrow("already released");
    } finally {
      await Promise.all([lease.resume(), lease.resume()]);
    }
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
  });

  it.each([
    { remoteWorkspaceDir: "/workspace", sharedHost: false },
    { remoteWorkspaceDir: String.raw`C:\Users\angry\workspace`, sharedHost: true },
  ])(
    "retries a failed workspace release without duplicating concurrent attempts ($remoteWorkspaceDir)",
    async ({ remoteWorkspaceDir, sharedHost }) => {
      const nonce = "d".repeat(32);
      let releaseAttempts = 0;
      const runWorkspaceCommand = vi.fn(async (command: { argv: readonly string[] }) => {
        if (command.argv[4] === nonce && ++releaseAttempts === 1) {
          throw new Error("remote connection interrupted");
        }
        return {
          stdout: releaseAttempts === 0 ? `quiesced ${nonce}\n` : "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      });
      const lease = await createWorkerWorkspaceQuiescence({
        ownerSignal: new AbortController().signal,
        sharedHost,
        runWorkspaceCommand,
      })(remoteWorkspaceDir);

      await expect(Promise.all([lease.resume(), lease.resume()])).rejects.toThrow(
        "remote connection interrupted",
      );
      expect(releaseAttempts).toBe(1);
      await expect(lease.assertActive()).rejects.toThrow("already released");

      await expect(Promise.all([lease.resume(), lease.resume()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(releaseAttempts).toBe(2);
      await lease.resume();
      expect(releaseAttempts).toBe(2);
    },
  );
});

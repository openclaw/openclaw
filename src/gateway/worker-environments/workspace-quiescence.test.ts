import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { result } from "./bootstrap.test-support.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";

type QuiescenceOptions = Parameters<typeof createWorkerWorkspaceQuiescence>[0];
function quiescence(
  runWorkspaceCommand: QuiescenceOptions["runWorkspaceCommand"],
  options: Partial<Omit<QuiescenceOptions, "runWorkspaceCommand">> = {},
) {
  return createWorkerWorkspaceQuiescence({
    ownerSignal: new AbortController().signal,
    sharedHost: true,
    ...options,
    runWorkspaceCommand,
  });
}

it("uses a bounded acquire command for legacy Windows workspaces", async () => {
  const owner = new AbortController();
  const nonce = "a".repeat(32);
  const runWorkspaceCommand = vi.fn(async (_command: WorkerWorkspaceCommand) =>
    result({ stdout: `quiesced ${nonce}\n` }),
  );
  const lease = await quiescence(runWorkspaceCommand, { ownerSignal: owner.signal })(
    String.raw`C:\workspace`,
  );

  owner.abort();
  await lease.resume();

  expect(runWorkspaceCommand).toHaveBeenCalledOnce();
  const [command] = runWorkspaceCommand.mock.calls[0]!;
  expect(command).toMatchObject({ legacyQuiescence: true, transportRetry: "never" });
  expect(command.argv.join(" ").length).toBeLessThan(32_767);
});

it.each(["transport", "acknowledgement", "cleanup", "owner-closed", "legacy"] as const)(
  "recovers only an owned native nonce after failed acquisition (%s)",
  async (failure) => {
    const owner = new AbortController();
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) => {
      if (command.quiescence?.action === "release") {
        if (failure === "cleanup") {
          throw new Error("recovery unavailable");
        }
        return result();
      }
      if (failure === "owner-closed") {
        owner.abort();
      }
      if (failure !== "acknowledgement") {
        throw new Error("acquisition response lost");
      }
      return result({ stdout: "not an acknowledgement" });
    });
    const acquiring = quiescence(runWorkspaceCommand, {
      ownerSignal: owner.signal,
      nativeWatchdog: async () => failure !== "legacy",
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
    const commands = runWorkspaceCommand.mock.calls.map(([command]) => command);
    if (failure === "owner-closed" || failure === "legacy") {
      expect(commands).toHaveLength(1);
    } else {
      expect(commands).toHaveLength(2);
      expect([commands[1]?.quiescence, commands[1]?.transportRetry]).toEqual([
        { action: "release", nonce: commands[0]?.quiescence?.nonce },
        "never",
      ]);
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
        return result({ stdout: `renewed ${nonce}\n` });
      }
      return result({ stdout: `quiesced ${nonce}\n` });
    });
    const lease = await quiescence(runWorkspaceCommand, { ownerSignal: owner.signal })(
      String.raw`C:\workspace`,
    );

    const assertion = lease.assertActive();
    await vi.waitFor(() => expect(runWorkspaceCommand).toHaveBeenCalledTimes(2));
    const release = lease.resume();
    await expect(lease.assertActive()).rejects.toThrow("already released");
    expect(runWorkspaceCommand).toHaveBeenCalledTimes(2);
    if (closes) {
      owner.abort();
    }
    finishRenewal();
    await Promise.all([assertion, release]);

    expect(runWorkspaceCommand).toHaveBeenCalledTimes(closes ? 2 : 3);
  },
);

it("releases locally when the owner closes before acquisition acknowledges", async () => {
  const owner = new AbortController();
  const runWorkspaceCommand = vi.fn(async () => {
    owner.abort();
    return result({ stdout: `quiesced ${"e".repeat(32)}\n` });
  });
  const lease = await quiescence(runWorkspaceCommand, { ownerSignal: owner.signal })("/workspace");

  try {
    await expect(lease.assertActive()).rejects.toThrow("already released");
  } finally {
    await Promise.all([lease.resume(), lease.resume()]);
  }
  expect(runWorkspaceCommand).toHaveBeenCalledOnce();
});

it.each([
  { remoteWorkspaceDir: "/workspace", sharedHost: false },
  { remoteWorkspaceDir: String.raw`C:\workspace`, sharedHost: true },
])(
  "deduplicates failed release retries ($remoteWorkspaceDir)",
  async ({ remoteWorkspaceDir, sharedHost }) => {
    const nonce = "d".repeat(32);
    let releaseAttempts = 0;
    const runWorkspaceCommand = vi.fn(async (command: { argv: readonly string[] }) => {
      if (command.argv[4] === nonce && ++releaseAttempts === 1) {
        throw new Error("remote connection interrupted");
      }
      return result({ stdout: releaseAttempts === 0 ? `quiesced ${nonce}\n` : "" });
    });
    const lease = await quiescence(runWorkspaceCommand, { sharedHost })(remoteWorkspaceDir);
    const resumeConcurrently = () => Promise.all([lease.resume(), lease.resume()]);

    await expect(resumeConcurrently()).rejects.toThrow("remote connection interrupted");
    expect(releaseAttempts).toBe(1);
    await expect(lease.assertActive()).rejects.toThrow("already released");

    await expect(resumeConcurrently()).resolves.toEqual([undefined, undefined]);
    expect(releaseAttempts).toBe(2);
    await lease.resume();
    expect(releaseAttempts).toBe(2);
  },
);

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { removeManagedCheckout } from "../agents/worktrees/removal-git.js";
import * as commandExec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { GIT_TIMEOUT_MS } from "./git-exec.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe("admitted Git command settlement", () => {
  const cleanups: Array<() => Promise<void>> = [];

  // This inner hook joins fixture commands before the parent removes their inputs.
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startRemoval(signal: AbortSignal) {
    // Darwin's Unix-socket path limit requires a short, fixture-owned directory.
    const directory = dirs.make(
      "oc-settled-git-",
      process.platform === "win32" ? undefined : "/tmp",
    );
    const address =
      process.platform === "win32"
        ? `\\\\.\\pipe\\openclaw-settled-git-${randomUUID()}`
        : path.join(directory, "release.sock");
    const ready = createDeferredCore();
    const abort = new AbortController();
    const commands: Array<Promise<commandExec.SpawnResult>> = [];
    const sockets = new Set<net.Socket>();
    const socketCloses: Array<Promise<void>> = [];
    const releases: Array<Promise<void>> = [];
    let cleanup: Promise<void> | undefined;
    const dispose = () =>
      (cleanup ??= (async () => {
        signal.removeEventListener("abort", cancel);
        vi.useRealTimers();
        abort.abort();
        for (const socket of sockets) {
          socket.destroy();
        }
        await Promise.allSettled([...commands, removal, ...socketCloses, ...releases]);
      })());
    const cancel = () => {
      void dispose();
    };
    cleanups.push(dispose);
    signal.addEventListener("abort", cancel, { once: true });
    const run = commandExec.runCommandWithTimeout;
    let stdout = "";
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation((_argv, options) => {
      const command = run(
        [
          process.execPath,
          "-e",
          `
          const net = require('node:net');
          const server = net.createServer(socket => {
            let input = '';
            socket.setEncoding('utf8');
            socket.on('data', chunk => {
              input += chunk;
              if (input === 'release\\n') {
                socket.end('released\\n');
                server.close();
              }
            });
          });
          server.listen(process.argv[1], () => process.stdout.write('ready\\n'));
        `,
          address,
        ],
        {
          ...(typeof options === "number" ? { timeoutMs: options } : options),
          signal: abort.signal,
          onOutputChunk: (chunk, stream) => {
            if (stream === "stdout") {
              stdout += chunk.toString("utf8");
              if (stdout === "ready\n") {
                ready.resolve();
              }
            }
          },
        },
      );
      commands.push(command);
      void command.catch(() => {});
      return command;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const removal = withWorktreeGitConfig(directory, false, {}, (git) =>
      removeManagedCheckout(
        {
          id: "fixture",
          name: "fixture",
          repoRoot: directory,
          repoFingerprint: "fixture",
          path: path.join(directory, "fixture"),
          branch: "openclaw/fixture",
          baseRef: "HEAD",
          ownerKind: "manual",
          createdAt: 1,
          lastActiveAt: 1,
        },
        git,
        true,
      ),
    );
    void removal.catch(() => {});
    return {
      directory,
      commands,
      dispose,
      removal,
      ready: Promise.race([
        ready.promise,
        removal.then(() => {
          throw new Error("child exited before admission");
        }),
      ]),
      release() {
        abort.signal.throwIfAborted();
        const released = (async () => {
          const socket = net.createConnection(address);
          sockets.add(socket);
          socketCloses.push(
            new Promise<void>((resolve) => {
              socket.once("close", resolve);
            }),
          );
          let reply = "";
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => {
            reply += chunk;
          });
          const ended = once(socket, "end", { signal: abort.signal });
          void ended.catch(() => {});
          await once(socket, "connect", { signal: abort.signal });
          socket.end("release\n");
          await ended;
          expect(reply).toBe("released\n");
        })();
        releases.push(released);
        void released.catch(() => {});
        return released;
      },
    };
  }

  it("joins an admitted destructive child beyond the ordinary Git deadline", async ({ signal }) => {
    const fixture = startRemoval(signal);
    await fixture.ready;
    await vi.advanceTimersByTimeAsync(GIT_TIMEOUT_MS + 1_000);
    await fixture.release();
    await expect(fixture.removal).resolves.toBeUndefined();
  });

  it.for(["waiting", "connecting"] as const)(
    "joins an aborted %s fixture before removing its IPC directory",
    async (phase, { signal }) => {
      const abort = new AbortController();
      const fixture = startRemoval(AbortSignal.any([signal, abort.signal]));
      await fixture.ready;
      const release = phase === "connecting" ? fixture.release() : undefined;
      const rejected = expect(fixture.removal).rejects.toThrow();
      abort.abort();
      await fixture.dispose();
      await rejected;
      if (release) {
        await expect(release).rejects.toThrow();
      }
      expect(() => fixture.release()).toThrow();
      const [result] = await Promise.all(fixture.commands);
      expect(result).toMatchObject({ termination: "signal", pid: expect.any(Number) });
      expect(result?.cleanup).not.toBe("uncertain");
      expect(isPidAlive(result!.pid!)).toBe(false);
      expect(fs.existsSync(fixture.directory)).toBe(true);
    },
  );
});

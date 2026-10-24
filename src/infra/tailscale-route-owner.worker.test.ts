import { fork } from "node:child_process";
import { on, once } from "node:events";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  TAILSCALE_ROUTE_OWNER_ARG,
  type TailscaleRouteOwnerMessage,
} from "./tailscale-route-owner-protocol.js";
import { runTailscaleRouteOwner } from "./tailscale-route-owner.worker.js";

function spawnRouteOwnerFixture(waitForReady: boolean, abortSignal: AbortSignal) {
  abortSignal.throwIfAborted();
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.tailscaleRouteOwner);
  const fixturePath = fileURLToPath(
    new URL("../../test/fixtures/tailscale-foreground-fixture.mjs", import.meta.url),
  );
  const worker = fork(
    fileURLToPath(workerUrl),
    [
      TAILSCALE_ROUTE_OWNER_ARG,
      JSON.stringify({ argv: [fixturePath, "serve", "--yes", "--bg=false", "18789"] }),
    ],
    {
      execArgv: resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const messages: TailscaleRouteOwnerMessage[] = [];
  worker.on("message", (message: TailscaleRouteOwnerMessage) => messages.push(message));
  const ready = waitForReady
    ? (async () => {
        const observers = new AbortController();
        const signal = AbortSignal.any([abortSignal, observers.signal]);
        const incoming = on(worker, "message", { signal });
        try {
          await Promise.race([
            (async () => {
              for await (const args of incoming) {
                const message: TailscaleRouteOwnerMessage = args[0];
                if (message.type === "ready") {
                  return;
                }
                if (message.type === "failed") {
                  throw new Error(`route owner failed: ${JSON.stringify(message)}`);
                }
              }
            })(),
            once(worker, "exit", { signal }).then((exit) => {
              throw new Error(`route owner exited before readiness: ${JSON.stringify(exit)}`);
            }),
          ]);
        } finally {
          observers.abort();
        }
      })()
    : undefined;
  return { messages, ready, worker };
}

type ClaimCase = { name: string; script: string; stopping: boolean };
it.each`
  name                                                      | script                                                                             | stopping
  ${"reports readiness and stops the foreground claim"}     | ${'process.stdout.write("Press Ctrl+C to exit.\\n"); setInterval(() => {}, 1000)'} | ${true}
  ${"reports output when the claim exits before readiness"} | ${'process.stderr.write("route denied\\n"); process.exit(7)'}                      | ${false}
`("$name", async ({ script, stopping }: ClaimCase) => {
  const messages: TailscaleRouteOwnerMessage[] = [];
  const owner = runTailscaleRouteOwner({ argv: [process.execPath, "-e", script] }, (message) =>
    messages.push(message),
  );
  if (stopping) {
    await vi.waitFor(() => expect(messages).toContainEqual({ type: "ready" }));
    owner.stop();
  }
  await expect(owner.exited).resolves.toMatchObject(
    stopping ? { stopping: true } : { code: 7, stopping: false },
  );
  if (stopping) {
    expect(messages.some((message) => message.type === "failed")).toBe(false);
  } else {
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "failed", code: 7, stderr: "route denied\n" }),
    );
  }
});

it.runIf(process.platform !== "win32").for([
  { waitForReady: false, interrupt: false },
  { waitForReady: true, interrupt: false },
  { waitForReady: true, interrupt: true },
])(
  "releases the claim (ready=$waitForReady, interrupt=$interrupt)",
  async ({ waitForReady, interrupt }, { signal }) => {
    const { messages, ready, worker } = spawnRouteOwnerFixture(waitForReady, signal);
    let routePid: number | undefined;
    try {
      if (waitForReady) {
        await ready;
      }
      if (interrupt) {
        const spawned = messages.find((message) => message.type === "spawned");
        if (!spawned) {
          throw new Error("route owner did not report its claim process");
        }
        routePid = spawned.pid;
      }
      const exit = once(worker, "exit");
      if (interrupt) {
        worker.kill("SIGINT");
      } else {
        worker.disconnect();
      }
      await expect(exit).resolves.toEqual([0, null]);
      if (routePid) {
        const pid = routePid;
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      }
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
      }
      if (routePid) {
        try {
          process.kill(routePid, "SIGKILL");
        } catch {}
      }
    }
  },
);

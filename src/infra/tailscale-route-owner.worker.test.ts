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
        for await (const [message] of on(worker, "message", {
          signal: abortSignal,
          close: ["exit"],
        })) {
          const report: TailscaleRouteOwnerMessage = message;
          if (report.type === "ready") {
            return;
          }
          if (report.type === "failed") {
            throw new Error(`route owner failed: ${JSON.stringify(report)}`);
          }
        }
        throw new Error("route owner exited before readiness");
      })()
    : undefined;
  return { messages, ready, worker };
}

it("reports output when the claim exits before readiness", async () => {
  const messages: TailscaleRouteOwnerMessage[] = [];
  const owner = runTailscaleRouteOwner(
    { argv: [process.execPath, "-e", 'process.stderr.write("route denied\\n"); process.exit(7)'] },
    (message) => messages.push(message),
  );
  await expect(owner.exited).resolves.toMatchObject({ code: 7, stopping: false });
  expect(messages).toContainEqual(
    expect.objectContaining({ type: "failed", code: 7, stderr: "route denied\n" }),
  );
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
      if (waitForReady) {
        expect(messages.some((message) => message.type === "failed")).toBe(false);
      }
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

import { fork } from "node:child_process";
import { on, once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

const directories = useAutoCleanupTempDirTracker(afterEach);

it.for(["stdout", "stderr"] as const)(
  "preserves a character split across %s writes in the failure report",
  async (stream, { signal }) => {
    const directory = directories.make("openclaw-route-output-");
    const releaseName = "continue";
    const childScript = [
      'import { watch } from "node:fs";',
      "const [directory, stream, releaseName] = process.argv.slice(1);",
      'const glyph = Buffer.from("🧭");',
      "const release = new Promise((resolve) => {",
      "  const watcher = watch(directory, (_event, name) => {",
      "    if (name === releaseName) { watcher.close(); resolve(); }",
      "  });",
      "});",
      'process[stream].write(Buffer.concat([Buffer.from("Press Ctrl+C to exit.\\nroute /"), glyph.subarray(0, 2)]));',
      "await release;",
      'process[stream].write(Buffer.concat([glyph.subarray(2), Buffer.from(" failed\\n")]));',
      "process.exitCode = 7;",
    ].join("\n");
    const messages: TailscaleRouteOwnerMessage[] = [];
    const owner = runTailscaleRouteOwner(
      {
        argv: [
          process.execPath,
          "--input-type=module",
          "-e",
          childScript,
          directory,
          stream,
          releaseName,
        ],
      },
      (message) => {
        messages.push(message);
        if (message.type === "ready") {
          // The route owner has consumed the first write before the child sends the rest.
          writeFileSync(path.join(directory, releaseName), "");
        }
      },
    );
    signal.addEventListener("abort", owner.stop, { once: true });
    try {
      await expect(owner.exited).resolves.toMatchObject({ code: 7, stopping: false });
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "failed",
          [stream]: "Press Ctrl+C to exit.\nroute /🧭 failed\n",
        }),
      );
    } finally {
      signal.removeEventListener("abort", owner.stop);
      owner.stop();
      await owner.exited;
    }
  },
);

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

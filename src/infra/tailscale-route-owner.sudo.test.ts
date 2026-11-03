import { once } from "node:events";
import { readFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runTailscaleRouteOwner } from "./tailscale-route-owner.worker.js";

vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  // Model EPERM at the signal owner, which deliberately swallows it on Unix.
  signalProcessTree: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.runIf(process.platform !== "win32")(
  "stops its sudo-backed foreground process before readiness despite unprivileged EPERM",
  async ({ signal }) => {
    const directory = tempDirs.make("openclaw-tailscale-privileged-");
    const fixture = fileURLToPath(
      new URL("../../test/fixtures/tailscale-privileged-fixture.mjs", import.meta.url),
    );
    symlinkSync(fixture, path.join(directory, "sudo"));
    vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
    const socketPath = path.join(directory, "claim.sock");
    const marker = path.join(directory, "stopped");
    vi.stubEnv("OPENCLAW_TEST_TAILSCALE_FIXTURE_SOCKET", socketPath);
    vi.stubEnv("OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER", marker);
    const server = createServer();
    server.listen(socketPath);
    await once(server, "listening");
    const connection = once(server, "connection");
    let ownerPid: number | undefined;
    const owner = runTailscaleRouteOwner(
      { argv: ["sudo", "-n", process.execPath, fixture] },
      (message) => {
        if (message.type === "spawned") {
          ownerPid = message.pid;
        }
      },
    );
    let socket: import("node:net").Socket | undefined;
    let settled = false;
    try {
      [socket] = await withinTest(connection, signal);
      if (!socket) {
        throw new Error("Claim fixture did not connect");
      }
      await withinTest(once(socket, "data"), signal);
      owner.stop();
      await withinTest(owner.exited, signal);
      settled = true;
      expect(readFileSync(marker, "utf8")).toBe("stopped");
    } finally {
      // Only this test's detached group; the fake privilege boundary never uses root.
      if (ownerPid && !settled) {
        try {
          process.kill(-ownerPid, "SIGKILL");
        } catch {}
      }
      socket?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await owner.exited;
    }
  },
);

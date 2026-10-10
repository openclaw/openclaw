import "../test-utils/prepare-compiled-subprocesses.js";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const UPDATER_CLEANUP_GUARD_MS = 5_000;
beforeEach(async () => {
  // resetModules gives each outcome a fresh owner; install spies on that same module instance.
  const [tmpOwner, systemdScope] = await Promise.all([
    import("./tmp-openclaw-dir.js"),
    import("../daemon/systemd-scope.js"),
  ]);
  vi.spyOn(tmpOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    roots.make("openclaw-settlement-coordinator-"),
  );
  vi.spyOn(systemdScope, "findSystemdGatewayInstallation").mockResolvedValue({
    kind: "system",
    system: {
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// A real helper can exit 143 while its detached updater remains alive. Keep an
// independent fixture socket open so helper exit cannot masquerade as updater
// cleanup. No operator service or installation is used.
it.runIf(process.platform === "linux").each(["SIGTERM", "success", "failed"] as const)(
  "requires physical helper settlement at the public replacement join (%s)",
  async (outcome) => {
    const root = await fs.realpath(roots.make("openclaw-settlement-"));
    const socketPath = path.join(root, "updater.sock");
    const server = net.createServer();
    const connected = once(server, "connection");
    server.listen(socketPath);
    await once(server, "listening");
    const updaterPath = path.join(root, "updater.cjs");
    await fs.writeFile(
      updaterPath,
      [
        'if (process.argv[2] !== "update") process.exit(0);',
        'const socket = require("node:net").connect(' + JSON.stringify(socketPath) + ");",
        'socket.once("connect", () => socket.write(String(process.pid)));',
        'socket.once("data", () => {',
        "process.stdout.write(JSON.stringify(" +
          JSON.stringify({
            root,
            status: outcome === "failed" ? "error" : "skipped",
            reason: outcome === "failed" ? "candidate-validation-failed" : "already-current",
            mode: "npm",
          }) +
          "));",
        "process.exitCode = " + (outcome === "failed" ? 7 : 0) + ";",
        "socket.end(); process.disconnect?.(); process.stdin.destroy();",
        "});",
      ].join(String.fromCharCode(10)),
    );
    const {
      startManagedServiceUpdateHandoff,
      transferManagedServiceUpdateHandoff,
      waitForSystemServiceUpdateHandoffs,
      cancelManagedServiceUpdateHandoff,
    } = await import("./update-managed-service-handoff.js");
    const { activeManagedServiceUpdateHandoffs } =
      await import("./update-managed-service-handoff-current.js");
    let helperClosed: Promise<void> | undefined;
    let updater: net.Socket | undefined;
    let updaterPid: number | undefined;
    let updaterStart: number | null = null;
    let started: Awaited<ReturnType<typeof startManagedServiceUpdateHandoff>> | undefined;
    let helperStart: number | null = null;
    try {
      started = await startManagedServiceUpdateHandoff({
        root,
        supervisor: "systemd",
        restartDrainTimeoutMs: 300_000,
        execPath: process.execPath,
        argv1: updaterPath,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        },
        meta: {},
      });
      if (started.status !== "started" || !started.pid) {
        throw new Error("expected owned helper");
      }
      // Retain the spawn-time close observer before transfer can retire the active owner.
      helperClosed = activeManagedServiceUpdateHandoffs.get(started.installRoot)?.closed;
      if (!helperClosed) {
        throw new Error("expected owned helper close observer");
      }
      helperStart = getFileLockProcessStartTime(started.pid);
      await expect(
        transferManagedServiceUpdateHandoff({ kind: "managed-update-handoff", ...started }),
      ).resolves.toBe(true);
      [updater] = await connected;
      if (!updater) {
        throw new Error("expected connected updater");
      }
      const [pid] = await once(updater, "data");
      updaterPid = Number(String(pid));
      updaterStart = getFileLockProcessStartTime(updaterPid);
      expect(updaterStart).not.toBeNull();
      let settled = false;
      const join = waitForSystemServiceUpdateHandoffs();
      expect(join).toBeInstanceOf(Promise);
      const result = join!.then(
        () => {
          settled = true;
          return "settled";
        },
        (error: unknown) => error,
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      if (outcome === "SIGTERM") {
        process.kill(started.pid, "SIGTERM");
        const observed = await result;
        expect(isPidAlive(updaterPid)).toBe(true);
        expect(getFileLockProcessStartTime(updaterPid)).toBe(updaterStart);
        expect(observed).toBeInstanceOf(Error);
        expect(String(observed)).toContain("settlement could not be confirmed");
        await expect(waitForSystemServiceUpdateHandoffs()).rejects.toThrow(
          "settlement could not be confirmed",
        );
      } else {
        updater.write("finish");
        expect(await result).toBe("settled");
        expect(isPidAlive(updaterPid)).toBe(false);
        expect(waitForSystemServiceUpdateHandoffs()).toBeUndefined();
        expect(await fs.readFile(started.logPath, "utf8")).toContain(
          "managed update helper completed code=" + (outcome === "failed" ? 7 : 0),
        );
      }
    } finally {
      // Captured start identities prevent test cleanup from signalling reused PIDs.
      if (
        updaterPid &&
        updaterStart !== null &&
        getFileLockProcessStartTime(updaterPid) === updaterStart
      ) {
        updater?.write("finish");
        // Cleanup hang guard after the owner requested updater settlement, not a readiness race.
        await waitForDead(updaterPid, AbortSignal.timeout(UPDATER_CLEANUP_GUARD_MS));
      }
      updater?.destroy();
      if (
        started?.pid &&
        helperStart !== null &&
        getFileLockProcessStartTime(started.pid) === helperStart
      ) {
        process.kill(started.pid, "SIGKILL");
      }
      await helperClosed;
      if (started?.status === "started") {
        await cancelManagedServiceUpdateHandoff({ kind: "managed-update-handoff", ...started });
        await fs.rm(path.dirname(started.logPath), { recursive: true, force: true });
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);

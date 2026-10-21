import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const sameProcess = (pid: number, start: number | null) =>
  start !== null && getFileLockProcessStartTime(pid) === start;
beforeEach(async () => {
  vi.spyOn(await import("./tmp-openclaw-dir.js"), "resolvePreferredOpenClawTmpDir").mockReturnValue(
    roots.make("openclaw-settlement-coordinator-"),
  );
  vi.spyOn(
    await import("../daemon/systemd-scope.js"),
    "findSystemdGatewayInstallation",
  ).mockResolvedValue({
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

// An independent socket distinguishes helper exit from physical updater cleanup.
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
    const resultJson = JSON.stringify({
      root,
      mode: "npm",
      status: outcome === "failed" ? "error" : "skipped",
      reason: outcome === "failed" ? "candidate-validation-failed" : "already-current",
    });
    await fs.writeFile(
      updaterPath,
      `if (process.argv[2] !== "update") process.exit(0);
const socket = require("node:net").connect(${JSON.stringify(socketPath)});
socket.once("connect", () => socket.write(String(process.pid)));
process.on("SIGTERM", () => socket.write("interrupted"));
socket.once("data", () => {
process.stdout.write(${JSON.stringify(resultJson)});
process.exitCode = ${outcome === "failed" ? 7 : 0};
socket.end(); process.disconnect?.(); process.stdin.destroy();
});`,
    );
    const handoff = await import("./update-managed-service-handoff.js");
    const { activeManagedServiceUpdateHandoffs } =
      await import("./update-managed-service-handoff-current.js");
    let helperClosed: Promise<void> | undefined;
    let updater: net.Socket | undefined;
    let updaterPid: number | undefined;
    let updaterStart: number | null = null;
    let started: Awaited<ReturnType<typeof handoff.startManagedServiceUpdateHandoff>> | undefined;
    let helperStart: number | null = null;
    try {
      started = await handoff.startManagedServiceUpdateHandoff({
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
      assert(started.status === "started" && started.pid, "expected owned helper");
      // Capture before transfer retires the owner.
      helperClosed = activeManagedServiceUpdateHandoffs.get(started.installRoot)?.closed;
      assert(helperClosed, "expected owned helper close observer");
      helperStart = getFileLockProcessStartTime(started.pid);
      await expect(
        handoff.transferManagedServiceUpdateHandoff({ kind: "managed-update-handoff", ...started }),
      ).resolves.toBe(true);
      [updater] = await connected;
      assert(updater, "expected connected updater");
      const [pid] = await once(updater, "data");
      updaterPid = Number(String(pid));
      updaterStart = getFileLockProcessStartTime(updaterPid);
      expect(updaterStart).not.toBeNull();
      let state = "pending";
      const join = handoff.waitForSystemServiceUpdateHandoffs();
      expect(join).toBeInstanceOf(Promise);
      const result = join!.then(
        () => (state = "settled"),
        (error: unknown) => error,
      );
      await immediate();
      expect(state).toBe("pending");
      if (outcome === "SIGTERM") {
        const interrupted = once(updater, "data");
        process.kill(started.pid, "SIGTERM");
        const observed = await Promise.race([interrupted, result]);
        expect(observed).toEqual([Buffer.from("interrupted")]);
        expect(state).toBe("pending");
        expect(isPidAlive(started.pid)).toBe(true);
        expect(isPidAlive(updaterPid)).toBe(true);
        expect(getFileLockProcessStartTime(updaterPid)).toBe(updaterStart);
      }
      updater.write("finish");
      expect(await result).toBe("settled");
      expect(isPidAlive(updaterPid)).toBe(false);
      expect(handoff.waitForSystemServiceUpdateHandoffs()).toBeUndefined();
      const code = outcome === "SIGTERM" ? 143 : outcome === "failed" ? 7 : 0;
      expect(await fs.readFile(started.logPath, "utf8")).toContain(
        `managed update helper completed code=${code}`,
      );
    } finally {
      // Captured start identities prevent test cleanup from signalling reused PIDs.
      if (updaterPid && sameProcess(updaterPid, updaterStart)) {
        updater?.write("finish");
        await waitForDead(updaterPid, AbortSignal.timeout(5_000));
      }
      updater?.destroy();
      if (started?.pid && sameProcess(started.pid, helperStart)) {
        process.kill(started.pid, "SIGKILL");
      }
      await helperClosed;
      if (started?.status === "started") {
        await handoff.cancelManagedServiceUpdateHandoff({
          kind: "managed-update-handoff",
          ...started,
        });
        await fs.rm(path.dirname(started.logPath), { recursive: true, force: true });
      }
      await promisify(server.close.bind(server))();
    }
  },
);

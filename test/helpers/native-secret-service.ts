import { spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  finalizeManagedChild,
  loadManagedChildSpawner,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

/** Real Secret Service on a fresh private bus/home; never connects to the host session bus. */
export async function withNativeSecretService<T>(
  signal: AbortSignal,
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux") {
    throw new Error(
      "Native Secret Service proof requires Linux with dbus-daemon, gnome-keyring-daemon, and gdbus",
    );
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "p5-keyring-"));
  const runtime = path.join(root, "run");
  await fs.mkdir(runtime, { mode: 0o700 });
  const address = "unix:abstract=p5-native-" + randomUUID();
  const env = {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: address,
    LANG: "C.UTF-8",
  };
  const children: ChildProcess[] = [];
  const spawn = await loadManagedChildSpawner();
  const start = async (command: string, args: string[]) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.stderr?.resume();
    // A failed spawn emits error, not exit; only a spawned process enters cleanup custody.
    await once(child, "spawn");
    children.push(child);
    return child;
  };
  return await runQaGatewayFixture(
    async () => {
      const bus = await start("dbus-daemon", [
        "--session",
        "--nofork",
        "--print-address=1",
        "--address=" + address,
      ]);
      const [announcement] = await Promise.race([
        once(bus.stdout!, "data"),
        once(bus, "exit").then(() => {
          throw new Error("Private D-Bus exited before readiness");
        }),
      ]);
      if (!String(announcement).trim().startsWith(address)) {
        throw new Error("Unexpected private D-Bus address");
      }
      bus.stdout?.resume();
      const keyring = await start("gnome-keyring-daemon", [
        "--foreground",
        "--unlock",
        "--components=secrets",
        "--control-directory=" + runtime,
      ]);
      keyring.stdout?.resume();
      keyring.stdin?.end("synthetic-keyring-password\n");
      const ready = await runManagedCommand({
        bin: "gdbus",
        args: ["wait", "--session", "--timeout", "10", "org.freedesktop.secrets"],
        cwd: root,
        env,
        signal,
        timeoutMs: 15000,
        requireProcessTreeExit: true,
      });
      if (ready !== 0) {
        throw new Error("Task-private Secret Service did not become ready");
      }
      return await run(env);
    },
    () =>
      runQaGatewayFixture(
        async () => {},
        ...children.toReversed().map(
          (child) => () =>
            finalizeManagedChild(child, "SIGTERM", {
              platform: process.platform,
              runTaskkill: spawnSync,
            }),
        ),
      ),
    () => fs.rm(root, { recursive: true, force: true }),
  );
}

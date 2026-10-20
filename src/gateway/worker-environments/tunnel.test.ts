import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import type { WorkerSshIdentity } from "../../plugins/types.js";
import { createWorkerSshRunner } from "./tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import {
  PWD_COMMAND,
  SSH,
  deferred,
  fakeRunner,
  resolveIdentity,
  startTestTunnel,
  success,
  waitForStarts,
} from "./tunnel.test-support.js";

const ENVIRONMENT = "worker:test";
const TUNNEL = {
  environmentId: ENVIRONMENT,
  ownerEpoch: 1,
  bundleHash: "a".repeat(64),
  ssh: SSH,
  resolveIdentity,
};

function quiescenceRunner(nonce: string, acquireArgs: string, renewArgs: string) {
  return fakeRunner((argv) => {
    const command = argv.at(-1) ?? "";
    if (command.endsWith(acquireArgs)) {
      return success(`quiesced ${nonce}\n`);
    }
    if (command.endsWith(renewArgs)) {
      return success(`renewed ${nonce}\n`);
    }
    return undefined;
  });
}

function tunnelFixture(fake = fakeRunner()) {
  const manager = createWorkerTunnelManager({ runner: fake.runner });
  onTestFinished(() => manager.stopAll());
  const start = (epoch = 1, sharedHost = false) =>
    startTestTunnel(manager, ENVIRONMENT, epoch, SSH, sharedHost);
  return { manager, fake, start };
}

function pendingIdentityTunnel() {
  const identity = deferred<WorkerSshIdentity>();
  const entered = deferred<void>();
  const { fake, manager } = tunnelFixture();
  const request = {
    ...TUNNEL,
    resolveIdentity: () => {
      entered.resolve();
      return identity.promise;
    },
  };
  return { identity, entered, fake, manager, request };
}

function blockedWorkspaceCommand(
  onAbort?: (manager: ReturnType<typeof createWorkerTunnelManager>) => void,
) {
  const entered = deferred<void>();
  const command = deferred<ReturnType<typeof success>>();
  let knownHostsPath = "";
  const fake = fakeRunner(async (argv, options) => {
    knownHostsPath = argv
      .find((arg) => arg.startsWith("UserKnownHostsFile="))!
      .slice("UserKnownHostsFile=".length);
    if (onAbort) {
      options.signal!.addEventListener("abort", () => onAbort(fixture.manager), { once: true });
    }
    entered.resolve();
    return await command.promise;
  });
  const fixture = tunnelFixture(fake);
  return { ...fixture, entered, command, knownHostsPath: () => knownHostsPath };
}

it.each(["connected", "initializing"] as const)(
  "rejects a revoked caller reusing a %s tunnel without stopping its owner",
  async (phase) => {
    const { identity, entered, manager, request } = pendingIdentityTunnel();
    const first = manager.start(request);
    await entered.promise;
    if (phase === "connected") {
      identity.resolve(await resolveIdentity());
      await first;
    }
    let authorized = phase === "initializing";
    const closed = new Error("joining source closed");
    const joining = manager.start({
      ...request,
      authorize: () => {
        if (!authorized) {
          throw closed;
        }
      },
    });
    const rejected = expect(joining).rejects.toBe(closed);
    authorized = false;
    identity.resolve(await resolveIdentity());
    try {
      const handle = await first;
      await rejected;
      expect(manager.status(request.environmentId)).toBe("connected");
      await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
    } finally {
      await Promise.allSettled([first, joining]);
      await manager.stopAll();
    }
  },
);

it.each(["tunnel", "initiating turn"] as const)(
  "does not materialize a late identity after the %s stops",
  async (boundary) => {
    const { identity, entered, fake, manager, request } = pendingIdentityTunnel();
    const writeFile = vi.spyOn(fs, "writeFile");
    let authorized = true;
    const starting = manager.start({
      ...request,
      authorize: () => {
        if (!authorized) {
          throw new Error("initiating turn closed");
        }
      },
      resolveIdentity: async () => {
        entered.resolve();
        return await identity.promise;
      },
    });
    const rejected = expect(starting).rejects.toThrow(
      boundary === "tunnel" ? "no longer connected" : "initiating turn closed",
    );
    try {
      await entered.promise;
      const stopping = boundary === "tunnel" ? manager.stop(ENVIRONMENT, 1) : undefined;
      if (boundary === "initiating turn") {
        authorized = false;
      }
      identity.resolve({ kind: "material", contents: "synthetic-worker-key" });
      await Promise.all([rejected, stopping]);
      expect(writeFile).not.toHaveBeenCalled();
      expect(fake).toMatchObject({ runs: [], starts: [] });
      expect(manager.status(ENVIRONMENT)).toBe("stopped");
    } finally {
      identity.resolve(await resolveIdentity());
      await starting.catch(() => undefined);
      await manager.stopAll();
      writeFile.mockRestore();
    }
  },
);

it("joins workspace cleanup before reporting a desktop stopAll failure", async () => {
  const { identity, entered, manager, request } = pendingIdentityTunnel();
  const starting = manager.start(request);
  const rejectedStart = expect(starting).rejects.toThrow("no longer connected");
  await entered.promise;
  const failure = new Error("desktop cleanup failed");
  const desktopStop = vi.spyOn(manager.desktop, "stopAll").mockRejectedValue(failure);
  let settled = false;
  const stopping = manager.stopAll().finally(() => {
    settled = true;
  });
  const rejectedStop = expect(stopping).rejects.toBe(failure);
  try {
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    identity.resolve(await resolveIdentity());
    await Promise.all([rejectedStart, rejectedStop]);
    desktopStop.mockRestore();
    await manager.stopAll();
  }
});

it("cascades only an epoch-matched environment stop into the desktop tunnel owner", async () => {
  const { fake, manager } = tunnelFixture();
  const starting = manager.desktop.acquire({
    environmentId: ENVIRONMENT,
    ownerEpoch: 2,
    ssh: SSH,
    desktop: { protocol: "rfb", port: 5900 },
    resolveIdentity,
  });
  await waitForStarts(fake.starts, 1);
  fake.starts[0]?.process.becomeReady();
  await starting;
  const close = vi.fn();
  manager.desktop.attachObserver(ENVIRONMENT, {
    control: false,
    ownerEpoch: 2,
    close,
  });

  await manager.stop(ENVIRONMENT, 1);
  expect(fake.starts[0]?.process.stopCount).toBe(0);
  expect(close).not.toHaveBeenCalled();

  await manager.stop(ENVIRONMENT, 2);
  expect(fake.starts[0]?.process.stopCount).toBe(1);
  expect(close).toHaveBeenCalledWith(1012, "desktop tunnel closed");
});

it.each([false, true])(
  "renews a quiescence lease with shared-host isolation=%s",
  async (sharedHost) => {
    const nonce = "a".repeat(32);
    const isolation = sharedHost ? "shared-host" : "dedicated";
    const acquireArgs = `'/home/worker/workspace' '720000' '${isolation}'`;
    const renewArgs = `'/home/worker/workspace' '${nonce}' '720000' '${sharedHost ? "final" : "heartbeat"}' '${isolation}'`;
    const fake = quiescenceRunner(nonce, acquireArgs, renewArgs);
    const { start } = tunnelFixture(fake);
    const handle = await start(3, sharedHost);
    vi.useFakeTimers();
    try {
      const quiescence = await handle.quiesceWorkspace("/home/worker/workspace");
      if (sharedHost) {
        await quiescence.assertActive();
        expect(fake.runs).toHaveLength(2);
        expect(fake.runs.every((entry) => entry.argv.at(-1)?.endsWith("'shared-host'"))).toBe(true);
      } else {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      }
      expect(fake.runs.filter((entry) => entry.argv.at(-1)?.endsWith(renewArgs))).toHaveLength(1);
      await quiescence.resume();
    } finally {
      vi.useRealTimers();
      await handle.stop();
    }
  },
);

it("fences stale owners when a replacement epoch takes ownership", async () => {
  const fake = fakeRunner((argv) =>
    argv.at(-1)?.includes('process.stdout.write("quiesced "')
      ? success(`quiesced ${"c".repeat(32)}\n`)
      : undefined,
  );
  const { manager, start } = tunnelFixture(fake);
  const stale = await start(4);
  const quiescence = await stale.quiesceWorkspace("/home/worker/workspace");

  await expect(start(3)).rejects.toThrow("epoch is stale");

  const replacement = await start(5);
  const priorCommands = fake.runs.length;
  await expect(quiescence.resume()).resolves.toBeUndefined();
  expect(fake.runs).toHaveLength(priorCommands);
  await expect(stale.runWorkspaceCommand(PWD_COMMAND)).rejects.toThrow(
    "Worker tunnel owner is no longer connected",
  );
  await expect(replacement.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
  expect(replacement.ownerEpoch).toBe(5);
  expect(manager.status(ENVIRONMENT)).toBe("connected");
  await replacement.stop();
});

it.each(["stop", "stopAll"] as const)(
  "joins %s while identity preparation drains",
  async (operation) => {
    const { identity, entered, manager, request } = pendingIdentityTunnel();
    const starting = manager.start({
      ...request,
      resolveIdentity: async () => await request.resolveIdentity(),
    });
    const rejected = expect(starting).rejects.toThrow("Worker tunnel owner is no longer connected");
    await entered.promise;
    const stops = [
      operation === "stop" ? manager.stop(ENVIRONMENT, 1) : manager.stopAll(),
      manager.stop(ENVIRONMENT, 1),
      manager.stopAll(),
    ];
    const settled = vi.fn();
    stops.forEach((stopping) => void stopping.then(settled));
    try {
      await setImmediate();
      expect(manager.status(ENVIRONMENT)).toBe("stopped");
      expect(settled).not.toHaveBeenCalled();
    } finally {
      identity.resolve(await resolveIdentity());
      await Promise.all([...stops, rejected]);
    }
  },
);

it.each(["stop", "stopAll"] as const)(
  "joins reentrant %s until workspace commands release their SSH files",
  async (operation) => {
    let reentered: Promise<void> | undefined;
    const { start, entered, command, knownHostsPath } = blockedWorkspaceCommand((owner) => {
      reentered = operation === "stop" ? owner.stop(ENVIRONMENT, 1) : owner.stopAll();
    });
    const handle = await start();
    const running = handle.runWorkspaceCommand(PWD_COMMAND);
    await entered.promise;
    const stopping = handle.stop();
    const settled = vi.fn();
    void reentered!.then(settled);
    try {
      await setImmediate();
      expect(settled).not.toHaveBeenCalled();
      await fs.access(knownHostsPath());
      await expect(handle.runWorkspaceCommand(PWD_COMMAND)).rejects.toThrow("no longer connected");
    } finally {
      command.resolve(success());
      await Promise.all([running, stopping, reentered]);
    }
    await expect(fs.access(knownHostsPath())).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([
  { ownerEpoch: 1, stopAgain: false },
  { ownerEpoch: 1, stopAgain: true },
  { ownerEpoch: 2, stopAgain: true },
])(
  "waits for SSH cleanup before replacement epoch $ownerEpoch (stop again: $stopAgain)",
  async ({ ownerEpoch, stopAgain }) => {
    const { manager, start, entered, command, knownHostsPath } = blockedWorkspaceCommand();
    const first = await start();
    const running = first.runWorkspaceCommand(PWD_COMMAND);
    await entered.promise;
    const stopping = first.stop();
    const nextIdentity = vi.fn(async () => {
      await expect(fs.access(knownHostsPath())).rejects.toMatchObject({ code: "ENOENT" });
      return await resolveIdentity();
    });
    const replacing = manager.start({
      ...TUNNEL,
      ownerEpoch,
      resolveIdentity: nextIdentity,
    });
    void replacing.catch(() => undefined);
    const retainedStop = stopAgain ? manager.stop(ENVIRONMENT, 1) : undefined;
    const stopped = vi.fn();
    void retainedStop?.then(stopped);
    try {
      await setImmediate();
      expect(stopped).not.toHaveBeenCalled();
      expect(nextIdentity).not.toHaveBeenCalled();
      expect(manager.status(ENVIRONMENT)).toBe(
        ownerEpoch === 1 && stopAgain ? "stopped" : "connecting",
      );
      command.resolve(success());
      await Promise.all([running, stopping, retainedStop]);
      if (ownerEpoch === 1 && stopAgain) {
        await expect(replacing).rejects.toThrow("no longer connected");
        expect(nextIdentity).not.toHaveBeenCalled();
      } else {
        const replacement = await replacing;
        expect(nextIdentity).toHaveBeenCalledOnce();
        await expect(replacement.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
      }
    } finally {
      command.resolve(success());
      await Promise.all([running, stopping, retainedStop, replacing.catch(() => undefined)]);
      await manager.stopAll();
    }
  },
);

it("joins a replacement's initialization when prior-owner abort reenters Stop", async () => {
  let shutdown: Promise<void> | undefined;
  const settled = vi.fn();
  const { manager, start, fake, entered, command } = blockedWorkspaceCommand((owner) => {
    shutdown = owner.stopAll();
    void shutdown.then(settled);
  });
  const first = await start();
  const running = first.runWorkspaceCommand(PWD_COMMAND);
  await entered.promise;
  const replacing = start(2);
  const rejected = expect(replacing).rejects.toThrow("no longer connected");
  try {
    expect(shutdown).toBeDefined();
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.status(ENVIRONMENT)).toBe("stopped");
  } finally {
    command.resolve(success());
    await Promise.all([running, shutdown, rejected]);
  }
  expect(fake.runs).toHaveLength(1);
});
it("keeps SSH tunnel failure stderr on a valid UTF-16 boundary", async () => {
  const retained = "b".repeat(4095);
  const child = createWorkerSshRunner().start(
    [process.execPath, "-e", `process.stderr.write(${JSON.stringify(`a😀${retained}`)})`],
    { timeoutMs: 10_000, baseEnv: process.env },
  );

  await expect(child.ready).rejects.toThrow(`Worker SSH tunnel failed: ${retained}`);
  await child.exited;
});

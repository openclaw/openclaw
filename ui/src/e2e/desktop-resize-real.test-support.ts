import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { desktopProofTestReport } from "../../../scripts/lib/desktop-resize-proof.mts";
import { hashWorkerCredential } from "../../../src/gateway/worker-environments/credential.js";
import {
  prepareWorkerSsh,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "../../../src/gateway/worker-environments/ssh.js";
import { createWorkerEnvironmentStore } from "../../../src/gateway/worker-environments/store.js";
import type { WorkerDesktopEndpoint, WorkerSshEndpoint } from "../../../src/plugins/types.js";
import { runCommandWithTimeout } from "../../../src/process/exec.js";
import type { DesktopClient } from "../components/desktop/desktop-client.ts";

/** Serialized into the fixture page; observe the real client without replacing its transport. */
export function observeDesktopProofRfbLifecycle(element: Element) {
  const panel = element as Element & { desktopClientFactory: () => Pick<DesktopClient, "connect"> };
  type Options = Parameters<DesktopClient["connect"]>[0];
  type Report = ReturnType<typeof desktopProofTestReport>;
  type ViewerResizeFailure = NonNullable<
    Report["files"][number]["assertions"][number]["viewerResize"]
  >;
  type Event = NonNullable<ViewerResizeFailure["rfbLifecycle"]>["events"][number];
  const originalFactory = panel.desktopClientFactory;
  const events: Array<{ path: string | null; event: Event }> = [];
  let ordinal = 0;
  let omitted = 0;
  const socketIndex = (key: string | null) => {
    const sockets: unknown = Reflect.get(window, "desktopProofSockets");
    if (key === null || !Array.isArray(sockets)) {
      return null;
    }
    const matches: number[] = [];
    sockets.forEach((socket: WebSocket, index) => {
      const url = new URL(socket.url);
      if (`${url.pathname}${url.search}` === key) {
        matches.push(index);
      }
    });
    return matches.length === 1 ? matches[0]! : null;
  };
  Object.assign(window, {
    desktopProofRfbLifecycle: () => ({
      events: events.map(({ path: key, event }) => ({ ...event, socketIndex: socketIndex(key) })),
      omitted,
    }),
  });
  panel.desktopClientFactory = function () {
    const client = originalFactory.call(panel);
    const connect = client.connect;
    client.connect = function (options: Options) {
      let key: string | null = null;
      try {
        const url = new URL(options.wsUrl, options.gatewayUrl || window.location.href);
        key = `${url.pathname}${url.search}`;
      } catch {
        // No URL inference: an unbound connection remains explicitly unknown.
      }
      let connectedObserved = false;
      const record = (
        phase: Event["phase"],
        clean: boolean | null = null,
        securityStatus: number | null = null,
      ) => {
        try {
          events.push({
            path: key,
            event: {
              ordinal: ordinal++,
              socketIndex: null,
              phase,
              connectedObserved,
              clean,
              securityStatus,
            },
          });
          if (events.length > 8) {
            events.shift();
            omitted += 1;
          }
        } catch {
          // Observation cannot suppress or replace a production callback.
        }
      };
      record("connecting");
      if (options.viewOnly) {
        // Restore future factory calls; this real recovery client's callbacks stay observed.
        panel.desktopClientFactory = originalFactory;
      }
      return connect.call(client, {
        ...options,
        onConnect(...args) {
          connectedObserved = true;
          record("connected");
          return options.onConnect?.(...args);
        },
        onDisconnect(...args) {
          record("disconnected", args[0].clean);
          return options.onDisconnect?.(...args);
        },
        onSecurityFailure(...args) {
          const status = args[0].status;
          record(
            "security-failure",
            null,
            Number.isSafeInteger(status) && status! >= 0 && status! <= 0xffff_ffff ? status! : null,
          );
          return options.onSecurityFailure?.(...args);
        },
      });
    };
    return client;
  };
}

export type DesktopResizeFixture = {
  carrier: "ssh" | "node";
  bootstrapReceipt: WorkerAdmissionHandshake;
  ssh: WorkerSshEndpoint;
  identityPath: string;
  xauthorityPath?: string;
  desktop: WorkerDesktopEndpoint;
  fixedDesktop: WorkerDesktopEndpoint;
  provenance:
    | { kind: "crabbox"; commit: string; installerSha256: string }
    | {
        kind: "upstream-os";
        osRelease: string;
        packageOrigin: string;
        packages: Array<{ name: string; version: string; sha256: string }>;
        serverBinarySha256: string;
      };
  controlUiRoot?: string;
};

export const resizeSources = {
  dynamic: "desktop-resize-dynamic",
  fixed: "desktop-resize-fixed",
  unmanaged: "desktop-resize-unmanaged",
};

/** A transparent loopback tap observes what the real desktop endpoint receives. */
export async function observeDesktopEndpointPackets(port: number, signal: AbortSignal) {
  type Probe = {
    before: Buffer;
    after: Buffer;
    socket?: Socket;
    between: Buffer;
    resolve: (bytes: number) => void;
    reject: (error: Error) => void;
  };
  const peers = new Set<Socket>();
  const terminalEvents: Array<{
    connectionIndex: number;
    side: "client" | "upstream" | "fixture";
    event: "end" | "error" | "close" | "cleanup";
    errorCategory: "reset" | "broken-pipe" | "refused" | "timeout" | "other" | null;
    hadError: boolean | null;
  }> = [];
  const pendingTerminals = new Set<() => void>();
  let connectionCount = 0;
  let omitted = 0;
  const tails = new Map<Socket, Buffer>();
  let pending: Probe | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const fail = (message: string) => {
    pending?.reject(new Error(message));
    pending = undefined;
    tails.clear();
  };
  const observe = (socket: Socket, chunk: Buffer) => {
    const probe = pending;
    if (!probe) {
      return;
    }
    let bytes = Buffer.concat([tails.get(socket) ?? Buffer.alloc(0), chunk]);
    if (probe.socket === socket) {
      bytes = Buffer.concat([probe.between, chunk]);
    }
    if (bytes.length > 64 * 1024) {
      fail("Desktop endpoint observation exceeded its byte bound");
      return;
    }
    const before = bytes.indexOf(probe.before);
    if (before >= 0) {
      if (probe.socket || bytes.includes(probe.before, before + probe.before.length)) {
        fail("Desktop endpoint marker was duplicated or crossed connections");
        return;
      }
      probe.socket = socket;
      bytes = bytes.subarray(before + probe.before.length);
    }
    const after = bytes.indexOf(probe.after);
    if (after >= 0) {
      if (probe.socket !== socket || bytes.includes(probe.after, after + probe.after.length)) {
        fail("Desktop endpoint completion marker was duplicated or crossed connections");
        return;
      }
      pending = undefined;
      tails.clear();
      probe.resolve(after);
    } else if (probe.socket === socket) {
      probe.between = bytes;
      tails.delete(socket);
    } else {
      // Retain only a possible split marker, never unrelated authentication or input bytes.
      tails.set(socket, bytes.subarray(-9));
    }
  };
  const server = net.createServer((client) => {
    if (closed || peers.size >= 32) {
      fail("Desktop endpoint connection bound exceeded");
      client.destroy();
      return;
    }
    const upstream = net.connect({ host: "127.0.0.1", port });
    const connectionIndex = connectionCount++;
    let terminal = false;
    const recordTerminal = (
      side: (typeof terminalEvents)[number]["side"],
      event: (typeof terminalEvents)[number]["event"],
      errorCategory: (typeof terminalEvents)[number]["errorCategory"] = null,
      hadError: boolean | null = null,
    ) => {
      if (terminal) {
        return;
      }
      terminal = true;
      pendingTerminals.delete(recordCleanup);
      terminalEvents.push({ connectionIndex, side, event, errorCategory, hadError });
      if (terminalEvents.length > 8) {
        terminalEvents.shift();
        omitted += 1;
      }
    };
    const recordCleanup = () => recordTerminal("fixture", "cleanup");
    pendingTerminals.add(recordCleanup);
    for (const socket of [client, upstream]) {
      const side = socket === client ? "client" : "upstream";
      peers.add(socket);
      socket.once("end", () => recordTerminal(side, "end"));
      socket.on("error", (error: NodeJS.ErrnoException) => {
        const category =
          error.code === "ECONNRESET"
            ? "reset"
            : error.code === "EPIPE"
              ? "broken-pipe"
              : error.code === "ECONNREFUSED"
                ? "refused"
                : error.code === "ETIMEDOUT"
                  ? "timeout"
                  : "other";
        // Latch before destroying the paired socket; its later close is a consequence.
        recordTerminal(side, "error", category);
        fail("Desktop endpoint connection failed during observation");
        client.destroy();
        upstream.destroy();
      });
      socket.once("close", (hadError) => {
        recordTerminal(side, "close", null, hadError);
        peers.delete(socket);
        tails.delete(client);
        if (pending) {
          fail("Desktop endpoint closed before the completion marker");
        }
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (chunk: Buffer) => observe(client, chunk));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      signal.removeEventListener("abort", abort);
      fail("Desktop endpoint observation ended before completion");
      for (const record of pendingTerminals) {
        record();
      }
      const stopped = [...peers].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          }),
      );
      await Promise.all([
        ...stopped,
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
    })());
  const abort = () => fail("Desktop endpoint observation aborted before completion");
  signal.throwIfAborted();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Missing desktop endpoint tap address");
  }
  return {
    port: address.port,
    terminalSnapshot: () => ({ events: structuredClone(terminalEvents), omitted }),
    expectPacket: (bytes: number[]) => {
      signal.throwIfAborted();
      if (closed || pending || bytes.length > 32 * 1024) {
        throw new Error("Desktop endpoint probe is closed, busy, or oversized");
      }
      const marker = (x: number, y: number) => {
        // Valid one-pixel requests inside every tested display; noVNC requests the full frame.
        const packet = Buffer.from([3, 1, 0, 0, 0, 0, 0, 1, 0, 1]);
        packet.writeUInt16BE(x, 2);
        packet.writeUInt16BE(y, 4);
        return packet;
      };
      const x = randomInt(1, 120);
      const y = randomInt(1, 120);
      const before = marker(x, y);
      const after = marker(x + 1, y + 1);
      const payload = Buffer.from(bytes);
      if (payload.includes(before) || payload.includes(after)) {
        throw new Error("Desktop endpoint marker collided with the forbidden payload");
      }
      const result = new Promise<number>((resolve, reject) => {
        pending = { before, after, between: Buffer.alloc(0), resolve, reject };
      });
      // A failed browser send can enter cleanup before the caller awaits the observation.
      void result.catch(() => {});
      return { bytes: Array.from(Buffer.concat([before, payload, after])), result };
    },
    close,
  };
}

function hasPinnedProvenance(provenance: unknown): boolean {
  if (!isRecord(provenance)) {
    return false;
  }
  const sha256 = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (provenance.kind === "crabbox") {
    return (
      typeof provenance.commit === "string" &&
      /^[a-f0-9]{40}$/u.test(provenance.commit) &&
      sha256(provenance.installerSha256)
    );
  }
  return (
    provenance.kind === "upstream-os" &&
    typeof provenance.osRelease === "string" &&
    provenance.osRelease.length > 0 &&
    typeof provenance.packageOrigin === "string" &&
    provenance.packageOrigin.length > 0 &&
    sha256(provenance.serverBinarySha256) &&
    Array.isArray(provenance.packages) &&
    provenance.packages.length > 0 &&
    provenance.packages.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        entry.name.length > 0 &&
        typeof entry.version === "string" &&
        entry.version.length > 0 &&
        sha256(entry.sha256),
    )
  );
}

export async function readDesktopResizeFixture(file: string): Promise<DesktopResizeFixture> {
  const fixture = JSON.parse(await readFile(file, "utf8")) as DesktopResizeFixture;
  if (
    !fixture ||
    (fixture.carrier !== "ssh" && fixture.carrier !== "node") ||
    !fixture.identityPath ||
    !fixture.ssh?.hostKey ||
    !fixture.desktop?.passwordFilePath ||
    !fixture.fixedDesktop?.passwordFilePath ||
    !fixture.bootstrapReceipt ||
    !hasPinnedProvenance(fixture.provenance)
  ) {
    throw new Error(
      "Desktop resize proof requires a carrier, build receipt, pinned SSH/VNC facts, and provenance",
    );
  }
  return fixture;
}

/** Provisioning fixture only: no RPC, RFB, registry, or tunnel implementation is replaced. */
export async function writeDesktopResizeProvider(root: string, fixture: DesktopResizeFixture) {
  const pluginDir = path.join(root, "desktop-resize-fixture");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "desktop-resize-fixture",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "desktop-resize-fixture",
      activation: { onStartup: true },
      contracts: { workerProviders: ["desktop-resize-fixture", "desktop-unmanaged-fixture"] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await writeFile(
    path.join(pluginDir, "index.js"),
    `export default {
      id: "desktop-resize-fixture",
      register(api) {
        for (const allowsDesktopResize of [true, false]) {
          api.registerWorkerProvider({
            id: allowsDesktopResize ? "desktop-resize-fixture" : "desktop-unmanaged-fixture",
            allowsDesktopResize,
            supportedExecutionModes: ["remote-exec"],
            resolveAllocation: async () => { throw new Error("fixture is already provisioned"); },
            provision: async () => { throw new Error("fixture is already provisioned"); },
            inspect: async () => ({ status: "active", sharedHost: false }),
            resolveSshIdentity: async () => ${
              fixture.carrier === "node"
                ? '{ throw new Error("Node desktop fixture must not resolve SSH credentials"); }'
                : `({ kind: "path", path: ${JSON.stringify(fixture.identityPath)} })`
            },
            destroy: async () => {},
          });
        }
      },
    };`,
  );
  return pluginDir;
}

export async function seedDesktopResizeSources(
  fixture: DesktopResizeFixture,
  nodeDeviceId?: string,
) {
  if (fixture.carrier === "node" && !nodeDeviceId) {
    throw new Error("Node desktop proof requires the prepared node device identity");
  }
  const store = await createWorkerEnvironmentStore();
  try {
    for (const [kind, environmentId] of Object.entries(resizeSources)) {
      const intent = await store.createIntent({
        environmentId,
        providerId: kind === "unmanaged" ? "desktop-unmanaged-fixture" : "desktop-resize-fixture",
        profileId: "resize-fixture",
        profileSnapshot: { executionMode: "remote-exec", settings: {} },
        provisionOperationId: `provision:${environmentId}`,
      });
      const provisioning = await store.transition({
        environmentId,
        from: intent.state,
        to: "provisioning",
      });
      const desktop = kind === "fixed" ? fixture.fixedDesktop : fixture.desktop;
      const owner = { leaseId: `lease:${environmentId}`, sharedHost: false, desktop };
      const preparing =
        fixture.carrier === "node"
          ? provisioning
          : await store.transition({
              environmentId,
              from: provisioning.state,
              to: "bootstrapping",
              patch: { ...owner, sshEndpoint: fixture.ssh },
            });
      await store.transition({
        environmentId,
        from: preparing.state,
        to: "ready",
        patch: {
          ...(fixture.carrier === "node" ? { ...owner, nodeDeviceId, sshEndpoint: null } : {}),
          // Match the running build so startup reconciliation preserves this provisioned fixture.
          bootstrapReceipt: fixture.bootstrapReceipt,
          credential: {
            credentialHash: hashWorkerCredential(`desktop-resize-proof:${environmentId}`),
            sessionId: null,
            rpcSetVersion: 1,
            expiresAtMs: Date.now() + 3_600_000,
          },
        },
      });
    }
  } finally {
    await store.close();
  }
}

export async function createDesktopResizeGuest(fixture: DesktopResizeFixture) {
  const ssh = await prepareWorkerSsh({
    ssh: fixture.ssh,
    pinnedHostKey: fixture.ssh.hostKey,
    resolveIdentity: async () => ({ kind: "path", path: fixture.identityPath }),
  });
  const run = async (argv: string[]) => {
    const result = await runCommandWithTimeout(
      [
        "ssh",
        ...workerSshOptions(ssh, { forwarding: "disabled" }),
        "-p",
        String(ssh.port),
        "--",
        ssh.sshTarget,
        workerSshRemoteCommand(
          fixture.xauthorityPath ? ["env", `XAUTHORITY=${fixture.xauthorityPath}`, ...argv] : argv,
        ),
      ],
      workerSshCommandOptions({ timeoutMs: 10_000 }),
    );
    if (result.code !== 0) {
      throw new Error(`Desktop fixture command failed: ${result.stderr}`);
    }
    return result.stdout;
  };
  return {
    run,
    close: () => ssh.dispose(),
    geometry: async (display = ":99") => {
      const output = await run(["env", `DISPLAY=${display}`, "xrandr", "--current"]);
      const match = /current (\d+) x (\d+)/u.exec(output);
      if (!match) {
        throw new Error("Guest xrandr did not report current geometry");
      }
      return { width: Number(match[1]), height: Number(match[2]) };
    },
  };
}

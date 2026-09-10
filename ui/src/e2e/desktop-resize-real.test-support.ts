import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import * as desktopFilter from "../../../src/gateway/desktop/rfb-view-only-filter.js";
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

export type DesktopResizeFixture = {
  carrier: "ssh" | "node";
  ssh: WorkerSshEndpoint;
  identityPath: string;
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

/** Observe real filter decisions without replacing its state machine or forwarding result. */
export function observeDesktopFilterPackets(signal: AbortSignal) {
  const sockets = new Map<string, WebSocket>();
  type FilterResult = ReturnType<
    ReturnType<typeof desktopFilter.createRfbClientMessageFilter>["filter"]
  >;
  type Expectation = {
    socket: WebSocket;
    bytes: Buffer;
    resolve: (result: FilterResult) => void;
    reject: (error: Error) => void;
  };
  const pending = new Set<Expectation>();
  const filterSpies: Array<{ mockRestore: () => void }> = [];
  const upgrading = new AsyncLocalStorage<WebSocket>();
  const phases = new Map<WebSocket, "version" | "clientInit">();
  // Capture before spying; each invocation must retain its actual server receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const upgrade: WebSocketServer["handleUpgrade"] = WebSocketServer.prototype.handleUpgrade;
  const upgradeSpy = vi.spyOn(WebSocketServer.prototype, "handleUpgrade");
  upgradeSpy.mockImplementation(function (this: WebSocketServer, request, socket, head, callback) {
    return upgrade.call(this, request, socket, head, (ws, incoming) => {
      if (request.url?.startsWith("/desktop/observe?")) {
        sockets.set(request.url, ws);
      }
      // Node preauthentication creates the filter after an await. Keep this
      // observer's identity through that continuation and concurrent upgrades.
      upgrading.run(ws, () => callback(ws, incoming));
    });
  });
  const createFilter = desktopFilter.createRfbClientMessageFilter;
  const factorySpy = vi
    .spyOn(desktopFilter, "createRfbClientMessageFilter")
    .mockImplementation((options) => {
      const filter = createFilter(options);
      const socket = upgrading.getStore();
      if (socket) {
        phases.set(socket, options?.startPhase ?? "version");
      }
      const original = filter.filter.bind(filter);
      filterSpies.push(
        vi.spyOn(filter, "filter").mockImplementation((bytes) => {
          const result = original(bytes);
          for (const expected of pending) {
            if (expected.socket === socket && expected.bytes.equals(bytes)) {
              pending.delete(expected);
              expected.resolve(result);
            }
          }
          return result;
        }),
      );
      return filter;
    });
  const abort = () => {
    for (const expected of pending) {
      expected.reject(new Error("Desktop packet observation ended before processing"));
    }
    pending.clear();
  };
  signal.addEventListener("abort", abort, { once: true });
  const observerSocket = (socketUrl: string) => {
    const url = new URL(socketUrl);
    const socket = sockets.get(`${url.pathname}${url.search}`);
    if (!socket) {
      throw new Error("The selected observer socket has no production upgrade identity");
    }
    return socket;
  };
  return {
    startPhase: (socketUrl: string) => phases.get(observerSocket(socketUrl)),
    expectPacket: (socketUrl: string, bytes: number[]) => {
      signal.throwIfAborted();
      const socket = observerSocket(socketUrl);
      return new Promise<FilterResult>((resolve, reject) => {
        pending.add({ socket, bytes: Buffer.from(bytes), resolve, reject });
      });
    },
    close: () => {
      signal.removeEventListener("abort", abort);
      abort();
      for (const spy of filterSpies) {
        spy.mockRestore();
      }
      factorySpy.mockRestore();
      upgradeSpy.mockRestore();
      upgrading.disable();
      phases.clear();
      sockets.clear();
    },
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
    !hasPinnedProvenance(fixture.provenance)
  ) {
    throw new Error(
      "Desktop resize proof requires a carrier, pinned SSH/VNC facts, and provenance",
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

export function seedDesktopResizeSources(fixture: DesktopResizeFixture, nodeDeviceId?: string) {
  if (fixture.carrier === "node" && !nodeDeviceId) {
    throw new Error("Node desktop proof requires the actually admitted node device");
  }
  const store = createWorkerEnvironmentStore();
  for (const [kind, environmentId] of Object.entries(resizeSources)) {
    const intent = store.createIntent({
      environmentId,
      providerId: kind === "unmanaged" ? "desktop-unmanaged-fixture" : "desktop-resize-fixture",
      profileId: "resize-fixture",
      profileSnapshot: { executionMode: "remote-exec", settings: {} },
      provisionOperationId: `provision:${environmentId}`,
    });
    const provisioning = store.transition({
      environmentId,
      from: intent.state,
      to: "provisioning",
    });
    const desktop = kind === "fixed" ? fixture.fixedDesktop : fixture.desktop;
    const owner = { leaseId: `lease:${environmentId}`, sharedHost: false, desktop };
    const preparing =
      fixture.carrier === "node"
        ? provisioning
        : store.transition({
            environmentId,
            from: provisioning.state,
            to: "bootstrapping",
            patch: { ...owner, sshEndpoint: fixture.ssh },
          });
    store.transition({
      environmentId,
      from: preparing.state,
      to: "ready",
      patch: {
        ...(fixture.carrier === "node" ? { ...owner, nodeDeviceId, sshEndpoint: null } : {}),
        // Synthetic provisioning receipt, not evidence of a cloud bootstrap.
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.9.1",
          protocolFeatures: [],
        },
        credential: {
          credentialHash: hashWorkerCredential(`desktop-resize-proof:${environmentId}`),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: Date.now() + 3_600_000,
        },
      },
    });
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
        workerSshRemoteCommand(argv),
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

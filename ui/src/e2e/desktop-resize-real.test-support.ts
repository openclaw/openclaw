import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  ssh: WorkerSshEndpoint;
  identityPath: string;
  desktop: WorkerDesktopEndpoint;
  fixedDesktop: WorkerDesktopEndpoint;
  crabboxCommit: string;
  installerSha256: string;
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
  let upgrading: WebSocket | undefined;
  // Capture before spying; each invocation must retain its actual server receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const upgrade: WebSocketServer["handleUpgrade"] = WebSocketServer.prototype.handleUpgrade;
  const upgradeSpy = vi.spyOn(WebSocketServer.prototype, "handleUpgrade");
  upgradeSpy.mockImplementation(function (this: WebSocketServer, request, socket, head, callback) {
    return upgrade.call(this, request, socket, head, (ws, incoming) => {
      const previous = upgrading;
      upgrading = ws;
      if (request.url?.startsWith("/desktop/observe?")) {
        sockets.set(request.url, ws);
      }
      try {
        callback(ws, incoming);
      } finally {
        upgrading = previous;
      }
    });
  });
  const createFilter = desktopFilter.createRfbClientMessageFilter;
  const factorySpy = vi
    .spyOn(desktopFilter, "createRfbClientMessageFilter")
    .mockImplementation((options) => {
      const filter = createFilter(options);
      const socket = upgrading;
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
  return {
    expectPacket: (socketUrl: string, bytes: number[]) => {
      signal.throwIfAborted();
      const url = new URL(socketUrl);
      const socket = sockets.get(`${url.pathname}${url.search}`);
      if (!socket) {
        throw new Error("The selected observer socket has no production upgrade identity");
      }
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
      sockets.clear();
    },
  };
}

export async function readDesktopResizeFixture(file: string): Promise<DesktopResizeFixture> {
  const fixture = JSON.parse(await readFile(file, "utf8")) as DesktopResizeFixture;
  if (
    !fixture.identityPath ||
    !fixture.ssh?.hostKey ||
    !fixture.desktop?.passwordFilePath ||
    !fixture.fixedDesktop?.passwordFilePath ||
    !/^[a-f0-9]{40}$/u.test(fixture.crabboxCommit) ||
    !/^[a-f0-9]{64}$/u.test(fixture.installerSha256)
  ) {
    throw new Error("Desktop resize proof requires pinned SSH, VNC credentials, and source hashes");
  }
  return fixture;
}

/** Provisioning fixture only: no RPC, RFB, registry, or tunnel implementation is replaced. */
export async function writeDesktopResizeProvider(root: string, identityPath: string) {
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
            resolveSshIdentity: async () => ({ kind: "path", path: ${JSON.stringify(identityPath)} }),
            destroy: async () => {},
          });
        }
      },
    };`,
  );
  return pluginDir;
}

export function seedDesktopResizeSources(fixture: DesktopResizeFixture) {
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
    const bootstrapping = store.transition({
      environmentId,
      from: provisioning.state,
      to: "bootstrapping",
      patch: {
        leaseId: `lease:${environmentId}`,
        sshEndpoint: fixture.ssh,
        sharedHost: false,
        desktop: kind === "fixed" ? fixture.fixedDesktop : fixture.desktop,
      },
    });
    store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: {
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

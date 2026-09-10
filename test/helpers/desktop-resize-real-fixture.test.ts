import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import * as desktopFilter from "../../src/gateway/desktop/rfb-view-only-filter.js";
import { createWorkerEnvironmentStore } from "../../src/gateway/worker-environments/store.js";
import type { WorkerProvider } from "../../src/plugins/types.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.js";
import { withEnv } from "../../src/test-utils/env.js";
import {
  observeDesktopFilterPackets,
  readDesktopResizeFixture,
  resizeSources,
  seedDesktopResizeSources,
  writeDesktopResizeProvider,
  type DesktopResizeFixture,
} from "../../ui/src/e2e/desktop-resize-real.test-support.js";
import { createDeferred } from "./promise.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(carrier: DesktopResizeFixture["carrier"] = "ssh"): DesktopResizeFixture {
  return {
    carrier,
    ssh: {
      host: "127.0.0.1",
      port: 2222,
      user: "desktop-proof",
      hostKey: "ssh-ed25519 AAAA",
      keyRef: { source: "env", provider: "default", id: "DESKTOP_PROOF_KEY" },
    },
    identityPath: "/tmp/desktop-proof-identity",
    desktop: { protocol: "rfb", port: 5999, passwordFilePath: "/tmp/desktop-proof-password" },
    fixedDesktop: { protocol: "rfb", port: 6000, passwordFilePath: "/tmp/desktop-proof-password" },
    provenance: {
      kind: "upstream-os",
      osRelease: "Ubuntu 24.04",
      packageOrigin: "signed Ubuntu archive",
      packages: [
        { name: "tigervnc-standalone-server", version: "fixture", sha256: "a".repeat(64) },
      ],
      serverBinarySha256: "b".repeat(64),
    },
  };
}

describe("desktop resize fixture provenance and carrier", () => {
  it.each(["ssh", "node"] as const)(
    "retains explicit upstream provenance for %s",
    async (carrier) => {
      const file = path.join(tempDirs.make("desktop-resize-fixture-"), "fixture.json");
      const value = fixture(carrier);
      await writeFile(file, JSON.stringify(value));
      expect(await readDesktopResizeFixture(file)).toEqual(value);
      expect(value).not.toHaveProperty("crabboxCommit");
    },
  );

  it("retains real Crabbox provenance as a separate source kind", async () => {
    const file = path.join(tempDirs.make("desktop-resize-fixture-"), "fixture.json");
    const value = fixture();
    value.provenance = {
      kind: "crabbox",
      commit: "c".repeat(40),
      installerSha256: "d".repeat(64),
    };
    await writeFile(file, JSON.stringify(value));
    expect(await readDesktopResizeFixture(file)).toEqual(value);
  });

  it.each([
    { carrier: "physical" },
    { provenance: undefined },
    { provenance: { kind: "upstream-os", serverBinarySha256: "unverified" } },
    { provenance: { kind: "crabbox", commit: "not-a-commit", installerSha256: "e".repeat(64) } },
  ])("rejects an unqualified fixture %j", async (invalid) => {
    const file = path.join(tempDirs.make("desktop-resize-fixture-"), "fixture.json");
    await writeFile(file, JSON.stringify({ ...fixture(), ...invalid }));
    await expect(readDesktopResizeFixture(file)).rejects.toThrow("provenance");
  });

  it.each(["ssh", "node"] as const)(
    "persists a ready %s worker and synthetic receipt across reopen",
    (carrier) => {
      const root = tempDirs.make("desktop-resize-store-");
      withEnv({ OPENCLAW_STATE_DIR: root }, () => {
        const database = openOpenClawStateDatabase();
        try {
          expect(database.path).toBe(path.join(root, "state", "openclaw.sqlite"));
          const value = fixture(carrier);
          if (carrier === "node") {
            expect(() => seedDesktopResizeSources(value)).toThrow("actually admitted");
            expect(createWorkerEnvironmentStore().list()).toEqual([]);
          }
          seedDesktopResizeSources(value, carrier === "node" ? "admitted-device" : undefined);
          closeOpenClawStateDatabaseByPath(database.path);
          expect(database.db.isOpen).toBe(false);
          const reopened = createWorkerEnvironmentStore();
          expect(reopened.list()).toHaveLength(Object.keys(resizeSources).length);
          for (const [kind, environmentId] of Object.entries(resizeSources)) {
            expect(reopened.get(environmentId)).toMatchObject({
              state: "ready",
              leaseId: `lease:${environmentId}`,
              nodeDeviceId: carrier === "node" ? "admitted-device" : null,
              sshEndpoint: carrier === "node" ? null : value.ssh,
              sharedHost: false,
              desktop: kind === "fixed" ? value.fixedDesktop : value.desktop,
              bootstrapReceipt: {
                bundleHash: "a".repeat(64),
                openclawVersion: "2026.9.1",
                protocolFeatures: [],
              },
            });
          }
        } finally {
          // Close the exact store before restoring selectors or removing its root.
          closeOpenClawStateDatabaseByPath(database.path);
        }
      });
    },
  );

  it("makes an SSH identity fallback fail in the node provider", async () => {
    const root = await writeDesktopResizeProvider(
      tempDirs.make("desktop-resize-provider-"),
      fixture("node"),
    );
    const plugin = (await import(pathToFileURL(path.join(root, "index.js")).href)) as {
      default: {
        register: (api: { registerWorkerProvider: (provider: WorkerProvider) => void }) => void;
      };
    };
    const providers: WorkerProvider[] = [];
    plugin.default.register({ registerWorkerProvider: (provider) => providers.push(provider) });
    expect(providers.map((provider) => provider.allowsDesktopResize)).toEqual([true, false]);
    for (const provider of providers) {
      await expect(
        provider.resolveSshIdentity!({
          leaseId: "fixture",
          profile: { executionMode: "remote-exec", settings: {} },
          keyRef: fixture().ssh.keyRef,
        }),
      ).rejects.toThrow("must not resolve SSH");
    }
  });
});

type Filter = ReturnType<typeof desktopFilter.createRfbClientMessageFilter>;

async function openObservers(delayed: boolean[]) {
  const abort = new AbortController();
  const probe = observeDesktopFilterPackets(abort.signal);
  const server = createServer();
  const servers = delayed.map(() => new WebSocketServer({ noServer: true }));
  const clients: WebSocket[] = [];
  const gates = delayed.map(() => createDeferred());
  const ready = delayed.map(() => createDeferred<Filter>());
  onTestFinished(async () => {
    gates.forEach((gate) => gate.resolve());
    abort.abort();
    clients.forEach((client) => client.terminate());
    servers.forEach((owner) => owner.clients.forEach((socket) => socket.terminate()));
    await Promise.all(
      servers.map(
        (owner) =>
          new Promise<void>((resolve) => {
            owner.close(() => resolve());
          }),
      ),
    );
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    probe.close();
  });
  server.on("upgrade", (request, socket, head) => {
    const index = Number(new URL(request.url!, "http://127.0.0.1").searchParams.get("token"));
    servers[index]!.handleUpgrade(request, socket, head, (ws) => {
      const install = () => {
        const filter = desktopFilter.createRfbClientMessageFilter({ startPhase: "clientInit" });
        expect(filter.filter(Buffer.from([1]))).toEqual({ forward: Buffer.from([1]) });
        ws.on("message", (data) => {
          if (!Buffer.isBuffer(data)) {
            throw new Error("Expected the real WebSocket binary message buffer");
          }
          filter.filter(data);
        });
        ready[index]!.resolve(filter);
      };
      if (delayed[index]) {
        void gates[index]!.promise.then(install);
      } else {
        install();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback observer address");
  }
  for (let index = 0; index < delayed.length; index += 1) {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/desktop/observe?token=${index}`);
    clients.push(client);
    await once(client, "open");
  }
  return { abort, probe, clients, gates, ready };
}

describe("desktop observer packet attribution", () => {
  it.each([false, true])(
    "preserves the real receiver and forwarding after delayed=%s",
    async (delayed) => {
      const owner = await openObservers([delayed]);
      owner.gates[0]!.resolve();
      const filter = await owner.ready[0]!.promise;
      const client = owner.clients[0]!;
      expect(owner.probe.startPhase(client.url)).toBe("clientInit");
      const request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 10, 0, 10]);
      const processed = owner.probe.expectPacket(client.url, Array.from(request));
      client.send(request);
      expect(await processed).toEqual({ forward: request });
      // ClientInit and this exact request each enter the unchanged stateful filter once.
      expect(Object.getOwnPropertyDescriptor(filter, "filter")!.value).toHaveBeenCalledTimes(2);
    },
  );

  it("attributes identical packets to interleaved asynchronous observer sockets", async () => {
    const owner = await openObservers([true, true]);
    owner.gates[1]!.resolve();
    await owner.ready[1]!.promise;
    owner.gates[0]!.resolve();
    await owner.ready[0]!.promise;
    const packet = [4, 1, 0, 0, 0, 0, 0, 97];
    const [first, second] = owner.clients as [WebSocket, WebSocket];
    const firstProcessed = owner.probe.expectPacket(first.url, packet);
    let secondProcessed = false;
    const secondResult = owner.probe.expectPacket(second.url, packet).then((result) => {
      secondProcessed = true;
      return result;
    });
    first.send(Buffer.from(packet));
    expect(await firstProcessed).toEqual({ forward: Buffer.alloc(0) });
    expect(secondProcessed).toBe(false);
    second.send(Buffer.from(packet));
    expect(await secondResult).toEqual({ forward: Buffer.alloc(0) });
  });

  it("rejects incomplete packet expectations on abort and restores instrumentation on close", async () => {
    const original = Object.getOwnPropertyDescriptor(
      WebSocketServer.prototype,
      "handleUpgrade",
    )!.value;
    const factory = desktopFilter.createRfbClientMessageFilter;
    const owner = await openObservers([false]);
    await owner.ready[0]!.promise;
    const client = owner.clients[0]!;
    const rejection = expect(owner.probe.expectPacket(client.url, [4, 1])).rejects.toThrow(
      "ended before processing",
    );
    client.send(Buffer.from([4]));
    owner.abort.abort();
    await rejection;
    expect(() => owner.probe.expectPacket(client.url, [4])).toThrow();
    owner.probe.close();
    expect(Object.getOwnPropertyDescriptor(WebSocketServer.prototype, "handleUpgrade")!.value).toBe(
      original,
    );
    expect(desktopFilter.createRfbClientMessageFilter).toBe(factory);
  });
});

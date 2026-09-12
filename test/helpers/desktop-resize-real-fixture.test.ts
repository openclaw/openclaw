import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as desktopFilter from "../../src/gateway/desktop/rfb-view-only-filter.js";
import { createWorkerEnvironmentStore } from "../../src/gateway/worker-environments/store.js";
import type { WorkerProvider } from "../../src/plugins/types.js";
import * as processExec from "../../src/process/exec.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.js";
import { withEnv } from "../../src/test-utils/env.js";
import {
  createDesktopResizeGuest,
  observeDesktopEndpointPackets,
  readDesktopResizeFixture,
  resizeSources,
  seedDesktopResizeSources,
  writeDesktopResizeProvider,
  type DesktopResizeFixture,
} from "../../ui/src/e2e/desktop-resize-real.test-support.js";
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
  it.each([undefined, "/tmp/desktop proof/Xauthority"])(
    "uses private Xauthority for all guest commands when supplied: %s",
    async (xauthorityPath) => {
      const command = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
        stdout: "Screen 0: current 1200 x 850",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
      const guest = await createDesktopResizeGuest({ ...fixture(), xauthorityPath });
      try {
        expect(await guest.geometry()).toEqual({ width: 1200, height: 850 });
        const argv = command.mock.calls[0]![0];
        expect(argv[0]).toBe("ssh");
        const remote = argv.at(-1)!;
        expect(remote).toContain("DISPLAY=:99");
        expect(remote).toContain("xrandr");
        if (xauthorityPath) {
          expect(remote).toContain("'XAUTHORITY=/tmp/desktop proof/Xauthority'");
        } else {
          expect(remote).not.toContain("XAUTHORITY");
        }
      } finally {
        await guest.close();
        command.mockRestore();
      }
    },
  );
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

async function openEndpointTap() {
  const abort = new AbortController();
  const peers = new Set<Socket>();
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      socket.write(chunk);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback endpoint address");
  }
  const tap = await observeDesktopEndpointPackets(address.port, abort.signal);
  const clients = new Set<Socket>();
  onTestFinished(async () => {
    abort.abort();
    await tap.close();
    for (const socket of [...clients, ...peers]) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    abort,
    tap,
    peers,
    received,
    connect: async () => {
      const client = net.connect({ host: "127.0.0.1", port: tap.port });
      clients.add(client);
      client.on("error", () => {});
      await once(client, "connect");
      return client;
    },
  };
}

describe("desktop endpoint packet attribution", () => {
  const key = [4, 1, 0, 0, 0, 0, 0, 97];
  it("counts zero only after fragmented same-connection markers traverse the real filter", async () => {
    const owner = await openEndpointTap();
    const client = await owner.connect();
    const filter = desktopFilter.createRfbClientMessageFilter({ startPhase: "clientInit" });
    filter.filter(Buffer.from([1]));
    const probe = owner.tap.expectPacket(key);
    const filtered = filter.filter(Buffer.from(probe.bytes));
    expect(filtered.error).toBeUndefined();
    expect(filtered.forward).toHaveLength(20);
    for (const byte of filtered.forward!) {
      const echo = once(client, "data");
      client.write(Buffer.from([byte]));
      await echo;
    }
    expect(await probe.result).toBe(0);
    expect(Buffer.concat(owner.received)).toEqual(filtered.forward);
  });

  it("detects forwarded forbidden bytes instead of accepting unchanged guest state", async () => {
    const owner = await openEndpointTap();
    const client = await owner.connect();
    const probe = owner.tap.expectPacket(key);
    client.write(Buffer.from(probe.bytes));
    expect(await probe.result).toBe(key.length);
  });

  it.each(["split", "duplicate-before", "duplicate-after"])(
    "rejects %s marker attribution",
    async (kind) => {
      const owner = await openEndpointTap();
      const first = await owner.connect();
      const second = await owner.connect();
      const probe = owner.tap.expectPacket(key);
      const bytes = Buffer.from(probe.bytes);
      const before = bytes.subarray(0, 10);
      const after = bytes.subarray(-10);
      const rejection = expect(probe.result).rejects.toThrow(/duplicated|crossed/u);
      if (kind === "split") {
        const echo = once(first, "data");
        first.write(before);
        await echo;
        second.write(after);
      } else {
        first.write(
          Buffer.concat(
            kind === "duplicate-before" ? [before, before, after] : [before, after, after],
          ),
        );
      }
      await rejection;
    },
  );

  it.each(["abort", "close", "upstream-close", "overflow"])(
    "rejects unfinished evidence on %s",
    async (kind) => {
      const owner = await openEndpointTap();
      const client = await owner.connect();
      const probe = owner.tap.expectPacket(key);
      const rejection = expect(probe.result).rejects.toThrow(/aborted|ended|closed|bound/u);
      const echo = once(client, "data");
      client.write(Buffer.from(probe.bytes.slice(0, 10)));
      await echo;
      if (kind === "abort") {
        owner.abort.abort();
      } else if (kind === "close") {
        await owner.tap.close();
      } else if (kind === "upstream-close") {
        owner.peers.forEach((socket) => socket.destroy());
      } else {
        client.write(Buffer.alloc(64 * 1024 + 1, 9));
      }
      await rejection;
    },
  );

  it("joins its listener and rejects late or concurrent observations", async () => {
    const owner = await openEndpointTap();
    const probe = owner.tap.expectPacket(key);
    expect(() => owner.tap.expectPacket(key)).toThrow("busy");
    const rejection = expect(probe.result).rejects.toThrow("aborted");
    owner.abort.abort();
    await rejection;
    await owner.tap.close();
    expect(() => owner.tap.expectPacket(key)).toThrow();
    const socket = net.connect({ host: "127.0.0.1", port: owner.tap.port });
    await expect(once(socket, "connect")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

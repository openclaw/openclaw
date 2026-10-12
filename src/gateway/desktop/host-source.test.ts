import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { DesktopHostConfig } from "../../config/types.desktop.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  createHostDesktopService,
  createHostDesktopSource,
  inspectHostDesktop,
  inspectHostDesktopSetup,
} from "./host-source.js";
import type { ManagedLinuxDesktop } from "./managed-linux.js";
import * as managedLinux from "./managed-linux.js";
import { releaseDesktopObserverToken } from "./observe-bridge.js";
import * as rfbProbe from "./rfb-probe.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function listenRfb(params: { banner?: string; securityTypes?: number[] }) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.write(Buffer.from(params.banner ?? "RFB 003.008\n", "ascii"));
    if (params.securityTypes) {
      socket.once("data", () => {
        socket.write(Buffer.from([params.securityTypes!.length, ...params.securityTypes!]));
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected RFB server address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return address.port;
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

function fakeManagedDesktop(
  status: ReturnType<ManagedLinuxDesktop["status"]> = { state: "not-started" },
) {
  let active = true;
  const leases = new Set<{ onStop(): Promise<void> }>();
  const acquire = vi.fn(async () => {
    active = true;
    return {
      attachment: { kind: "tcp" as const, host: "127.0.0.1" as const, port: 46_001 },
      auth: "vnc-password" as const,
      vncPassword: "managed-secret",
    };
  });
  const acquireComputer = vi.fn(async (params: { onStop(): Promise<void> }) => {
    leases.add(params);
    return {
      env: { DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: "unix:path=/managed/bus" },
      isCurrent: () => active && leases.has(params),
      release: () => {
        leases.delete(params);
      },
    };
  });
  const stop = vi.fn(async () => {
    active = false;
    await Promise.all([...leases].map(async (lease) => await lease.onStop()));
    leases.clear();
  });
  const managed: ManagedLinuxDesktop = { acquire, acquireComputer, stop, status: () => status };
  return { acquire, acquireComputer, managed, stop };
}

describe("gateway host desktop source", () => {
  it.each<{
    name: string;
    server?: Parameters<typeof listenRfb>[0];
    state: "ready" | "unsupported" | "needs-server";
  }>([
    { name: "VncAuth", server: { banner: "RFB 003.008\n", securityTypes: [2] }, state: "ready" },
    {
      name: "Screen Sharing",
      server: { banner: "RFB 003.889\n", securityTypes: [30] },
      state: "ready",
    },
    { name: "unauthenticated VNC", server: { securityTypes: [1] }, state: "unsupported" },
    { name: "VeNCrypt", server: { securityTypes: [19] }, state: "unsupported" },
    { name: "another service", server: { banner: "HTTP/1.1 200" }, state: "unsupported" },
    { name: "missing server", state: "needs-server" },
  ])("discovers $name for setup while desktop access stays disabled", async ({ server, state }) => {
    const port = server ? await listenRfb(server) : await unusedPort();
    const config = Object.freeze({
      enabled: false,
      port,
      passwordFile: "/nonexistent/desktop-password",
    });
    const probeRfb = vi.fn(rfbProbe.probeRfbServer);
    await expect(inspectHostDesktop({ config, probeRfb })).resolves.toMatchObject({
      status: { enabled: false, state: "disabled" },
    });
    expect(probeRfb).not.toHaveBeenCalled();
    const readFile = vi.spyOn(fs, "readFile");
    const inspection = await inspectHostDesktopSetup({ config, probeRfb, platform: "darwin" });
    if (state === "ready") {
      expect(inspection).toEqual({ state });
    } else {
      expect(inspection).toMatchObject({ state });
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(config.enabled).toBe(false);
  });

  it("discovers managed setup without starting it and preserves attached-server precedence", async () => {
    const createManaged = vi.spyOn(managedLinux, "createManagedLinuxDesktop");
    const probeRfb = vi
      .fn<typeof rfbProbe.probeRfbServer>()
      .mockResolvedValue({ kind: "unreachable" });
    const config = { enabled: false, managed: true };
    await expect(inspectHostDesktopSetup({ config, platform: "linux", probeRfb })).resolves.toEqual(
      {
        state: "managed",
      },
    );
    await expect(
      inspectHostDesktopSetup({ config: { ...config, port: 5901 }, platform: "linux", probeRfb }),
    ).resolves.toMatchObject({ state: "needs-server" });
    await expect(
      inspectHostDesktopSetup({ config, platform: "darwin", probeRfb }),
    ).resolves.toMatchObject({
      state: "unsupported",
    });
    probeRfb.mockResolvedValue({ kind: "rfb", securityTypes: [2] });
    await expect(inspectHostDesktopSetup({ config, platform: "linux", probeRfb })).resolves.toEqual(
      {
        state: "ready",
      },
    );
    expect(createManaged).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    server?: Parameters<typeof listenRfb>[0];
    error: string;
  }>([
    {
      name: "unauthenticated VNC",
      server: { securityTypes: [1] },
      error: "refusing unauthenticated VNC server on 127.0.0.1:$PORT",
    },
    { name: "VeNCrypt", server: { securityTypes: [19] }, error: "VeNCrypt is not supported" },
    {
      name: "a non-VNC occupant",
      server: { banner: "HTTP/1.1 200" },
      error:
        "desktop.host.port $PORT is occupied by a non-VNC service; configure desktop.host.port",
    },
    { name: "an unreachable server", error: "apt install tigervnc-standalone-server" },
  ])("refuses $name with setup guidance", async ({ server, error }) => {
    const port = server ? await listenRfb(server) : await unusedPort();
    const source = createHostDesktopSource({ config: { enabled: true, port }, platform: "linux" });
    await expect(source.acquire()).rejects.toThrow(error.replace("$PORT", String(port)));
  });

  it.each(["prompt", "password-file", "explicit-port", "default-port", "managed"] as const)(
    "selects the configured VncAuth source (%s)",
    async (mode) => {
      const withPassword = mode === "password-file";
      const managedMode = mode !== "prompt" && mode !== "password-file";
      const explicitPort = mode !== "default-port" && mode !== "managed";
      const port = explicitPort ? await listenRfb({ securityTypes: [2] }) : 5900;
      const password = "desktop-secret";
      let passwordFile: string | undefined;
      if (withPassword) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-desktop-"));
        passwordFile = path.join(root, "passwd");
        await fs.writeFile(passwordFile, `${password}\n`);
        cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
      }

      const managed = fakeManagedDesktop();
      const source = createHostDesktopSource({
        config: {
          enabled: true,
          ...(explicitPort ? { port } : {}),
          passwordFile,
          ...(managedMode ? { managed: true } : {}),
        },
        platform: "linux",
        ...(managedMode ? { managedDesktop: managed.managed } : {}),
        ...(!explicitPort
          ? {
              probeRfb: async (): Promise<rfbProbe.RfbProbeResult> =>
                mode === "managed" ? { kind: "unreachable" } : { kind: "rfb", securityTypes: [2] },
            }
          : {}),
      });
      if (mode === "managed") {
        await expect(source.acquire()).resolves.toMatchObject({
          attachment: { host: "127.0.0.1", port: 46_001 },
          auth: "vnc-password",
        });
        expect(managed.acquire).toHaveBeenCalledOnce();
        const onStop = vi.fn(async () => undefined);
        const computer = await source.acquireComputer({ onStop });
        expect(computer.env.DISPLAY).toBe(":99");
        expect(computer.isCurrent()).toBe(true);
        await source.teardown?.();
        expect(computer.isCurrent()).toBe(false);
        expect(onStop).toHaveBeenCalledOnce();
        return;
      }
      await expect(source.acquire()).resolves.toEqual({
        attachment: { kind: "tcp", host: "127.0.0.1", port },
        auth: "vnc-password",
        ...(withPassword ? { vncPassword: password } : {}),
      });
      if (withPassword) {
        expect(isSecretValueRegisteredForRedaction(password)).toBe(true);
      }
      if (managedMode) {
        expect(managed.acquire).not.toHaveBeenCalled();
        await expect(source.acquireComputer({ onStop: async () => undefined })).rejects.toThrow(
          "selected host desktop is an external VNC server",
        );
        expect(managed.acquireComputer).not.toHaveBeenCalled();
      }
    },
  );

  it("attaches ARD and keeps account credentials only in the observer token", async () => {
    const port = await listenRfb({ banner: "RFB 003.889\n", securityTypes: [30] });
    const source = createHostDesktopSource({
      config: { enabled: true, port },
      platform: "darwin",
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "ard-account",
    });

    const registry = createDesktopSessionRegistry();
    const service = createHostDesktopService({
      getConfig: () => ({ enabled: true, port }),
      platform: "darwin",
      registry,
    });
    cleanups.push(async () => registry.stopAll());
    await expect(service.observe({ control: false })).rejects.toThrow(
      "macOS account credentials are required",
    );
    const password = "mac-account-password";
    const observed = await service.observe({
      control: false,
      credentials: { username: "operator", password },
    });
    expect(observed).toMatchObject({ auth: "ard-account", control: false });
    expect(observed).not.toHaveProperty("vncPassword");
    expect(observed.wsPath).toMatch(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u);
    expect(observed.wsPath).not.toContain("operator");
    expect(observed.wsPath).not.toContain(password);
    expect(isSecretValueRegisteredForRedaction(password)).toBe(true);

    await expect(
      inspectHostDesktop({ config: { enabled: true, port }, platform: "darwin" }),
    ).resolves.toMatchObject({
      status: { state: "attached", security: "ARD" },
      detail: `attached (127.0.0.1:${port}, security: ARD)`,
    });
  });

  it.each(["available", "absent", "failed"] as const)(
    "projects authenticated managed audio without exposing private diagnostics (%s)",
    async (mode) => {
      vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "unreachable" });
      const managed = fakeManagedDesktop();
      const reason =
        mode === "failed" ? "native stderr /private/audio/path synthetic-secret" : undefined;
      const start = vi.fn(async () => {
        throw new Error("capture must wait for user input");
      });
      const acquire = managed.managed.acquire.bind(managed.managed);
      managed.managed.acquire = async () => ({
        ...(await acquire()),
        ...(mode === "available"
          ? { resolveAudio: () => ({ start }) }
          : { audioUnavailableReason: reason }),
      });
      const registry = createDesktopSessionRegistry();
      cleanups.push(() => registry.stopAll());
      const service = createHostDesktopService({
        getConfig: () => ({ enabled: true, managed: true }),
        registry,
        platform: "linux",
        managedDesktop: managed.managed,
      });
      const requester = { connId: "setup-diagnostic-viewer", isCurrent: () => true };
      const observed = await service.observe({ control: mode === "available", requester });
      if (mode === "available") {
        expect(observed.audio).toMatchObject({
          encoding: "pcm-s16le",
          sampleRate: 48000,
          channels: 2,
        });
        expect(observed.audio?.wsPath).toMatch(/^\/desktop\/audio\?token=/u);
        expect(observed.preauthenticated).toBe(true);
        expect(observed.vncPassword).toBeUndefined();
      } else {
        expect(observed.audio).toBeUndefined();
        expect(observed.audioUnavailableReason).toBe(reason ? "setup-unavailable" : undefined);
      }
      expect(JSON.stringify(observed)).not.toMatch(
        /native stderr|private\/audio|synthetic-secret/u,
      );
      expect(start).not.toHaveBeenCalled();
      expect(await releaseDesktopObserverToken(observed.wsPath, requester)).toBe(true);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("keeps computer activity alive after all eight observers detach, then expires after release", async () => {
    vi.useFakeTimers();
    vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "unreachable" });
    const managed = fakeManagedDesktop();
    const registry = createDesktopSessionRegistry({ lingerMs: 10 });
    const service = createHostDesktopService({
      getConfig: () => ({ enabled: true, managed: true }),
      platform: "linux",
      registry,
      managedDesktop: managed.managed,
    });
    cleanups.push(() => registry.stopAll());
    const computer = await service.acquireComputer({ onStop: async () => undefined });
    await service.observe({ control: false });
    const observers = Array.from({ length: 8 }, () =>
      registry.attachObserver("host", {
        control: false,
        ownerEpoch: 0,
        close: vi.fn(),
      }),
    );
    expect(observers.every(Boolean)).toBe(true);
    for (const observer of observers) {
      observer?.release();
    }
    await vi.advanceTimersByTimeAsync(20);
    expect(managed.stop).not.toHaveBeenCalled();
    expect(computer.isCurrent()).toBe(true);
    computer.release();
    await vi.advanceTimersByTimeAsync(20);
    expect(managed.stop).toHaveBeenCalled();
    expect(computer.isCurrent()).toBe(false);
  });

  it("enables, reconfigures, and re-enables host desktop without reviving old viewers or tickets", async () => {
    const firstPort = await listenRfb({ securityTypes: [2] });
    const secondPort = await listenRfb({ securityTypes: [2] });
    let config: DesktopHostConfig = { enabled: false, port: firstPort };
    const registry = createDesktopSessionRegistry();
    const service = createHostDesktopService({ getConfig: () => config, registry });
    const requester = { connId: "host-viewer", isCurrent: () => true };
    cleanups.push(() => registry.stopAll());
    await expect(service.status()).resolves.toEqual({
      enabled: false,
      state: "disabled",
      port: firstPort,
    });
    await expect(service.observe({ control: false })).rejects.toThrow("host desktop is disabled");

    config = { ...config, enabled: true };
    const first = await service.observe({ control: true, requester });
    const closeFirst = vi.fn();
    expect(
      registry.attachObserver("host", { control: true, ownerEpoch: 0, close: closeFirst }),
    ).toBeDefined();

    config = { ...config, port: secondPort };
    await service.reconcileRuntimePolicy();
    expect(closeFirst).toHaveBeenCalledOnce();
    await expect(releaseDesktopObserverToken(first.wsPath, requester)).resolves.toBe(false);
    const second = await service.observe({ control: false, requester });
    await expect(service.status()).resolves.toMatchObject({ state: "attached", port: secondPort });
    const closeSecond = vi.fn();
    expect(
      registry.attachObserver("host", { control: false, ownerEpoch: 1, close: closeSecond }),
    ).toBeDefined();

    config = { ...config, enabled: false };
    await service.reconcileRuntimePolicy();
    expect(closeSecond).toHaveBeenCalledOnce();
    await expect(service.acquireComputer({ onStop: async () => undefined })).rejects.toThrow(
      "host desktop is disabled",
    );

    config = { ...config, enabled: true };
    const third = await service.observe({ control: false, requester });
    expect(third.auth).toBe("vnc-password");
    await expect(releaseDesktopObserverToken(second.wsPath, requester)).resolves.toBe(false);
    expect(
      registry.attachObserver("host", { control: true, ownerEpoch: 1, close: vi.fn() }),
    ).toBeUndefined();
    await expect(releaseDesktopObserverToken(third.wsPath, requester)).resolves.toBe(true);
  });

  it.each(["disable", "reconfigure"])("retires managed computer holds on %s", async (change) => {
    vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "unreachable" });
    const managed = fakeManagedDesktop();
    let config: DesktopHostConfig = { enabled: true, managed: true };
    const registry = createDesktopSessionRegistry();
    const service = createHostDesktopService({
      getConfig: () => config,
      registry,
      platform: "linux",
      managedDesktop: managed.managed,
    });
    cleanups.push(() => registry.stopAll());
    const onStop = vi.fn(async () => undefined);
    const computer = await service.acquireComputer({ onStop });
    expect(computer.isCurrent()).toBe(true);

    config = change === "disable" ? { ...config, enabled: false } : { ...config, port: 46_002 };
    expect(computer.isCurrent()).toBe(false);
    await service.reconcileRuntimePolicy();
    expect(onStop).toHaveBeenCalledOnce();
    expect(managed.stop).toHaveBeenCalled();
    expect(registry.hasActivity("host", 0)).toBe(false);
  });

  it.each(["probe", "startup"] as const)(
    "joins disable during managed desktop %s without leaving a live desktop",
    async (boundary) => {
      const entered = createDeferred();
      const admission = createDeferred();
      vi.spyOn(rfbProbe, "probeRfbServer").mockImplementation(async () => {
        if (boundary === "probe") {
          entered.resolve();
          await admission.promise;
        }
        return { kind: "unreachable" };
      });
      const managed = fakeManagedDesktop();
      let liveDesktop = false;
      if (boundary === "startup") {
        managed.acquire.mockImplementation(async () => {
          entered.resolve();
          await admission.promise;
          liveDesktop = true;
          return {
            attachment: { kind: "tcp", host: "127.0.0.1", port: 46_001 },
            auth: "vnc-password",
            vncPassword: "managed-secret",
          };
        });
        managed.stop.mockImplementation(async () => {
          liveDesktop = false;
        });
      }
      let config: DesktopHostConfig = { enabled: true, managed: true };
      const registry = createDesktopSessionRegistry();
      const service = createHostDesktopService({
        getConfig: () => config,
        registry,
        platform: "linux",
        managedDesktop: managed.managed,
      });
      cleanups.push(() => registry.stopAll());
      const observed = expect(service.observe({ control: false })).rejects.toThrow(
        "Desktop session stopped before connecting",
      );
      await entered.promise;
      config = { ...config, enabled: false };
      const reconciled = service.reconcileRuntimePolicy();
      admission.resolve();
      await Promise.all([observed, reconciled]);
      if (boundary === "probe") {
        expect(managed.acquire).not.toHaveBeenCalled();
        await expect(service.status()).resolves.toMatchObject({ state: "disabled" });
      }
      expect(liveDesktop).toBe(false);
    },
  );

  it("reports managed mode as Linux-only on other platforms", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "darwin",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "unreachable" }),
    });
    await expect(source.acquire()).rejects.toThrow(
      "desktop.host.managed is available only on Linux",
    );
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "darwin",
        managedDesktop: managed.managed,
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toMatchObject({
      status: { state: "unavailable" },
      detail: expect.stringContaining("available only on Linux"),
    });
  });

  it.each([false, true])(
    "reports only known managed lifecycle state (runtime=%s)",
    async (running) => {
      const managed = running
        ? fakeManagedDesktop({ state: "running", display: 99, port: 46_001 })
        : undefined;
      await expect(
        inspectHostDesktop({
          config: { enabled: true, managed: true },
          platform: "linux",
          managedDesktop: managed?.managed,
          probeRfb: async () => ({ kind: "unreachable" }),
        }),
      ).resolves.toEqual({
        status: {
          enabled: true,
          state: "managed",
          managedState: running ? "running" : "unknown",
          port: running ? 46_001 : 5900,
          ...(running ? { display: 99, security: "VncAuth" } : {}),
        },
        detail: running
          ? "managed (running, display :99, port 46001, security: VncAuth)"
          : "managed (configured; runtime state is available from the running Gateway status)",
      });
    },
  );
});

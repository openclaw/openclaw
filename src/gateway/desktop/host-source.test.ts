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
  it.each([
    { name: "VncAuth", banner: "RFB 003.008\n", securityTypes: [2] },
    { name: "Screen Sharing", banner: "RFB 003.889\n", securityTypes: [30] },
  ])("discovers $name for setup while desktop access stays disabled", async (server) => {
    const port = await listenRfb(server);
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
    await expect(inspectHostDesktopSetup({ config, probeRfb })).resolves.toEqual({
      state: "ready",
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(config.enabled).toBe(false);
  });

  it.each([
    { name: "unauthenticated VNC", securityTypes: [1] },
    { name: "VeNCrypt", securityTypes: [19] },
    { name: "another service", banner: "HTTP/1.1 200" },
  ])("does not offer $name as a ready desktop", async (server) => {
    const port = await listenRfb(server);
    await expect(
      inspectHostDesktopSetup({ config: { enabled: false, port } }),
    ).resolves.toMatchObject({
      state: "unsupported",
    });
  });

  it("reports a missing server without changing the disabled desktop setting", async () => {
    const port = await unusedPort();
    await expect(
      inspectHostDesktopSetup({ config: { enabled: false, port }, platform: "darwin" }),
    ).resolves.toMatchObject({ state: "needs-server" });
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

  it("refuses an unauthenticated VNC server", async () => {
    const port = await listenRfb({ securityTypes: [1] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow(
      `refusing unauthenticated VNC server on 127.0.0.1:${port}`,
    );
  });

  it("returns a loopback attachment and redacted password-file value for VncAuth", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-desktop-"));
    const passwordFile = path.join(root, "passwd");
    const password = "desktop-secret";
    await fs.writeFile(passwordFile, `${password}\n`);
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));

    const source = createHostDesktopSource({
      config: { enabled: true, port, passwordFile },
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
      vncPassword: password,
    });
    expect(isSecretValueRegisteredForRedaction(password)).toBe(true);
  });

  it("keeps the VncAuth credential prompt path when passwordFile is omitted", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
    });
  });

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

  it("still refuses VeNCrypt", async () => {
    const port = await listenRfb({ securityTypes: [19] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow("VeNCrypt is not supported");
  });

  it("reports a non-VNC occupant and the port config next step", async () => {
    const port = await listenRfb({ banner: "HTTP/1.1 200" });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow(
      `desktop.host.port ${port} is occupied by a non-VNC service; configure desktop.host.port`,
    );
  });

  it("reports unreachable Linux setup guidance", async () => {
    const port = await unusedPort();
    const source = createHostDesktopSource({
      config: { enabled: true, port },
      platform: "linux",
    });
    await expect(source.acquire()).rejects.toThrow("apt install tigervnc-standalone-server");
  });

  it("keeps an explicitly configured port ahead of managed mode", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true, port },
      platform: "linux",
      managedDesktop: managed.managed,
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
    });
    expect(managed.acquire).not.toHaveBeenCalled();
    await expect(source.acquireComputer({ onStop: async () => undefined })).rejects.toThrow(
      "selected host desktop is an external VNC server",
    );
    expect(managed.acquireComputer).not.toHaveBeenCalled();
  });

  it("keeps a default-port RFB listener ahead of managed mode", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "linux",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "rfb", securityTypes: [2] }),
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port: 5900 },
      auth: "vnc-password",
    });
    expect(managed.acquire).not.toHaveBeenCalled();
    await expect(source.acquireComputer({ onStop: async () => undefined })).rejects.toThrow(
      "selected host desktop is an external VNC server",
    );
    expect(managed.acquireComputer).not.toHaveBeenCalled();
  });

  it("starts managed mode only on Linux after the default port is unreachable", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "linux",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "unreachable" }),
    });
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
  });

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

  it("does not start a managed desktop after disable while probing the host", async () => {
    const probing = createDeferred();
    const probe = createDeferred<rfbProbe.RfbProbeResult>();
    vi.spyOn(rfbProbe, "probeRfbServer").mockImplementation(async () => {
      probing.resolve();
      return await probe.promise;
    });
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
    const observed = expect(service.observe({ control: false })).rejects.toThrow(
      "Desktop session stopped before connecting",
    );
    await probing.promise;
    config = { ...config, enabled: false };
    const reconciled = service.reconcileRuntimePolicy();
    probe.resolve({ kind: "unreachable" });
    await Promise.all([observed, reconciled]);
    expect(managed.acquire).not.toHaveBeenCalled();
    await expect(service.status()).resolves.toMatchObject({ state: "disabled" });
  });

  it("joins managed startup before completing a disable and leaves no live desktop", async () => {
    vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({ kind: "unreachable" });
    const starting = createDeferred();
    const started = createDeferred();
    let liveDesktop = false;
    const managed = fakeManagedDesktop();
    managed.acquire.mockImplementation(async () => {
      starting.resolve();
      await started.promise;
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
    await starting.promise;
    config = { ...config, enabled: false };
    const reconciled = service.reconcileRuntimePolicy();
    started.resolve();
    await Promise.all([observed, reconciled]);
    expect(liveDesktop).toBe(false);
  });

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

  it("reports managed lifecycle states without exposing password material", async () => {
    const managed = fakeManagedDesktop({ state: "running", display: 99, port: 46_001 });
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "linux",
        managedDesktop: managed.managed,
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toEqual({
      status: {
        enabled: true,
        state: "managed",
        managedState: "running",
        display: 99,
        port: 46_001,
        security: "VncAuth",
      },
      detail: "managed (running, display :99, port 46001, security: VncAuth)",
    });
  });

  it("does not infer process-local managed state from standalone inspection", async () => {
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "linux",
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toEqual({
      status: {
        enabled: true,
        state: "managed",
        managedState: "unknown",
        port: 5900,
      },
      detail: "managed (configured; runtime state is available from the running Gateway status)",
    });
  });
});

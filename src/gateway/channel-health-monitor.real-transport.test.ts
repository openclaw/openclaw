import { createServer, Socket, type Server } from "node:net";
// Real-transport proof for the busy-account reconnect grace.
// The production monitor drives a fixture channel manager whose transport is a
// real TCP connection to a loopback server. No fake timers anywhere: reconnects,
// run heartbeats, and monitor ticks all run on the real clock, so the test
// observes the same recovery sequence a live channel goes through.
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot, ChannelId } from "../channels/plugins/types.public.js";
import { startChannelHealthMonitor, type ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
import type { ChannelManager } from "./server-channels.js";

const CHANNEL_ID = "discord" as ChannelId;
const ACCOUNT_ID = "default";
const RUN_HEARTBEAT_INTERVAL_MS = 150;
const RUN_DURATION_MS = 900;
const RECONNECT_DELAY_MS = 250;
const CHECK_INTERVAL_MS = 100;
const MONITOR_STARTUP_GRACE_MS = 50;

type LoopbackServer = {
  port: number;
  destroyClients: () => void;
  close: () => Promise<void>;
};

async function startLoopbackServer(): Promise<LoopbackServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not report a TCP port");
  }
  return {
    port: address.port,
    destroyClients: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

type RunRecord = {
  id: number;
  startedAt: number;
  outcome: "open" | "completed" | "aborted";
};

type TransportEvent = { at: number; what: string };

/**
 * A fixture adapter for the platform boundary: the transport itself is a real
 * TCP socket, run work is a real interval-driven task, and a monitor restart
 * really closes the socket and aborts the run. Nothing here is a vi.fn spy.
 */
class RealTransportChannelManager implements ChannelManager {
  readonly events: TransportEvent[] = [];
  readonly monitorRestarts: string[] = [];
  readonly runs: RunRecord[] = [];
  readonly snapshot: ChannelAccountSnapshot = {
    accountId: ACCOUNT_ID,
    enabled: true,
    configured: true,
    running: false,
    connected: false,
  };
  private socket: Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAllowed = true;
  private closed = false;
  private nextRunId = 1;

  constructor(private readonly server: LoopbackServer) {}

  record(what: string) {
    this.events.push({ at: Date.now(), what });
  }

  /** Initial test setup: the same start the production manager performs. */
  async initialStart(): Promise<void> {
    await this.doStart();
  }

  private async doStart(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.reconnectAllowed = true;
    this.snapshot.running = true;
    this.snapshot.activeRuns = (this.snapshot.activeRuns ?? 0) + 1;
    const run: RunRecord = { id: this.nextRunId++, startedAt: Date.now(), outcome: "open" };
    this.runs.push(run);
    this.startHeartbeat(run);
    this.record(`start (run ${run.id})`);
    this.connect();
  }

  /** A monitor restart owns this path: it aborts the active run. */
  async stopChannel(): Promise<void> {
    this.record("stop");
    this.monitorRestarts.push("stop");
    this.reconnectAllowed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.snapshot.connected = false;
    this.snapshot.running = false;
    const openRun = this.runs.find((run) => run.outcome === "open");
    if (openRun) {
      openRun.outcome = "aborted";
      this.snapshot.activeRuns = 0;
      this.stopHeartbeat();
    }
  }

  private startHeartbeat(run: RunRecord) {
    this.snapshot.activeRunStartedAt = this.snapshot.activeRunStartedAt ?? Date.now();
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (run.outcome !== "open") {
        this.stopHeartbeat();
        return;
      }
      this.snapshot.lastRunActivityAt = Date.now();
      if (Date.now() - run.startedAt >= RUN_DURATION_MS) {
        run.outcome = "completed";
        this.snapshot.activeRuns = 0;
        this.stopHeartbeat();
        this.record(`run ${run.id} completed`);
      }
    }, RUN_HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private connect() {
    if (this.closed || this.socket) {
      return;
    }
    const socket = new Socket();
    this.socket = socket;
    socket.connect(this.server.port, "127.0.0.1");
    socket.on("connect", () => {
      this.snapshot.connected = true;
      this.snapshot.lastConnectedAt = Date.now();
      this.record("transport connected");
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.closed) {
        return;
      }
      if (this.snapshot.connected) {
        this.snapshot.connected = false;
        this.snapshot.lastDisconnect = {
          at: Date.now(),
          error: "transport socket closed",
        };
        this.record("transport disconnected");
      }
      if (this.reconnectAllowed && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, RECONNECT_DELAY_MS);
        if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) {
          this.reconnectTimer.unref();
        }
      }
    });
  }

  /** Present the live snapshot through the production manager surface. */
  getRuntimeSnapshot(): ChannelRuntimeSnapshot {
    const account = { ...this.snapshot };
    return {
      channels: { [CHANNEL_ID]: account } as ChannelRuntimeSnapshot["channels"],
      channelAccounts: {
        [CHANNEL_ID]: { [ACCOUNT_ID]: account },
      } as ChannelRuntimeSnapshot["channelAccounts"],
    };
  }

  dispose() {
    this.closed = true;
    this.reconnectAllowed = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  // Remaining ChannelManager surface is inert for this single-account fixture.
  pauseChannelStarts() {
    return () => {};
  }
  async startChannels() {}
  async startChannel(): Promise<ReadonlyMap<string, never>> {
    this.monitorRestarts.push("start");
    await this.doStart();
    return new Map<string, never>();
  }
  releaseChannelRouteHandoffs() {}
  setAutostartSuppression() {}
  getAutostartSuppression() {
    return null;
  }
  async recoverAutostartSuppression() {
    return false;
  }
  setAmbientAutostartSuppressedChannelIds() {}
  isAmbientAutostartSuppressed() {
    return false;
  }
  markChannelLoggedOut() {}
  isManuallyStopped() {
    return false;
  }
  isAccountListed() {
    return true;
  }
  isAutoRestartScheduled() {
    return false;
  }
  resetRestartAttempts() {}
  isHealthMonitorEnabled() {
    return true;
  }
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

let server: LoopbackServer | null = null;
let manager: RealTransportChannelManager | null = null;
let monitor: ChannelHealthMonitor | null = null;

afterEach(async () => {
  monitor?.stop();
  manager?.dispose();
  await server?.close();
  server = null;
  manager = null;
  monitor = null;
});

describe("channel health monitor against a real transport", () => {
  it("keeps a long busy run alive across a real disconnect and lets the transport recover", async () => {
    const activeServer = await startLoopbackServer();
    server = activeServer;
    const activeManager = new RealTransportChannelManager(activeServer);
    manager = activeManager;

    // A lifecycle that has been up 30 minutes with a 26-minute-old run still
    // producing fresh heartbeat activity -- the reported incident shape.
    activeManager.snapshot.lastStartAt = Date.now() - 30 * 60_000;
    activeManager.snapshot.activeRunStartedAt = Date.now() - 26 * 60_000;
    await activeManager.initialStart();

    monitor = startChannelHealthMonitor({
      channelManager: activeManager,
      checkIntervalMs: CHECK_INTERVAL_MS,
      timing: { monitorStartupGraceMs: MONITOR_STARTUP_GRACE_MS },
    });

    // Wait for the real socket to connect and the run to start beating.
    await waitFor("initial transport connection", () => activeManager.snapshot.connected === true);

    // The transport really drops; the fixture's own reconnect logic races the
    // monitor's reconnect-grace window instead of a restart.
    activeServer.destroyClients();
    await waitFor("transport disconnect", () => activeManager.snapshot.connected === false);
    await waitFor("transport recovery", () => activeManager.snapshot.connected === true);
    await waitFor("run completion", () => activeManager.runs[0]?.outcome === "completed");

    expect(activeManager.monitorRestarts).toEqual([]);
    expect(activeManager.runs[0]?.outcome).toBe("completed");
    expect(activeManager.snapshot.connected).toBe(true);
    expect(activeManager.events.some((event) => event.what === "transport disconnected")).toBe(
      true,
    );
    expect(
      activeManager.events.filter((event) => event.what === "transport connected").length,
    ).toBe(2);
  });
});

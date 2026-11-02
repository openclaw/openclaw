import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTunnelSupervisor,
  type TunnelSupervisor,
  type TunnelSupervisorStatus,
} from "./tunnel-supervisor.js";

const fixture = new URL("./tunnel-supervisor.fixture.mjs", import.meta.url);
const fast = {
  backoffInitialMs: 40,
  backoffMaxMs: 160,
  healthyResetMs: 60_000,
  crashLoopAfter: 3,
  readyTimeoutMs: 5_000,
  pingIntervalMs: 50,
  pingTimeoutMs: 300,
  shutdownGraceMs: 300,
};

let supervisors: TunnelSupervisor[] = [];
let markerDir: string | undefined;

afterEach(async () => {
  await Promise.all(supervisors.map((supervisor) => supervisor.stop()));
  supervisors = [];
  if (markerDir) {
    fs.rmSync(markerDir, { recursive: true, force: true });
    markerDir = undefined;
  }
});

function setup(
  mode: string,
  opts: { entry?: URL; maxRssBytes?: number; unavailableRetryMs?: number } = {},
) {
  markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-id-supervisor-"));
  const statuses: TunnelSupervisorStatus[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const onReady = vi.fn();
  const supervisor = createTunnelSupervisor({
    launch: { entry: opts.entry ?? fixture, execArgv: [] },
    startMessage: () => ({
      type: "start",
      relayUrl: "https://relay.example.test/",
      keyPath: path.join(markerDir!, "endpoint.key"),
      ingress: { socketPath: path.join(markerDir!, "ingress.sock"), proxyToken: "t".repeat(43) },
      forwardedProto: "https",
    }),
    log,
    env: {
      ...process.env,
      FAKE_TUNNEL_MODE: mode,
      FAKE_TUNNEL_MARKER: markerDir,
      FAKE_TUNNEL_AVAILABLE: path.join(markerDir, "available"),
    },
    tuning: {
      ...fast,
      ...(opts.maxRssBytes ? { maxRssBytes: opts.maxRssBytes } : {}),
      ...(opts.unavailableRetryMs ? { unavailableRetryMs: opts.unavailableRetryMs } : {}),
    },
    onReady,
    onStatus: (status) => statuses.push(status),
  });
  supervisors.push(supervisor);
  const starts = () =>
    fs.readdirSync(markerDir!).filter((name) => name.startsWith("start-")).length;
  return { supervisor, statuses, log, onReady, starts };
}

describe("tunnel child supervisor", () => {
  it("starts the child, takes its ready descriptor and reports it running", async () => {
    const { supervisor, onReady, log } = setup("ok");
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.status().state).toBe("running"));
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ endpointKey: `iroh:${"ab".repeat(32)}`, keyCreated: true }),
    );
    await vi.waitFor(() =>
      expect(supervisor.status()).toMatchObject({
        relayOnline: true,
        relayDenied: null,
        connections: 2,
      }),
    );
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        "tunnel: fake child up relay=https://relay.example.test/",
      ),
    );
  });

  it("reports a relay admission denial as its own status", async () => {
    const { supervisor } = setup("denied");
    supervisor.start();
    await vi.waitFor(() =>
      expect(supervisor.status()).toMatchObject({
        state: "running",
        relayOnline: false,
        relayDenied: "not authorized",
      }),
    );
  });

  it("runs the child at a lower CPU priority than the Gateway", async () => {
    const { supervisor } = setup("ok");
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.status().state).toBe("running"));
    const pid = Number(fs.readdirSync(markerDir!)[0]!.slice("start-".length));
    if (process.platform !== "win32") {
      expect(os.getPriority(pid)).toBeGreaterThan(os.getPriority());
    }
  });

  it("delivers membership pushed before start once the child is ready", async () => {
    const { supervisor, log } = setup("ok");
    supervisor.pushMembership(3, [`iroh:${"cd".repeat(32)}`]);
    supervisor.start();
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith("tunnel: membership seq=3 admitted=1"),
    );
  });

  it("restarts a crashing child with growing backoff and reports crash looping", async () => {
    const { supervisor, statuses, starts } = setup("crash");
    supervisor.start();
    // A child start marker precedes its exit; wait for the supervisor's completed backoff.
    await vi.waitFor(
      () =>
        expect(
          statuses.filter((status) => status.state === "backoff").length,
        ).toBeGreaterThanOrEqual(4),
      { timeout: 5_000 },
    );
    expect(starts()).toBeGreaterThanOrEqual(4);
    const delays = statuses.flatMap((status) =>
      status.state === "backoff" ? [status.retryInMs] : [],
    );
    expect(delays.slice(0, 4)).toEqual([40, 80, 160, 160]);
    expect(statuses.some((status) => status.state === "backoff" && status.crashLooping)).toBe(true);
  });

  it("kills a child that stops answering health pings and starts a new one", async () => {
    const { supervisor, starts, log } = setup("hang");
    supervisor.start();
    await vi.waitFor(() => expect(starts()).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    expect(log.warn).toHaveBeenCalledWith(
      "openclaw-id: tunnel child stopped answering health pings; killing it",
    );
  });

  it("restarts the child gracefully when its RSS exceeds the limit", async () => {
    const { supervisor, starts, statuses } = setup("rss", { maxRssBytes: 1024 * 1024 * 1024 });
    supervisor.start();
    await vi.waitFor(() => expect(starts()).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    // A recycle is planned: it restarts at once and never counts as a crash.
    expect(statuses.find((status) => status.state === "backoff")).toMatchObject({
      retryInMs: 0,
      crashLooping: false,
    });
  });

  it("reports the transport unavailable and does not crash-restart", async () => {
    const { supervisor, starts } = setup("unavailable");
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.status().state).toBe("unavailable"));
    expect(supervisor.status()).toMatchObject({ retryInMs: 60_000 });
    await sleep(200);
    expect(starts()).toBe(1);
  });

  it("recovers to running once the binding becomes available again", async () => {
    const { supervisor, starts } = setup("unavailable-until", { unavailableRetryMs: 100 });
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.status().state).toBe("unavailable"));
    // Observe the second probe's result, not just its process-start marker.
    await vi.waitFor(
      () => {
        expect(starts()).toBeGreaterThanOrEqual(2);
        expect(supervisor.status().state).toBe("unavailable");
      },
      { timeout: 5_000 },
    );
    fs.writeFileSync(path.join(markerDir!, "available"), "");
    await vi.waitFor(() => expect(supervisor.status().state).toBe("running"), { timeout: 5_000 });
  });

  it("stops probing an unavailable transport once stopped", async () => {
    const { supervisor, starts } = setup("unavailable", { unavailableRetryMs: 50 });
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.status().state).toBe("unavailable"));
    await supervisor.stop();
    const after = starts();
    await sleep(200);
    expect(starts()).toBe(after);
    expect(supervisor.status()).toEqual({ state: "stopped" });
  });

  it("reports unavailable when the child entry is missing", () => {
    const { supervisor, starts } = setup("ok", {
      entry: new URL("./missing-tunnel-child.mjs", import.meta.url),
    });
    supervisor.start();
    expect(supervisor.status()).toEqual({
      state: "unavailable",
      reason: "tunnel child entry is missing from this install",
    });
    expect(starts()).toBe(0);
  });

  it("stops with SIGTERM and falls back to SIGKILL after the grace period", async () => {
    const { supervisor, starts } = setup("ignore-sigterm");
    supervisor.start();
    await vi.waitFor(() => expect(supervisor.status().state).toBe("running"));
    const startedAt = Date.now();
    await supervisor.stop();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(fast.shutdownGraceMs - 20);
    expect(supervisor.status()).toEqual({ state: "stopped" });
    await sleep(150);
    expect(starts()).toBe(1);
  });
});

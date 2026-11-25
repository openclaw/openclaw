import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  runReleaseUserJourneyAssertion,
  waitForClickClackSocket,
} from "../../scripts/e2e/lib/release-user-journey/assertions.mjs";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile as writeJson } from "../helpers/temp-repo.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/release-user-journey/assertions.mjs";
const CLICKCLACK_FIXTURE_SCRIPT = "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs";
const CLICKCLACK_PLUGIN_WRITER_SCRIPT =
  "scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();

function fixture() {
  const root = tempDirs.make("openclaw-release-user-assertions-");
  return { root, home: path.join(root, "home") };
}

function assertChannel(command: string, status: unknown) {
  const statusPath = path.join(fixture().root, "status.json");
  writeJson(statusPath, status);
  return runReleaseUserJourneyAssertion(command, ["clickclack", statusPath]);
}

function runAssertion(home: string, args: string[]) {
  const current = process.env.NODE_OPTIONS ?? "";
  const nodeOptions = current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
  return spawnSync(testNodeExecPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: nodeOptions,
    },
    killSignal: "SIGKILL",
  });
}

async function waitUntil(matches: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (await matches()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openClickClackSocket(port: number, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime/ws`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await once(socket, "open");
  return socket;
}

async function closeClickClackSocket(socket: WebSocket): Promise<void> {
  socket.terminate();
  await once(socket, "close");
}

async function startTcpFixtureServer(handler: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const servers = new Set<Awaited<ReturnType<typeof startTcpFixtureServer>>>();
afterEach(async () => {
  for (const server of servers) {
    await server.stop();
  }
  servers.clear();
});

async function httpFixture(handler: (socket: Socket) => void, timeoutMs = 1000, maxBytes?: number) {
  const server = await startTcpFixtureServer(handler);
  servers.add(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const run = <T>(action: () => Promise<T>) =>
    withEnvAsync(
      {
        HOME: fixture().home,
        OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS: String(timeoutMs),
        ...(maxBytes === undefined
          ? {}
          : { OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES: String(maxBytes) }),
      },
      action,
    );
  return {
    baseUrl,
    post: () =>
      run(() => runReleaseUserJourneyAssertion("post-clickclack-inbound", [baseUrl, "hello"])),
    wait: () => run(() => waitForClickClackSocket({ baseUrl, pollIntervalMs: 20, timeoutMs: 150 })),
  };
}

describe("release user journey assertions", () => {
  it("uses each file and needle and restores argv after successful and failed dispatch", async () => {
    const { root } = fixture();
    const fileA = path.join(root, "a.log");
    const fileB = path.join(root, "b.log");
    writeFileSync(fileA, "first marker\n", "utf8");
    writeFileSync(fileB, `OLD_OUTPUT${"x".repeat(70 * 1024)}\nsecond marker\n`, "utf8");
    const previousArgv = process.argv;
    const previousArgs = [...previousArgv];

    try {
      for (const [file, needle, shouldReject] of [
        [fileA, "first marker", false],
        [fileB, "second marker", false],
        [fileB, "first marker", true],
        [fileA, "first marker", false],
      ] as const) {
        const assertion = runReleaseUserJourneyAssertion("assert-file-contains", [file, needle]);
        if (shouldReject) {
          await expect(assertion).rejects.toThrow(
            `${file} did not contain ${needle}. Output tail: `,
          );
          await expect(assertion).rejects.toThrow("second marker");
          await expect(assertion).rejects.not.toThrow("OLD_OUTPUT");
        } else {
          await expect(assertion).resolves.toBeUndefined();
        }
        expect(process.argv).toBe(previousArgv);
        expect(process.argv).toEqual(previousArgs);
      }
    } finally {
      process.argv = previousArgv;
      previousArgv.splice(0, previousArgv.length, ...previousArgs);
    }
  });

  it("bounds oversized JSON artifact diagnostics", () => {
    const { home } = fixture();
    const file = path.join(home, ".openclaw/openclaw.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `DO_NOT_DUMP_OLD_JSON${"x".repeat(2 * 1024 * 1024)}\nrecent json tail`);
    const result = runAssertion(home, ["configure-mock-model", "18080"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeLessThan(80 * 1024);
    expect(result.stderr).toContain("JSON artifact exceeded");
    expect(result.stderr).toContain("recent json tail");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_JSON");
  });

  it("accepts a configured channel before Gateway startup", async () => {
    await expect(
      assertChannel("assert-channel-configured", { configuredChannels: ["clickclack"] }),
    ).resolves.toBeUndefined();
  });

  it.each([false, true])(
    "requires a running default account after restart: %s",
    async (running) => {
      const assertion = assertChannel("assert-channel-running", {
        configuredChannels: ["clickclack"],
        channels: { clickclack: { ok: true, label: "configured" } },
        channelAccounts: { clickclack: [{ accountId: "default", running }] },
      });
      if (running) {
        await expect(assertion).resolves.toBeUndefined();
      } else {
        await expect(assertion).rejects.toThrow("clickclack is not running");
      }
    },
  );

  it("fails when uninstall leaves the managed plugin directory behind", () => {
    const { root, home } = fixture();
    const pluginId = "journey-plugin-a";
    const installPath = path.join(home, ".openclaw", "extensions", pluginId);
    const installPathFile = path.join(root, "install-path.txt");

    writeJson(path.join(home, ".openclaw", "openclaw.json"), {
      plugins: { entries: { [pluginId]: { enabled: false } }, allow: [], deny: [] },
    });
    writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), { installRecords: {} });
    mkdirSync(installPath, { recursive: true });
    writeFileSync(installPathFile, installPath, "utf8");

    const result = runAssertion(home, ["assert-plugin-uninstalled", pluginId, installPathFile]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("managed plugin directory still present");
  });

  it("waits for a new ClickClack websocket generation across reconnect", async () => {
    const statePath = path.join(fixture().root, "clickclack.json");
    const reservation = await startTcpFixtureServer(() => {});
    const { port } = reservation;
    await reservation.stop();
    const token = "clickclack-test-token";
    const child = spawn(testNodeExecPath, [CLICKCLACK_FIXTURE_SCRIPT], {
      env: {
        ...process.env,
        CLICKCLACK_FIXTURE_PORT: String(port),
        CLICKCLACK_FIXTURE_STATE: statePath,
        CLICKCLACK_FIXTURE_TOKEN: token,
      },
      stdio: "ignore",
    });
    let socket: WebSocket | undefined;
    const baseUrl = `http://127.0.0.1:${port}`;
    const state = async () => (await fetch(`${baseUrl}/fixture/state`)).json();
    const waitOptions = { baseUrl, pollIntervalMs: 20, timeoutMs: 1000 };

    try {
      await waitUntil(
        async () =>
          fetch(`${baseUrl}/health`)
            .then((response) => response.ok)
            .catch(() => false),
        "ClickClack fixture startup",
      );

      socket = await openClickClackSocket(port, token);
      await waitForClickClackSocket(waitOptions);
      await closeClickClackSocket(socket);
      socket = undefined;
      await waitUntil(async () => {
        const current = await state();
        return current.socketCount === 0 && current.socketGeneration === 1;
      }, "first ClickClack socket close");

      const reconnected = waitForClickClackSocket({ ...waitOptions, minimumSocketGeneration: 2 });
      socket = await openClickClackSocket(port, token);
      await expect(reconnected).resolves.toBeUndefined();
      expect(await state()).toMatchObject({ socketCount: 1, socketGeneration: 2 });
      const pong = once(socket, "pong");
      socket.ping();
      await pong;
    } finally {
      if (socket) {
        await closeClickClackSocket(socket);
      }
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }
  });

  it("preserves runtime state in generated ClickClack status snapshots", async () => {
    const account = { accountId: "default", enabled: true, configured: true };
    const runtime = { running: true, lastStartAt: 123, lastStopAt: 45, lastError: "error" };
    type SnapshotInput = { account: typeof account; runtime?: Partial<typeof runtime> };
    type Snapshot = (params: SnapshotInput) => Record<string, unknown>;
    type Registration = { plugin: { status: { buildAccountSnapshot: Snapshot } } };
    type Api = { registerChannel: (registration: Registration) => void };

    const pluginDir = path.join(tempDirs.make("openclaw-release-clickclack-plugin-"), "plugin");
    const writer = spawnSync(testNodeExecPath, [CLICKCLACK_PLUGIN_WRITER_SCRIPT, pluginDir], {
      encoding: "utf8",
    });
    expect(writer.status, writer.stderr).toBe(0);

    const generatedModule = (await import(
      pathToFileURL(path.join(pluginDir, "index.mjs")).href
    )) as { default: { register: (api: Api) => void } };
    let plugin: Registration["plugin"] | undefined;
    generatedModule.default.register({
      registerChannel: (registration) => {
        plugin = registration.plugin;
      },
    });
    if (!plugin) {
      throw new Error("generated ClickClack plugin did not register its channel");
    }

    expect(plugin.status.buildAccountSnapshot({ account, runtime })).toMatchObject({
      accountId: "default",
      configured: true,
      enabled: true,
      running: true,
      lastStartAt: 123,
      lastStopAt: 45,
      lastError: "error",
    });
  });

  it("cancels successful ClickClack inbound response bodies", async () => {
    let socketClosed = false;
    const server = await httpFixture((socket) => {
      socket.on("close", () => {
        socketClosed = true;
      });
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nleft-open");
      });
    });
    await expect(server.post()).resolves.toBeUndefined();
    await waitUntil(() => socketClosed, "ClickClack inbound socket close");
  });

  it("bounds stalled ClickClack fixture HTTP probes", async () => {
    const server = await httpFixture((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
    }, 100);
    const startedAt = Date.now();
    await expect(server.wait()).rejects.toThrow(
      "Timed out waiting for ClickClack websocket generation 1",
    );
    expect(Date.now() - startedAt).toBeLessThan(750);
  });

  it.each([
    ["socket", "1e3", "websocket"],
    ["reply", "30s", "reply"],
  ])("rejects loose ClickClack %s timeout %s", async (kind, timeout, label) => {
    const { root, home } = fixture();
    const statePath = path.join(root, "state.json");

    const args =
      kind === "socket" ? ["http://127.0.0.1:9", timeout] : [statePath, "OPENCLAW_E2E_OK", timeout];
    await expect(
      withEnvAsync({ HOME: home }, () =>
        runReleaseUserJourneyAssertion(`wait-clickclack-${kind}`, args),
      ),
    ).rejects.toThrow(
      `ClickClack ${label} timeout seconds must be a positive integer. Got: "${timeout}"`,
    );
  });

  it("bounds ClickClack fixture error response bodies", async () => {
    const server = await httpFixture(
      (socket) => {
        const body = "x".repeat(128);
        socket.end(
          `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      },
      1000,
      16,
    );
    await expect(server.post()).rejects.toThrow(
      "ClickClack inbound response body exceeded 16 bytes",
    );
  });

  it("keeps the ClickClack HTTP timeout active while reading error bodies", async () => {
    const server = await httpFixture((socket) => {
      socket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\npartial");
    }, 25);
    await expect(server.post()).rejects.toThrow(
      `${server.baseUrl}/fixture/inbound timed out after 25ms`,
    );
  });
});

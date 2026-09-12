import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { writeBuildInfo } from "../../../../scripts/write-build-info.js";
import { STALE_WORKER_BUILD_REASON } from "../../../../src/gateway/worker-environments/admission.js";
import { hasErrnoCode } from "../../../../src/infra/errno.js";
import {
  NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import * as desktopStreamCommand from "../../../../src/node-host/desktop-stream-command.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { startPairedNodeWorkerLifecycleProvider } from "./paired-node-worker-lifecycle-provider.js";
import {
  bundleInstallFrames,
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  type PairedNodeWorkerHost,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";

// A real TigerVNC server provides the worker-side desktop. The proof keeps the
// desktop boundary real end to end: the packaged Gateway drives the real node
// host process, which splices a real loopback X server's RFB stream.
const XVNC_BIN = "/usr/bin/Xvnc";
const VNCPASSWD_BIN = "/usr/bin/vncpasswd";
const DESKTOP_VNC_PASSWORD = "e2edesk";
const DESKTOP_GEOMETRY = "1024x768";
const DESKTOP_TERMINAL_APP = "/usr/bin/true";
const RECONCILE_SWEEP_TIMEOUT_MS = 180_000;

const hasDesktopVncServer =
  existsSync(XVNC_BIN) && existsSync(VNCPASSWD_BIN) && existsSync(DESKTOP_TERMINAL_APP);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// The paired worker host runs in this process, so its desktop stream command
// (RFB probe and Gateway attach) is observable here even when the Gateway
// masks the observe RPC error. Record its failures for the diagnostics block.
const nodeDesktopStreamEvents: string[] = [];
const nodeDesktopStreamErrors: string[] = [];
// Capture the real implementation before spying; the live export binding is replaced.
const originalNodeWorkerDesktopStream = desktopStreamCommand.invokeNodeWorkerDesktopStream;
vi.spyOn(desktopStreamCommand, "invokeNodeWorkerDesktopStream").mockImplementation(
  async (...args: Parameters<typeof originalNodeWorkerDesktopStream>) => {
    nodeDesktopStreamEvents.push(`invoked ${new Date().toISOString()}`);
    try {
      const result = await originalNodeWorkerDesktopStream(...args);
      nodeDesktopStreamEvents.push(`settled-ok ${new Date().toISOString()}`);
      return result;
    } catch (error) {
      nodeDesktopStreamEvents.push(`settled-err ${new Date().toISOString()}`);
      nodeDesktopStreamErrors.push(String(error));
      throw error;
    }
  },
);

type DesktopObserveResult = {
  transport: "rfb";
  wsPath: string;
  expiresAtMs: number;
  control: boolean;
};

type Placement = {
  environmentId?: string;
  workerBundleHash?: string;
};

type WorkerEnvironmentRow = {
  bootstrap_bundle_hash?: string | null;
};

function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("free-port probe did not bind")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForExitOrTimeout(child: ChildProcess, timeoutMs: number): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const timer = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs).unref();
  });
  await Promise.race([exited, timer]);
}

/**
 * Runs a real headless TigerVNC X server on a private loopback port.
 *
 * The VNC password file on disk is plaintext (the format the node host reads);
 * TigerVNC itself receives the DES-encoded form through -rfbauth.
 */
async function startDesktopVncServer(root: string): Promise<{
  port: number;
  passwordFilePath: string;
  stop: () => Promise<void>;
}> {
  const encoded = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(VNCPASSWD_BIN, ["-f"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`vncpasswd -f exited with code ${code ?? "unknown"}`));
      }
    });
    child.stdin.write(`${DESKTOP_VNC_PASSWORD}\n`);
    child.stdin.end();
  });
  const encodedPath = path.join(root, "vnc-auth.pw");
  await fs.writeFile(encodedPath, encoded, { mode: 0o600 });
  const passwordFilePath = path.join(root, "vnc-password.txt");
  await fs.writeFile(passwordFilePath, `${DESKTOP_VNC_PASSWORD}\n`, { mode: 0o600 });
  const port = await findFreeLoopbackPort();
  const display = 90 + (port % 100);
  const logPath = path.join(root, "xvnc.log");
  const child = spawn(
    XVNC_BIN,
    [
      `:${display}`,
      "-rfbport",
      String(port),
      "-rfbauth",
      encodedPath,
      "-geometry",
      DESKTOP_GEOMETRY,
      "-depth",
      "24",
      "-localhost",
      "-SecurityTypes",
      "VncAuth",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const logChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => logChunks.push(chunk));
  const stopped = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  if (child.exitCode !== null) {
    throw new Error(`Xvnc failed to start: ${Buffer.concat(logChunks).toString("utf8")}`);
  }
  // Wait until the RFB listener accepts a probe connection.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const probe = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (probe) {
      break;
    }
    if (child.exitCode !== null) {
      await fs.writeFile(logPath, Buffer.concat(logChunks));
      throw new Error(`Xvnc exited before listening: ${Buffer.concat(logChunks).toString("utf8")}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("Xvnc did not start listening within 15s");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  return {
    port,
    passwordFilePath,
    stop: async () => {
      child.kill("SIGTERM");
      await waitForExitOrTimeout(child, 3_000);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await stopped;
      }
    },
  };
}

function rfbChunkToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

class RfbObserverReader {
  private buffered: Buffer = Buffer.alloc(0);
  private waiters: Array<{ length: number; resolve: (chunk: Buffer) => void }> = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        return;
      }
      this.buffered = Buffer.concat([this.buffered, rfbChunkToBuffer(data)]);
      this.drain();
    });
  }

  private drain(): void {
    for (;;) {
      const waiter = this.waiters[0];
      if (!waiter || this.buffered.length < waiter.length) {
        return;
      }
      this.waiters.shift();
      waiter.resolve(this.buffered.subarray(0, waiter.length));
      this.buffered = this.buffered.subarray(waiter.length);
    }
  }

  readExactly(length: number, timeoutMs = 15_000): Promise<Buffer> {
    if (this.buffered.length >= length) {
      const chunk = this.buffered.subarray(0, length);
      this.buffered = this.buffered.subarray(length);
      return Promise.resolve(chunk);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`RFB observer timed out waiting for ${length} bytes`)),
        timeoutMs,
      );
      this.waiters.push({
        length,
        resolve: (chunk: Buffer) => {
          clearTimeout(timer);
          resolve(chunk);
        },
      });
    });
  }

  write(buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(buffer, { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * Opens the Gateway's observer WebSocket and completes the RFB session through
 * ServerInit, proving real RFB frames from the worker-side X server.
 */
async function observeDesktopFrames(params: {
  gateway: WireGateway;
  wsPath: string;
}): Promise<{ width: number; height: number; name: string }> {
  const origin = new URL(params.gateway.wsUrl).origin;
  const ws = new WebSocket(`${origin}${params.wsPath}`);
  const failure = new Promise<never>((_, reject) => {
    ws.once("error", (error) => reject(error));
    ws.once("close", (code, reason) =>
      reject(new Error(`observer socket closed (${code}): ${reason}`)),
    );
  });
  try {
    const opened = await new Promise<void>((resolve, reject) => {
      const openTimer = setTimeout(
        () => reject(new Error("observer websocket upgrade timed out after 30s")),
        30_000,
      );
      ws.once("open", () => {
        clearTimeout(openTimer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(openTimer);
        reject(error);
      });
    });
    void opened;
    const reader = new RfbObserverReader(ws);
    // The Gateway preauthenticates against the worker's VNC server and then
    // synthesizes a no-authentication RFB 3.8 handshake for the observer.
    const banner = await reader.readExactly(12);
    if (!banner.toString("latin1").startsWith("RFB 003.")) {
      throw new Error(`observer did not receive an RFB banner: ${banner.toString("latin1")}`);
    }
    await reader.write(Buffer.from("RFB 003.008\n", "latin1"));
    const securityTypes = await reader.readExactly(2);
    if (securityTypes[0] !== 1 || securityTypes[1] !== 1) {
      throw new Error(
        `observer expected the preauthenticated no-auth offer, received ${[...securityTypes].join(
          ",",
        )}`,
      );
    }
    await reader.write(Buffer.from([1]));
    const securityResult = await reader.readExactly(4);
    if (!securityResult.equals(Buffer.alloc(4))) {
      throw new Error("observer security result was not zero");
    }
    // ClientInit (shared session), then the server answers with its desktop.
    await reader.write(Buffer.from([1]));
    const serverInitHead = await reader.readExactly(24);
    const width = serverInitHead.readUInt16BE(0);
    const height = serverInitHead.readUInt16BE(2);
    const nameLength = serverInitHead.readUInt32BE(20);
    const name = (await reader.readExactly(nameLength)).toString("utf8");
    return { width, height, name };
  } finally {
    // Close first: awaiting the failure/close promise before initiating the
    // close would deadlock whenever the handshake succeeds (nothing else owns
    // this socket, so "error or close" never settles on its own).
    ws.close(1000, "proof complete");
    await failure.catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      setTimeout(() => resolve(), 3_000).unref();
    });
  }
}

/**
 * Races an observe/launch RPC against a deadline; on timeout, dumps live
 * diagnostics (node stream command state, TCP connections, gateway probe,
 * gateway log tail) so a silent server-side hang is diagnosable.
 */
async function raceWithDiagnostics<T>(
  operation: Promise<T>,
  label: string,
  deadline = 120_000,
): Promise<T> {
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${deadline}ms`)), deadline).unref();
  });
  try {
    return await Promise.race([operation, timer]);
  } catch (error) {
    const probe = await (async () => {
      try {
        const { execFileSync } = await import("node:child_process");
        const ss = execFileSync("ss", ["-tnp"], { encoding: "utf8", timeout: 5_000 }).trim();
        return [
          `node desktop stream events: ${JSON.stringify(nodeDesktopStreamEvents)}`,
          `node desktop stream errors: ${JSON.stringify(nodeDesktopStreamErrors)}`,
          `established sockets (test process view):\n${ss
            .split("\n")
            .filter((line) => line.includes("ESTAB"))
            .join("\n")}`,
        ].join("\n");
      } catch (probeError) {
        return `diagnostics probe failed: ${String(probeError)}`;
      }
    })();
    throw new Error(`${String(error)}\n[diagnostics]\n${probe}`, { cause: error });
  }
}

async function waitForNodeReady(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        nodes?: Array<{ connected?: boolean; sessionHost?: boolean }>;
      }>("node.list", {});
      const node = result.nodes?.find((entry) => (entry as { nodeId?: string }).nodeId === nodeId);
      expect(node).toMatchObject({ connected: true, sessionHost: true });
    },
    { timeout: 30_000, interval: 200 },
  );
}

type EnvironmentSummaryRead = {
  id?: string;
  status?: string;
  desktop?: boolean;
  worker?: { desktopApps?: string[] };
};

/**
 * Waits for the state a Gateway restart produces on the durable record: available
 * again, and still advertising the attested desktop and its app. E2E readiness
 * synchronizes on that state instead of on elapsed time or on retrying the
 * downstream request (test/AGENTS.md).
 */
async function waitForDesktopReady(operator: GatewayClient, environmentId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{ environments?: EnvironmentSummaryRead[] }>(
        "environments.list",
        {},
      );
      const environment = result.environments?.find((entry) => entry.id === environmentId);
      expect(environment).toMatchObject({
        status: "available",
        desktop: true,
        worker: { desktopApps: ["terminal"] },
      });
    },
    { timeout: 120_000, interval: 500 },
  );
}

async function readEnvironmentReceipt(
  gateway: WireGateway,
  environmentId: string,
): Promise<string | null> {
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const row = db
        .prepare("SELECT bootstrap_bundle_hash FROM worker_environments WHERE environment_id = ?")
        .get(environmentId) as WorkerEnvironmentRow | undefined;
      return row?.bootstrap_bundle_hash ?? null;
    },
    { env: gateway.runtimeEnv },
  );
}

async function seedDesktopEndpoint(params: {
  stateDir: string;
  environmentId: string;
  port: number;
  passwordFilePath: string;
}): Promise<void> {
  const database = openNodeSqliteDatabase(path.join(params.stateDir, "state", "openclaw.sqlite"));
  try {
    const desktop = {
      protocol: "rfb" as const,
      port: params.port,
      passwordFilePath: params.passwordFilePath,
      apps: [{ id: "terminal" as const, executablePath: DESKTOP_TERMINAL_APP }],
    };
    const result = database
      .prepare("UPDATE worker_environments SET desktop_json = ? WHERE environment_id = ?")
      .run(JSON.stringify(desktop), params.environmentId);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `expected to seed exactly one desktop worker environment, updated ${result.changes}`,
      );
    }
  } finally {
    database.close();
  }
}

describe("paired node worker desktop admission wire", () => {
  it.skipIf(!hasDesktopVncServer)(
    "serves desktop observe and launch from a real worker, refuses a stale build after a Gateway update, and restores access through real reconciliation",
    { timeout: 900_000 },
    async () => {
      const root = tempDirs.make("openclaw-paired-node-desktop-admission-");
      const runtimeRoot = path.join(root, "runtime");
      // Each test owns its deployment bytes; the simulated Gateway rebuild must
      // never rewrite the shared checkout's dist.
      await fs.mkdir(runtimeRoot);
      await fs.cp(path.join(process.cwd(), "dist"), path.join(runtimeRoot, "dist"), {
        recursive: true,
        dereference: false,
      });
      await fs.cp(
        path.join(process.cwd(), "docs", "reference", "templates"),
        path.join(runtimeRoot, "docs", "reference", "templates"),
        { recursive: true },
      );
      const pluginRoot = path.join(runtimeRoot, "dist", "extensions");
      for (const plugin of await fs.readdir(pluginRoot, { withFileTypes: true })) {
        if (!plugin.isDirectory()) {
          continue;
        }
        const selfLink = path.join(pluginRoot, plugin.name, "node_modules", "openclaw");
        const stat = await fs.lstat(selfLink).catch((error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return undefined;
        });
        if (stat?.isSymbolicLink()) {
          await fs.unlink(selfLink);
          await fs.symlink(runtimeRoot, selfLink, "junction");
        }
      }
      for (const file of [
        "package.json",
        "openclaw.mjs",
        "node-version.mjs",
        "node-sqlite.mjs",
        "node-runtime-update.mjs",
      ]) {
        await fs.copyFile(path.join(process.cwd(), file), path.join(runtimeRoot, file));
      }
      await fs.symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(runtimeRoot, "node_modules"),
        "junction",
      );

      const vnc = await startDesktopVncServer(root);
      const provider = await startPairedNodeWorkerLifecycleProvider([]);
      const published = await createPublishedWireWorkspace(root);
      const gatewayOwner = createQaGatewayChild();
      let gateway: WireGateway | undefined;
      let operator: GatewayClient | undefined;
      let workerNode: PairedNodeWorkerHost | undefined;
      let operatorHelloCount = 0;
      const failures: unknown[] = [];
      let phase = "starting the packaged Gateway";
      const progressPath = path.join(root, "proof-progress.log");
      // A hard Vitest timeout tears the worker down before the temp-dir trail can
      // be read, so the same trail is kept in memory and folded into the failure
      // diagnostics: which phase stalled is the first question every time.
      const progressTrail: string[] = [];
      const logLine = (line: string) => {
        const entry = `[${new Date().toISOString()}] ${line}`;
        progressTrail.push(entry);
        void fs.appendFile(progressPath, `${entry}\n`).catch(() => undefined);
      };
      const enterPhase = (next: string) => {
        phase = next;
        logLine(`phase: ${next}`);
      };
      try {
        gateway = await gatewayOwner.start({
          repoRoot: runtimeRoot,
          useRepoCli: true,
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          mutateConfig: (config) => ({
            ...config,
            agents: {
              ...config.agents,
              defaults: {
                ...config.agents?.defaults,
                subagents: { ...config.agents?.defaults?.subagents, maxSpawnDepth: 2 },
              },
            },
            cloudWorkers: { ...config.cloudWorkers, desktop: true },
            nodeHost: { ...config.nodeHost, workerRuns: { enabled: true } },
          }),
        });
        enterPhase("pairing the worker node");
        operator = await connectWireClient({
          gateway,
          role: "operator",
          identity: null,
          onHelloOk: () => {
            operatorHelloCount += 1;
          },
        });
        workerNode = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          bundlePrewarm: true,
        });
        const nodeId = workerNode.identity.deviceId;

        enterPhase("dispatching the worker session onto the paired node");
        const sessionKey = `agent:qa:paired-node-desktop-admission-${Date.now()}`;
        await operator.request("sessions.create", {
          key: sessionKey,
          agentId: "qa",
          worktree: true,
          worktreeName: "paired-node-desktop-admission",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        const dispatched = (await gateway.call(
          "sessions.dispatch",
          { key: sessionKey, deviceId: nodeId },
          { timeoutMs: PROOF_TIMEOUT_MS },
        )) as { placement?: Placement };
        expect(dispatched.placement).toMatchObject({ state: "active" });
        const environmentId = dispatched.placement?.environmentId;
        const currentBundleHash = dispatched.placement?.workerBundleHash;
        if (!environmentId || !currentBundleHash) {
          throw new Error("node placement omitted its environment or worker bundle hash");
        }
        expect(currentBundleHash).toMatch(/^[a-f0-9]{64}$/u);
        // The dispatch installed the real worker bundle on the node host.
        await workerNode.installedBundleDirectory(currentBundleHash);

        enterPhase("attesting the worker desktop onto the durable environment record");
        // The desktop endpoint is a provider-attested warm-time capability; seed
        // exactly that attestation while the Gateway is stopped. Everything
        // downstream of it (admission, transport, RFB, launcher) stays real.
        await workerNode.disconnect();
        const desktopFramesBeforeSeed = workerNode.frames.length;
        const operatorHelloBeforeSeedRestart = operatorHelloCount;
        await gateway.restartAfterStateMutation(async ({ stateDir }) => {
          await seedDesktopEndpoint({
            stateDir,
            environmentId,
            port: vnc.port,
            passwordFilePath: vnc.passwordFilePath,
          });
        });
        // The pairing fixtures ride the operator connection; wait for its
        // authenticated reconnect before re-approving the worker node.
        await vi.waitFor(
          () => expect(operatorHelloCount).toBeGreaterThan(operatorHelloBeforeSeedRestart),
          { timeout: 30_000, interval: 100 },
        );
        await workerNode.connect();
        await waitForNodeReady(operator, workerNode.identity.deviceId);

        enterPhase("observing the current worker's real desktop");
        // Readiness is the state the restart produced, not a settled duration: the
        // record must be available and still advertise the attested desktop before
        // admission can serve it. One bounded observation request follows.
        await waitForDesktopReady(operator, environmentId);
        const observed = await raceWithDiagnostics(
          operator.request<DesktopObserveResult>("worker.desktop.observe", {
            environmentId,
            control: false,
          }),
          "worker.desktop.observe",
          90_000,
        );
        logLine("observe resolved wsPath on the first bounded request");
        expect(observed).toMatchObject({ transport: "rfb", control: false });
        expect(observed.wsPath).toMatch(/^\/desktop\/observe\?token=/u);
        const desktop = await observeDesktopFrames({ gateway, wsPath: observed.wsPath });
        // The name is the real X server's ServerInit desktop name; geometry comes
        // from the headless display this proof started.
        expect(desktop.name.length).toBeGreaterThan(0);
        expect(desktop.width).toBe(1024);
        expect(desktop.height).toBe(768);
        logLine(
          `observed real RFB ServerInit ${desktop.width}x${desktop.height} name=${JSON.stringify(
            desktop.name,
          )}`,
        );

        enterPhase("launching the advertised desktop app on the real worker");
        await expect(
          operator.request("worker.desktop.launch", { environmentId, app: "terminal" }),
        ).resolves.toEqual({ app: "terminal", status: "ready" });
        // Both desktop operations reached the real node host process over the
        // Gateway transport: no stubbed acknowledgements anywhere in this path.
        const desktopFramesAfterLaunch = workerNode.frames.slice(desktopFramesBeforeSeed);
        expect(
          desktopFramesAfterLaunch
            .filter((frame) => frame.command === NODE_WORKER_DESKTOP_STREAM_COMMAND)
            .map((frame) => JSON.parse(frame.paramsJSON ?? "{}")),
        ).toEqual([
          {
            ticket: expect.any(String),
            attachPath: expect.stringMatching(/^\/node-desktop\/attach\?ticket=[a-f0-9]{48}$/u),
            port: vnc.port,
            passwordFilePath: vnc.passwordFilePath,
          },
        ]);
        expect(
          desktopFramesAfterLaunch
            .filter((frame) => frame.command === NODE_WORKER_DESKTOP_LAUNCH_COMMAND)
            .map((frame) => JSON.parse(frame.paramsJSON ?? "{}")),
        ).toEqual([{ id: "terminal", executablePath: DESKTOP_TERMINAL_APP }]);

        enterPhase("updating the Gateway build to supersede the worker's bundle");
        const installFramesBeforeUpgrade = bundleInstallFrames(workerNode).length;
        const desktopFramesBeforeUpgrade = workerNode.frames.length;
        // Capture the operator hello baseline before the restart: the operator's
        // automatic reconnect can complete while the replacement gateway boots,
        // so a post-restart baseline may already include the new hello and never
        // advance past itself.
        const operatorHelloBeforeReconnect = operatorHelloCount;
        await workerNode.disconnect();
        await gateway.restartAfterStateMutation(async () => {
          // An inert change in the owned fixture makes a genuinely different
          // content-addressed worker artifact, as a minor rebuild does.
          await fs.appendFile(
            path.join(runtimeRoot, "dist", "worker", "worker.mjs"),
            "\n// QA desktop admission rebuild\n",
          );
          writeBuildInfo({ rootDir: runtimeRoot });
        });
        await workerNode.connect();
        await waitForNodeReady(operator, workerNode.identity.deviceId);
        await vi.waitFor(
          () => expect(operatorHelloCount).toBeGreaterThan(operatorHelloBeforeReconnect),
          { timeout: 30_000, interval: 100 },
        );

        enterPhase("refusing the stale worker at desktop admission");
        const staleError = await operator
          .request("worker.desktop.observe", { environmentId, control: false })
          .then(
            () => {
              throw new Error("stale desktop observe unexpectedly succeeded");
            },
            (error: unknown) => error,
          );
        expect(String(staleError)).toContain(STALE_WORKER_BUILD_REASON);
        logLine(`stale observe refused: ${String(staleError).slice(0, 200)}`);
        const staleLaunchError = await operator
          .request("worker.desktop.launch", { environmentId, app: "terminal" })
          .then(
            () => {
              throw new Error("stale desktop launch unexpectedly succeeded");
            },
            (error: unknown) => error,
          );
        expect(String(staleLaunchError)).toContain(STALE_WORKER_BUILD_REASON);
        logLine(`stale launch refused: ${String(staleLaunchError).slice(0, 200)}`);
        // Admission refused both requests before any transport side effect: no new
        // desktop command reached the node host. (A gateway restart may legitimately
        // re-publish unrelated workspace-retain invocations on node re-attach.)
        expect(
          workerNode.frames
            .slice(desktopFramesBeforeUpgrade)
            .filter(
              (frame) =>
                frame.command === NODE_WORKER_DESKTOP_STREAM_COMMAND ||
                frame.command === NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
            ),
        ).toHaveLength(0);

        enterPhase("recovering the retained worker through real reconciliation");
        await vi.waitFor(
          () => {
            expect(bundleInstallFrames(workerNode!).length).toBeGreaterThan(
              installFramesBeforeUpgrade,
            );
          },
          { timeout: RECONCILE_SWEEP_TIMEOUT_MS, interval: 500 },
        );
        const recoveredInstall = bundleInstallFrames(workerNode).at(-1);
        if (!recoveredInstall) {
          throw new Error("recovery install frame is missing");
        }
        const refreshedBundleHash = (
          JSON.parse(recoveredInstall.paramsJSON ?? "{}") as { build?: { bundleHash?: string } }
        ).build?.bundleHash;
        expect(refreshedBundleHash).toMatch(/^[a-f0-9]{64}$/u);
        expect(refreshedBundleHash).not.toBe(currentBundleHash);
        logLine(
          `reconciliation installed refreshed bundle ${refreshedBundleHash} (superseded ${currentBundleHash})`,
        );
        // The real node host installs the refreshed bundle bytes. The install frame
        // arriving does not mean the extraction finished; poll until exactly one
        // proof-owned bundle directory for the refreshed hash exists.
        await vi.waitFor(
          async () => {
            await expect(
              workerNode!.installedBundleDirectory(refreshedBundleHash!),
            ).resolves.toBeTruthy();
          },
          { timeout: RECONCILE_SWEEP_TIMEOUT_MS, interval: 1_000 },
        );
        // The same durable record now carries the refreshed receipt.
        await vi.waitFor(
          async () => {
            await expect(readEnvironmentReceipt(gateway!, environmentId)).resolves.toBe(
              refreshedBundleHash,
            );
          },
          { timeout: RECONCILE_SWEEP_TIMEOUT_MS, interval: 500 },
        );
        logLine(`durable receipt refreshed on the same environment record ${environmentId}`);

        enterPhase("restoring desktop observe and launch on the recovered worker");
        await expect(
          operator.request("worker.desktop.launch", { environmentId, app: "terminal" }),
        ).resolves.toEqual({ app: "terminal", status: "ready" });
        const recovered = await operator.request<DesktopObserveResult>("worker.desktop.observe", {
          environmentId,
          control: false,
        });
        const recoveredDesktop = await observeDesktopFrames({
          gateway,
          wsPath: recovered.wsPath,
        });
        expect(recoveredDesktop.name.length).toBeGreaterThan(0);
        logLine(
          `recovered observe served real RFB ServerInit ${recoveredDesktop.width}x${recoveredDesktop.height} name=${JSON.stringify(
            recoveredDesktop.name,
          )}`,
        );
        expect(
          workerNode.frames
            .slice(desktopFramesBeforeUpgrade)
            .filter((frame) => frame.command === NODE_WORKER_DESKTOP_LAUNCH_COMMAND),
        ).toHaveLength(1);
      } catch (error) {
        try {
          await fs.appendFile(
            progressPath,
            `\n[${new Date().toISOString()}] FAILURE while ${phase}: ${String(error).slice(0, 2000)}\n`,
          );
        } catch {
          // best effort only
        }
        const diagnostics = await (async () => {
          try {
            const logDir = path.join(gateway?.tempRoot ?? "", "workspace", "logs");
            const files = await fs.readdir(logDir).catch(() => []);
            const latest = files
              .filter((name) => name.endsWith(".log"))
              .toSorted()
              .at(-1);
            const logTail = latest
              ? (await fs.readFile(path.join(logDir, latest), "utf8")).slice(-24_000)
              : "";
            return [
              `proof progress trail:\n${progressTrail.join("\n")}`,
              `node desktop stream errors: ${JSON.stringify(nodeDesktopStreamErrors.slice(-4))}`,
              `node commands received: ${JSON.stringify(workerNode?.commands.slice(-12))}`,
              `node invoke errors: ${JSON.stringify(
                workerNode?.invokeErrors.slice(-4).map((entry) => String(entry)),
              )}`,
              `gateway file log tail:${latest ? "" : " (unavailable)"}`,
              logTail,
            ].join("\n");
          } catch (diagnosticError) {
            return `diagnostics unavailable: ${String(diagnosticError)}`;
          }
        })();
        try {
          await fs.appendFile(progressPath, `\n[diagnostics]\n${diagnostics.slice(0, 4000)}\n`);
        } catch {
          // best effort only
        }
        failures.push(
          new Error(
            `desktop admission wire proof failed while ${phase}: ${String(error)}\n${diagnostics}\n${gateway?.logs().slice(-12_000) ?? ""}`,
            { cause: error },
          ),
        );
      } finally {
        // Every teardown step runs even if an earlier one fails or hangs, and each
        // outcome is reported: a leaked node host, Gateway, provider or Xvnc must
        // fail the proof instead of passing silently behind a swallowed rejection.
        type CleanupOutcome =
          | { step: string; status: "done" }
          | { step: string; status: "failed"; error: unknown }
          | { step: string; status: "timeout" };
        const CLEANUP_TIMEOUT_MS = 60_000;
        const withCleanupLog = (step: string, task: Promise<unknown>): Promise<CleanupOutcome> =>
          Promise.race<CleanupOutcome>([
            task.then(
              () => ({ step, status: "done" as const }),
              (error: unknown) => ({ step, status: "failed" as const, error }),
            ),
            new Promise<CleanupOutcome>((resolve) => {
              setTimeout(
                () => resolve({ step, status: "timeout" as const }),
                CLEANUP_TIMEOUT_MS,
              ).unref();
            }),
          ]).then(async (outcome) => {
            if (outcome.status !== "done") {
              logLine(
                outcome.status === "timeout"
                  ? `cleanup ${outcome.step} timed out after ${CLEANUP_TIMEOUT_MS}ms`
                  : `cleanup ${outcome.step} failed: ${String(outcome.error).slice(0, 500)}`,
              );
            }
            return outcome;
          });
        const cleanup = await Promise.all([
          withCleanupLog("workerNode.stop", workerNode?.stop() ?? Promise.resolve()),
          withCleanupLog(
            "operator.stopAndWait",
            operator?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
          ),
          withCleanupLog("stopQaGatewayFixture", stopQaGatewayFixture(gatewayOwner)),
          withCleanupLog("provider.stop", provider.stop()),
          withCleanupLog("closeWireServer", closeWireServer(published.server)),
          withCleanupLog("vnc.stop", vnc.stop()),
        ]);
        failures.push(
          ...cleanup.flatMap((outcome) => {
            if (outcome.status === "timeout") {
              return [new Error(`cleanup ${outcome.step} timed out after ${CLEANUP_TIMEOUT_MS}ms`)];
            }
            if (outcome.status === "failed") {
              return [
                outcome.error instanceof Error
                  ? new Error(`cleanup ${outcome.step} failed: ${outcome.error.message}`, {
                      cause: outcome.error,
                    })
                  : new Error(`cleanup ${outcome.step} failed: ${String(outcome.error)}`),
              ];
            }
            return [];
          }),
        );
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "paired node desktop admission proof failed");
      }
    },
  );
});

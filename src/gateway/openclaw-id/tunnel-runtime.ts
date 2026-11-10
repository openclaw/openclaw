// The running half of OpenClaw ID remote access: the private ingress listener
// and the supervised tunnel child. Imported only after the Labs switch is on.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isIrohEndpointKey,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../../infra/runtime-worker-url.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { startOpenClawIdIngressListener, type TunnelApiHandler } from "./ingress-listener.js";
import { stagedKeyPath } from "./tunnel-child/keyfile.js";
import {
  parseTunnelToGatewayMessage,
  TUNNEL_STAGE_ARG,
  type TunnelStageMessage,
} from "./tunnel-ipc.js";
import { createTunnelSupervisor, type TunnelSupervisorStatus } from "./tunnel-supervisor.js";

// Unix socket paths are limited to ~104 bytes on macOS (108 on Linux).
const MAX_SOCKET_PATH = 100;

/** Settings one tunnel runtime was started with; a change restarts it. */
export type TunnelRuntimeSettings = {
  stateDir: string;
  relayUrl: string;
  forwardedProto: "http" | "https";
};

type RuntimeLogger = { info: (message: string) => void; warn: (message: string) => void };

/** Where the endpoint key and ingress socket live for a state directory. */
function resolveTunnelPaths(stateDir: string): { keyPath: string; socketPath: string } {
  const dir = path.join(stateDir, "openclaw-id");
  const socketPath = path.join(dir, "ingress.sock");
  if (process.platform === "win32") {
    const id = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
    return {
      keyPath: path.join(dir, "endpoint.key"),
      socketPath: `\\\\.\\pipe\\openclaw-id-${id}`,
    };
  }
  if (socketPath.length <= MAX_SOCKET_PATH) {
    return { keyPath: path.join(dir, "endpoint.key"), socketPath };
  }
  const id = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  // A long state path moves the socket under the private OpenClaw temp root, not shared /tmp.
  return {
    keyPath: path.join(dir, "endpoint.key"),
    socketPath: path.join(resolvePreferredOpenClawTmpDir(), `openclaw-id-${id}`, "ingress.sock"),
  };
}

/** The tunnel child's endpoint key file (K_srv) for a state directory. */
export function tunnelKeyPath(stateDir: string): string {
  return resolveTunnelPaths(stateDir).keyPath;
}

const STAGE_TIMEOUT_MS = 30_000;

// Runs one tunnel child in stage mode with `message`; resolves with its answer.
async function askStageChild(message: TunnelStageMessage): Promise<string | null> {
  const entry = resolveRuntimeProcessEntrypointUrl("openclawIdTunnel");
  const child = fork(fileURLToPath(entry), [TUNNEL_STAGE_ARG], {
    execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), STAGE_TIMEOUT_MS);
  try {
    const answer = new Promise<string | null | undefined>((resolve) => {
      child.on("message", (raw) => {
        const reply = parseTunnelToGatewayMessage(raw);
        if (reply?.type === "staged") {
          resolve(reply.endpointKey);
        }
      });
      child.once("exit", () => resolve(undefined));
    });
    child.send(message);
    const endpointKey = await answer;
    if (endpointKey === undefined) {
      throw new Error(`the tunnel child could not ${message.type} the next endpoint key`);
    }
    return endpointKey;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit");
    }
  }
}

/**
 * Has a one-shot tunnel child create the next endpoint key in the staged `.next` file (or
 * reuse it) and returns its K_srv. The Gateway never reads the key file itself.
 */
export async function stageEndpointKey(stateDir: string): Promise<IrohEndpointKey> {
  const keyPath = stagedKeyPath(tunnelKeyPath(stateDir));
  const endpointKey = await askStageChild({ type: "stage", keyPath });
  if (!isIrohEndpointKey(endpointKey)) {
    throw new Error("the tunnel child staged a malformed endpoint key");
  }
  return endpointKey;
}

/** Deletes the staged endpoint key unless it is `keep`, the K_srv the stored binding names. */
export async function discardStagedEndpointKey(stateDir: string, keep: string): Promise<void> {
  await askStageChild({ type: "discard", keyPath: stagedKeyPath(tunnelKeyPath(stateDir)), keep });
}

/** Starts the ingress listener, then the tunnel child pointed at it. */
export async function startTunnelRuntime(params: {
  settings: TunnelRuntimeSettings;
  gatewayServer: () => HttpServer | undefined;
  /** Admitted peer keys at start; nothing is admitted until the first push. */
  membership: { seq: number; admitted: string[] };
  /** K_srv the stored binding names, read at every child (re)start; undefined while unlinked. */
  boundEndpointKey: () => string | undefined;
  log: RuntimeLogger;
  onStatus?: (status: TunnelSupervisorStatus) => void;
  /** Serves the OpenClaw ID tunnel API for admitted devices. */
  handleApi?: TunnelApiHandler;
}) {
  const { keyPath, socketPath } = resolveTunnelPaths(params.settings.stateDir);
  const listener = await startOpenClawIdIngressListener({
    socketPath,
    gatewayServer: params.gatewayServer,
    log: params.log,
    ...(params.handleApi ? { handleApi: params.handleApi } : {}),
  });
  const entry = resolveRuntimeProcessEntrypointUrl("openclawIdTunnel");
  const supervisor = createTunnelSupervisor({
    // The worker argv ends with the entry path itself; fork receives it separately.
    launch: { entry, execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1) },
    startMessage: () => {
      const expectedEndpointKey = params.boundEndpointKey();
      return {
        type: "start",
        relayUrl: params.settings.relayUrl,
        keyPath,
        ...(expectedEndpointKey ? { expectedEndpointKey } : {}),
        ingress: { socketPath: listener.socketPath, proxyToken: listener.proxyToken },
        forwardedProto: params.settings.forwardedProto,
      };
    },
    log: params.log,
    onStatus: params.onStatus,
    onReady: (ready) => {
      params.log.info(
        `openclaw-id: tunnel ready (${ready.keyCreated ? "new" : "existing"} endpoint key)`,
      );
    },
  });
  supervisor.pushMembership(params.membership.seq, params.membership.admitted);
  supervisor.start();
  return {
    settings: params.settings,
    supervisor,
    /** Replaces the admitted peer keys; the child closes removed keys with `revoked`. */
    pushMembership(seq: number, admitted: string[]): void {
      supervisor.pushMembership(seq, admitted);
    },
    /** Stops the child (SIGTERM, then SIGKILL after 2 s) and closes the listener. */
    async stop(): Promise<void> {
      await supervisor.stop();
      await listener.close();
    },
  };
}

export type TunnelRuntime = Awaited<ReturnType<typeof startTunnelRuntime>>;

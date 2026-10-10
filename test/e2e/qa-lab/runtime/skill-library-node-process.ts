// The existing paired-node helper is token-only. This lane runs the foreground node CLI
// against the trusted-proxy Gateway's supported direct-local password boundary instead.
import fs from "node:fs/promises";
import path from "node:path";
import { runManagedCommand } from "../../../../scripts/lib/managed-child-process.mts";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { waitFor } from "./cloud-worker-midturn-loss-fixture.js";
import type { SkillLibraryWireClient } from "./skill-library-wire-fixture.js";

type ListedNode = {
  nodeId: string;
  displayName?: string;
  approvalState?: string;
  connected?: boolean;
  paired?: boolean;
  sessionHost?: boolean;
};

export async function prepareSkillLibraryNodeProcess(
  gateway: Pick<OpenClawTestInstance, "port" | "gatewayToken">,
) {
  const node = await createOpenClawTestInstance({
    name: "skill-library-node",
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: gateway.gatewayToken,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_SKIP_CHANNELS: undefined,
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      NODE_ENV: undefined,
      CODEX_HOME: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    },
  });
  const abort = new AbortController();
  const logFile = path.join(node.stateDir, "node.log");
  let failure: Error | undefined;
  let logs = "";
  let completion: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      abort.abort();
      await completion;
      // Failed process-tree cleanup must retain state for diagnosis.
      if (failure) {
        throw failure;
      }
      await node.cleanup();
    })());
  try {
    // Worker state uses os.tmpdir(); own that root so location assertions cannot accept host-global state.
    const workerTmpDir = path.join(node.stateDir, "tmp");
    await fs.mkdir(workerTmpDir, { recursive: true, mode: 0o700 });
    await node.state.writeConfig({
      nodeHost: { workerRuns: { enabled: true } },
      logging: { file: logFile },
    });
    const entrypoint = await node.entrypoint();
    const nodeId = loadOrCreateDeviceIdentity({ env: node.env }).deviceId;
    let started = false;
    const start = async (admin: SkillLibraryWireClient): Promise<void> => {
      abort.signal.throwIfAborted();
      if (started) {
        throw new Error("Proof node has already started");
      }
      started = true;
      try {
        completion = runManagedCommand({
          bin: process.execPath,
          args: [
            ...entrypoint,
            "node",
            "run",
            "--host",
            "127.0.0.1",
            "--port",
            String(gateway.port),
            "--display-name",
            "Skill library proof node",
            "--ephemeral",
          ],
          cwd: process.cwd(),
          env: { ...node.env, TMPDIR: workerTmpDir, TMP: workerTmpDir, TEMP: workerTmpDir },
          stdio: ["ignore", "pipe", "pipe"],
          signal: abort.signal,
          requireProcessTreeExit: process.platform !== "win32",
          onReady: (child) => {
            const append = (data: Buffer) => {
              logs = (logs + data.toString()).slice(-8_000);
            };
            child.stdout?.on("data", append);
            child.stderr?.on("data", append);
          },
        }).then(
          (code) => {
            failure = new Error(`Proof node exited unexpectedly (${code})`);
          },
          (error: unknown) => {
            if (!(abort.signal.aborted && (error as { code?: string }).code === "ABORT_ERR")) {
              failure = error instanceof Error ? error : new Error(String(error));
            }
          },
        );
        const readNodes = async () => {
          abort.signal.throwIfAborted();
          if (failure) {
            throw new Error(`Proof node stopped before readiness\n${logs}`, { cause: failure });
          }
          return (await admin.request<{ nodes: ListedNode[] }>("node.list", {})).nodes;
        };
        // Loopback device approval belongs to the Gateway; racing it can consume a stale request ID.
        const admission = await waitFor("proof node device admission", async () => {
          const nodes = await readNodes();
          const listed = nodes.find((entry) => entry.nodeId === nodeId);
          return listed ? { nodeId: listed.nodeId } : undefined;
        });
        const approval = await waitFor("proof node command approval", async () => {
          const listed = (await readNodes()).find((entry) => entry.nodeId === admission.nodeId);
          if (listed?.approvalState === "approved") {
            return { approved: true as const };
          }
          const pending = await admin.request<{
            pending: Array<{ requestId: string; nodeId: string }>;
          }>("node.pair.list", {});
          const request = pending.pending.find((entry) => entry.nodeId === admission.nodeId);
          return request ? { approved: false as const, requestId: request.requestId } : undefined;
        });
        if (!approval.approved) {
          await admin.request("node.pair.approve", { requestId: approval.requestId });
        }
        await waitFor("proof node worker inventory", async () => {
          const listed = (await readNodes()).find((entry) => entry.nodeId === admission.nodeId);
          return listed?.approvalState === "approved" &&
            listed.connected &&
            listed.paired &&
            listed.sessionHost
            ? listed
            : undefined;
        });
        if (admission.nodeId !== nodeId) {
          throw new Error("Proof node admission changed its prepared device identity");
        }
      } catch (error) {
        try {
          await stop();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Proof node startup and cleanup failed", {
            cause: cleanupError,
          });
        }
        throw error;
      }
    };
    return { nodeId, stateDir: node.stateDir, logFile, start, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Proof node preparation and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

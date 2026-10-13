import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { writeBuildInfo } from "../../../../scripts/write-build-info.js";
import { hasErrnoCode } from "../../../../src/infra/errno.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../../src/infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../../../src/state/openclaw-state-db.generated.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { startPairedNodeWorkerLifecycleProvider } from "./paired-node-worker-lifecycle-provider.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type WireGateway,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";

const SESSION_KEY = "agent:qa:paired-node-worker-upgrade";
const RESULT_FILE = "completed-before-upgrade.txt";
const RESULT_BYTES = "Completed worker result must survive the Gateway update.\n";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type DescribedSession = {
  sessionId?: string;
  execCwd?: string;
  spawnedCwd?: string;
  placement?: {
    state?: string;
    environmentId?: string;
    activeOwnerEpoch?: number;
    workerBundleHash?: string;
    remoteWorkspaceDir?: string;
  };
};

async function describeSession(gateway: WireGateway): Promise<DescribedSession> {
  const result = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
    session?: DescribedSession;
  };
  return result.session ?? {};
}

function pendingResult(gateway: WireGateway, runId: string) {
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<StateDatabase>(db)
          .selectFrom("worker_workspace_pending_results")
          .select(["run_id", "recovery_requested_at_ms"])
          .where("run_id", "=", runId),
      ),
    { env: gateway.runtimeEnv },
  );
}

describe("paired node worker Gateway upgrade wire", () => {
  it(
    "recovers a completed workspace after a same-version build update and continues the same session",
    { timeout: PROOF_TIMEOUT_MS + 180_000 },
    async () => {
      const root = tempDirs.make("openclaw-paired-node-upgrade-");
      const runtimeRoot = path.join(root, "runtime");
      // Each test owns its deployment bytes; a simulated rebuild must never rewrite shared dist.
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
      // Dependency links stay on the installed tree, but plugin self-imports must use this
      // Gateway's copied modules rather than creating another set of runtime singletons.
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
      const provider = await startPairedNodeWorkerLifecycleProvider([]);
      const published = await createPublishedWireWorkspace(root);
      let blockedUploads = 0;
      const unavailableTransfer = createServer((_request, response) => {
        blockedUploads += 1;
        response.writeHead(503).end("Gateway updating");
      });
      await new Promise<void>((resolve) => {
        unavailableTransfer.listen(0, "127.0.0.1", resolve);
      });
      const address = unavailableTransfer.address();
      if (!address || typeof address === "string") {
        throw new Error("transfer outage server did not bind");
      }
      const unavailableUrl = `ws://127.0.0.1:${address.port}`;
      const gatewayOwner = createQaGatewayChild();
      let gateway: WireGateway | undefined;
      let operator: GatewayClient | undefined;
      let operatorHelloCount = 0;
      let workerNode: PairedNodeWorkerHost | undefined;
      let transferUnavailable = false;
      let phase = "starting the packaged Gateway";
      const failures: unknown[] = [];
      try {
        gateway = await startPairedNodeWorkerGateway({
          owner: gatewayOwner,
          providerBaseUrl: provider.baseUrl,
          repoRoot: runtimeRoot,
        });
        phase = "pairing the worker node";
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
          workspaceGatewayUrl: (frame) => {
            const input = JSON.parse(frame.paramsJSON ?? "{}") as {
              transfer?: { direction?: string };
            };
            return transferUnavailable && input.transfer?.direction === "upload"
              ? unavailableUrl
              : gateway!.wsUrl;
          },
        });
        await operator.request("sessions.create", {
          key: SESSION_KEY,
          agentId: "qa",
          worktree: true,
          worktreeName: "paired-node-upgrade",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        const created = await describeSession(gateway);
        expect(created.sessionId).toBeTruthy();
        phase = "dispatching the original worker build";
        await gateway.call(
          "sessions.dispatch",
          {
            key: SESSION_KEY,
            deviceId: workerNode.identity.deviceId,
          },
          { timeoutMs: PROOF_TIMEOUT_MS },
        );
        const before = await describeSession(gateway);
        expect(before.placement).toMatchObject({
          state: "active",
          environmentId: expect.any(String),
          activeOwnerEpoch: expect.any(Number),
        });
        expect(before.placement?.workerBundleHash).toMatch(/^[a-f0-9]{64}$/u);
        const remoteWorkspaceDir = before.placement?.remoteWorkspaceDir;
        if (!remoteWorkspaceDir) {
          throw new Error("node placement omitted its workspace");
        }
        await fs.writeFile(path.join(remoteWorkspaceDir, RESULT_FILE), RESULT_BYTES);
        transferUnavailable = true;
        phase = "retaining the completed result during the upload outage";
        const runId = `paired-node-upgrade-before-${Date.now()}`;
        const started = await operator.request("chat.send", {
          sessionKey: SESSION_KEY,
          message: "Reply exactly: UPGRADE-BEFORE",
          deliver: false,
          idempotencyKey: runId,
        });
        expect(started).toMatchObject({ runId, status: "started" });
        const firstTurn = await operator.request(
          "agent.wait",
          { runId, timeoutMs: PROOF_TIMEOUT_MS },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
        expect(blockedUploads, JSON.stringify(firstTurn)).toBeGreaterThan(0);
        const activeGateway = gateway;
        await vi.waitFor(
          () => {
            expect(pendingResult(activeGateway, runId)).toMatchObject({
              run_id: runId,
              recovery_requested_at_ms: expect.any(Number),
            });
          },
          { timeout: PROOF_TIMEOUT_MS, interval: 100 },
        );
        const localDir = created.execCwd ?? created.spawnedCwd;
        if (!localDir) {
          throw new Error("session omitted its canonical workspace");
        }
        await expect(fs.access(path.join(localDir, RESULT_FILE))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await workerNode.disconnect();
        const pidBefore = gateway.pid;
        const operatorHelloBeforeRestart = operatorHelloCount;
        phase = "restarting the Gateway with the replacement build";
        await gateway.restartAfterStateMutation(async () => {
          // An inert change in the owned fixture makes a genuinely different content-addressed
          // worker artifact at the same package version and protocol, as a minor rebuild does.
          await fs.appendFile(
            path.join(runtimeRoot, "dist", "worker", "worker.mjs"),
            "\n// QA same-version rebuild\n",
          );
          writeBuildInfo({ rootDir: runtimeRoot });
        });
        expect(gateway.pid).not.toBe(pidBefore);
        phase = "waiting for the operator's authenticated reconnect";
        await vi.waitFor(
          () => expect(operatorHelloCount).toBeGreaterThan(operatorHelloBeforeRestart),
          { timeout: 30_000, interval: 100 },
        );
        transferUnavailable = false;
        await workerNode.connect();
        phase = "recovering the old build's pending workspace";
        await vi.waitFor(
          async () => {
            expect(pendingResult(activeGateway, runId)).toBeUndefined();
            const recovered = await describeSession(activeGateway);
            expect(recovered.sessionId).toBe(created.sessionId);
            const recoveredDir = recovered.execCwd ?? recovered.spawnedCwd;
            expect(recoveredDir).toBeTruthy();
            expect(await fs.readFile(path.join(recoveredDir!, RESULT_FILE), "utf8")).toBe(
              RESULT_BYTES,
            );
          },
          { timeout: PROOF_TIMEOUT_MS, interval: 100 },
        );

        phase = "continuing the same session on the replacement worker build";
        const continuation = `paired-node-upgrade-after-${Date.now()}`;
        await operator.request("chat.send", {
          sessionKey: SESSION_KEY,
          message: "Reply exactly: UPGRADE-AFTER",
          deliver: false,
          idempotencyKey: continuation,
        });
        const completed = await operator.request<{ status?: string }>(
          "agent.wait",
          {
            runId: continuation,
            timeoutMs: PROOF_TIMEOUT_MS,
          },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
        expect(completed, gateway.logs().slice(-12_000)).toMatchObject({ status: "ok" });
        const after = await describeSession(gateway);
        expect(after.sessionId).toBe(created.sessionId);
        expect(after.placement).toMatchObject({
          state: "active",
          environmentId: before.placement?.environmentId,
          activeOwnerEpoch: before.placement?.activeOwnerEpoch,
          remoteWorkspaceDir,
        });
        expect(after.placement?.workerBundleHash).not.toBe(before.placement?.workerBundleHash);
        expect(
          await fs.readFile(path.join(after.placement!.remoteWorkspaceDir!, RESULT_FILE), "utf8"),
        ).toBe(RESULT_BYTES);
        const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 100,
        });
        for (const marker of ["UPGRADE-BEFORE", "UPGRADE-AFTER"]) {
          expect(
            history.messages?.filter(
              (message) =>
                (message as { role?: unknown }).role === "assistant" &&
                wireMessageText(message).includes(marker),
            ),
          ).toHaveLength(1);
        }
      } catch (error) {
        failures.push(
          new Error(
            `Gateway upgrade proof failed while ${phase}: ${String(error)}\n${gateway?.logs().slice(-12_000) ?? ""}`,
            { cause: error },
          ),
        );
      } finally {
        const cleanup = await Promise.allSettled([
          workerNode?.stop() ?? Promise.resolve(),
          operator?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
          stopQaGatewayFixture(gatewayOwner),
          provider.stop(),
          closeWireServer(published.server),
          closeWireServer(unavailableTransfer),
        ]);
        failures.push(
          ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "paired node Gateway upgrade proof failed");
      }
    },
  );
});

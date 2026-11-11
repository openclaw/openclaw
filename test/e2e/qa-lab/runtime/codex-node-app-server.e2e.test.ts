// Keyless Linux full composition; run through the documented network-none runner.
// Inference itself must run on the paired node. Not live-model/cloud bootstrap proof.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../helpers/fixture-receipts.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { withCodexNativeThreadReader } from "../../../helpers/gateway-codex-harness-native-subagent.js";
import { withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  GATEWAY_BEARER,
  MARKERS,
  MODEL_ID,
  MODEL_REF,
  stageWorkerCodex,
  startWorkerResponses,
  type Scenario,
} from "./codex-node-app-server.test-support.js";
import {
  approvePairing,
  createChildEnv,
  processIsAlive,
  readNode,
  startNodeProcess,
  stopChild,
  type CapturedChild,
  type GatewayHandle,
} from "./gateway-node-mcp.test-support.js";
import {
  closeWireServer,
  createPublishedWireWorkspace,
  createWireWorkspaceSettlementWaiter,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SESSION_KEY = "agent:qa:codex-node-app-server-proof";
const TIMEOUT_MS = 120_000;
const WAIT = { timeout: 30_000, interval: 100 };
type Session = {
  sessionId?: string;
  execCwd?: string;
  spawnedCwd?: string;
  permissionMode?: string;
  agentRuntime?: { id: string };
  placement?: {
    state?: string;
    remoteWorkspaceDir?: string;
    workspaceBaseManifestRef?: string;
    generation?: number;
    environmentId?: string;
    activeOwnerEpoch?: number;
  };
};
type AuthObservation = {
  nativePids: number[];
  helperPid: number;
  startedAt: number;
  gate?: string;
  appServerPid: number;
  nodePid: number;
  parentAppServer: boolean;
  home: string;
  codexHome: string;
  executable: string;
};
type NativeEvidence = { pid: number; cwd: string; home: string; codexHome?: string };
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}
async function describeSession(gateway: GatewayHandle, key = SESSION_KEY) {
  return ((await gateway.call("sessions.describe", { key })) as { session: Session }).session;
}

// The ordinary first-party route supplies only a synthetic Gateway availability key.
// Actual inference must use the worker command bearer; no forced harness or client injection.
describe.skipIf(process.platform !== "linux")("Codex worker-hosted app-server composition", () => {
  it(
    "selects the exact admitted Full worker, resumes, cancels, and joins cleanup",
    { timeout: 360_000 },
    async ({ signal }) => {
      const root = await fs.realpath(tempDirs.make("openclaw-codex-worker-app-server-"));
      const nodeHome = path.join(root, "node-home");
      const nodeState = path.join(root, "node-state");
      const nodeTmp = path.join(root, "node-tmp");
      const nodeConfigPath = path.join(root, "node.json");
      await Promise.all(
        [nodeHome, nodeState, nodeTmp].map((dir) =>
          fs.mkdir(dir, { recursive: true, mode: 0o700 }),
        ),
      );
      const gatewayOwner = createQaGatewayChild();
      let gateway: GatewayHandle | undefined;
      let node: CapturedChild | undefined;
      let client: GatewayClient | undefined;
      let receipts: FixtureReceiptChannel | undefined;
      let provider: Awaited<ReturnType<typeof startWorkerResponses>> | undefined;
      let published: PublishedWireWorkspace | undefined;
      let clientClosed = false;
      const settlement = createWireWorkspaceSettlementWaiter();
      const threadReady = new Map<string, Record<string, unknown>>();

      await runQaGatewayFixture(
        async () => {
          receipts = await openFixtureReceiptChannel();
          provider = await startWorkerResponses(receipts.endpoint);
          const staged = await stageWorkerCodex({
            root,
            nodeState,
            providerBaseUrl: provider.baseUrl,
            receiptEndpoint: receipts.endpoint,
          });
          expect(staged.command).toMatch(/^codex\.app-server\.stdio\.v1\.[a-f0-9]{64}$/);
          published = await createPublishedWireWorkspace(path.join(root, "workspace"));
          const catalogPreload = new URL(
            "./codex-node-app-server-catalog-preload.mjs",
            import.meta.url,
          );
          catalogPreload.searchParams.set("fixture", provider.baseUrl);
          catalogPreload.searchParams.set("provisioning", staged.sourceHome);
          gateway = await gatewayOwner.start({
            repoRoot: process.cwd(),
            initializeCurrentRuntimeState: true,
            command: {
              executablePath: process.execPath,
              argsPrefix: ["dist/index.js"],
              cwd: process.cwd(),
              // Managed workspace admission needs disk-backed scratch, not the runner’s /tmp tmpfs.
              tempParentDir: root,
              usePackagedPlugins: false,
            },
            transportBaseUrl: "http://127.0.0.1",
            providerMode: "mock-openai",
            providerBaseUrl: `${provider.baseUrl}/v1`,
            primaryModel: MODEL_REF,
            alternateModel: MODEL_REF,
            enabledPluginIds: ["codex", "openai"],
            mockAuthAgentIds: [],
            controlUiEnabled: false,
            runtimePreloads: [catalogPreload.href],
            runtimeEnvPatch: {
              // No ambient credentials: these are newly authored synthetic sources.
              OPENAI_API_KEY: GATEWAY_BEARER,
              CODEX_HOME: staged.sourceHome,
            },
            mutateConfig: (config) => {
              config.auth = {};
              // Keep unrelated remote metadata/utility services outside this provider proof.
              config.models = { mode: "merge", providers: {}, catalogRefresh: { enabled: false } };
              const defaults = (config.agents!.defaults ??= {});
              defaults.models = { [MODEL_REF]: {} };
              defaults.utilityModel = "";
              defaults.mediaModels = undefined;
              config.agents!.entries!.qa!.tools = { profile: "full" };
              config.tools = {
                profile: "full",
                toolSearch: false,
                codeMode: false,
                exec: { mode: "full" },
              };
              config.memory = { search: { enabled: false } };
              config.plugins!.slots = { ...config.plugins!.slots, memory: "none" };
              config.plugins!.entries!["memory-core"] = { enabled: false };
              config.plugins!.entries!.codex = {
                enabled: true,
                config: {
                  appServer: { homeScope: "user", workerHostedCloud: true },
                  supervision: { enabled: false },
                },
              };
              config.gateway!.nodes = {
                commands: { allow: [staged.command] },
                pairing: { autoApproveLocal: false, sshVerify: false },
              };
              config.nodeHost = { workerRuns: { enabled: true } };
              return config;
            },
          });
          client = await acquireGatewayTestClient(
            {
              url: gateway.wsUrl,
              token: gateway.token,
              role: "operator",
              deviceIdentity: null,
              clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
              requestTimeoutMs: TIMEOUT_MS,
              onEvent: (event) => {
                settlement.onEvent(event);
                const payload = event.payload;
                if (
                  event.event === "agent" &&
                  isRecord(payload) &&
                  payload.stream === "codex_app_server.lifecycle" &&
                  typeof payload.runId === "string" &&
                  isRecord(payload.data) &&
                  payload.data.phase === "thread_ready"
                ) {
                  threadReady.set(payload.runId, payload.data);
                }
              },
              onClose: () => {
                clientClosed = true;
              },
            },
            {
              timeoutMs: TIMEOUT_MS,
              timeoutMessage: "P8 operator connection timed out",
              closeMessage: "P8 operator closed",
              signal,
            },
          );
          const gatewayPort = Number(new URL(gateway.wsUrl).port);
          const nodeConfig: OpenClawConfig = {
            gateway: { mode: "local" },
            plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
            nodeHost: { workerRuns: { enabled: true }, skills: { enabled: false } },
          };
          await fs.writeFile(nodeConfigPath, JSON.stringify(nodeConfig), { mode: 0o600 });
          const nodeEnv = createChildEnv({
            home: nodeHome,
            tempDir: nodeTmp,
            extra: {
              OPENCLAW_HOME: nodeHome,
              OPENCLAW_STATE_DIR: nodeState,
              OPENCLAW_CONFIG_PATH: nodeConfigPath,
              OPENCLAW_GATEWAY_TOKEN: gateway.token,
              OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
            },
          });
          expect(nodeEnv).not.toHaveProperty("OPENAI_API_KEY");
          expect(nodeEnv).not.toHaveProperty("CODEX_HOME");
          expect(nodeEnv).not.toHaveProperty("GITHUB_TOKEN");
          node = startNodeProcess(gatewayPort, nodeEnv);
          const nodeId = await approvePairing(gateway, "device");
          await stopChild(node);
          node = startNodeProcess(gatewayPort, nodeEnv);
          await approvePairing(gateway, "node", nodeId);
          await stopChild(node);
          node = startNodeProcess(gatewayPort, nodeEnv);
          const nodePid = node.child.pid;
          expect(nodePid).toEqual(expect.any(Number));
          await vi.waitFor(async () => {
            expect(await readNode(gateway!, nodeId)).toMatchObject({
              paired: true,
              connected: true,
              approvalState: "approved",
              sessionHost: true,
              commands: expect.arrayContaining([staged.command]),
            });
            const inventory = await client!.request<{
              environments: Array<{
                id: string;
                status: string;
                sessionHost: boolean;
                invocableCommands: string[];
              }>;
            }>("environments.list", {});
            expect(
              inventory.environments.find((entry) => entry.id === `node:${nodeId}`),
            ).toMatchObject({
              status: "available",
              sessionHost: true,
              invocableCommands: expect.arrayContaining([staged.command]),
            });
          }, WAIT);

          const catalog = await client.request<{
            models: Array<{ provider: string; id: string; available?: boolean }>;
            providerOutcomes?: Array<{ provider: string; status: string; rejectionScope?: string }>;
            refreshFailed?: boolean;
            pendingProviders?: string[];
          }>("models.list", { agentId: "qa", refresh: true }, { timeoutMs: TIMEOUT_MS });
          const model = catalog.models.find(
            (entry) => entry.provider === "openai" && entry.id === MODEL_ID,
          );
          expect(
            model,
            "The ordinary first-party catalog must admit the configured model without a forced harness: " +
              JSON.stringify({
                model,
                refreshFailed: catalog.refreshFailed,
                transportRequests: provider.catalogRequests.slice(0, 8),
                pendingProviders: catalog.pendingProviders?.slice(0, 8),
                outcomes: catalog.providerOutcomes
                  ?.slice(0, 8)
                  .map(({ provider: outcomeProvider, status, rejectionScope }) => ({
                    provider: outcomeProvider,
                    status,
                    rejectionScope,
                  })),
              }),
          ).toMatchObject({
            available: true,
            agentRuntime: {
              id: "codex",
              source: "implicit",
              cloudPlacementExecutionMode: "remote-exec",
            },
          });
          expect(provider.catalogRequests).toContainEqual({
            kind: "models",
            gatewayAuth: true,
            carrier: expect.stringMatching(/^worker:[1-9]\d*$/),
            runtime: process.versions.bun ? "bun" : "node",
          });
          expect(provider.catalogRequests.every((request) => request.gatewayAuth)).toBe(true);
          console.log(
            "P8_CATALOG_TRANSPORT_PROOF " + JSON.stringify(provider.catalogRequests.slice(0, 8)),
          );
          const createAndDispatch = async (key: string, worktreeName: string) => {
            await gateway!.call("sessions.create", {
              key,
              agentId: "qa",
              model: MODEL_REF,
              permissionMode: "full",
              worktree: true,
              worktreeName,
              worktreeBaseRef: "main",
              cwd: published!.source,
            });
            const local = await describeSession(gateway!, key);
            expect(local.permissionMode).toBe("full");
            await gateway!.call(
              "sessions.dispatch",
              { key, deviceId: nodeId },
              { timeoutMs: TIMEOUT_MS },
            );
            return { local, placed: await describeSession(gateway!, key) };
          };
          const { local, placed } = await createAndDispatch(
            SESSION_KEY,
            "codex-worker-app-server-proof",
          );
          const localWorkspace = local.execCwd ?? local.spawnedCwd;
          if (!localWorkspace) {
            throw new Error("P8 session omitted its managed workspace");
          }
          expect(placed.placement?.state).toBe("active");
          const remoteWorkspace = placed.placement?.remoteWorkspaceDir;
          if (!remoteWorkspace) {
            throw new Error("P8 dispatch omitted its remote workspace");
          }
          expect(remoteWorkspace).not.toBe(localWorkspace);

          const observations = async () =>
            Promise.all(
              (await fs.readdir(staged.observations)).map((name) =>
                readJson<AuthObservation>(path.join(staged.observations, name)),
              ),
            );
          const expectNativeCleanup = async () => {
            // Foreign PIDs expose no fixture exit signal: observe eventual extinction
            // before stopping the node, so teardown cannot supply the missing cleanup.
            await vi.waitFor(async () => {
              const seen = await observations();
              expect(seen.length).toBeGreaterThan(0);
              for (const entry of seen) {
                expect(entry).toMatchObject({ nodePid, parentAppServer: true });
                expect(entry.home.startsWith(`${nodeState}${path.sep}`)).toBe(true);
                expect(
                  entry.codexHome.startsWith(
                    path.join(entry.home, ".openclaw-worker", "codex") + path.sep,
                  ),
                ).toBe(true);
                expect(entry.nativePids).toContain(entry.appServerPid);
                expect(processIsAlive(entry.helperPid)).toBe(false);
                for (const pid of entry.nativePids) {
                  expect(processIsAlive(pid)).toBe(false);
                }
              }
            }, WAIT);
          };
          const start = async (scenario: Scenario, sessionKey = SESSION_KEY) => {
            const runId = randomUUID();
            expect(
              await client!.request("chat.send", {
                sessionKey,
                message: MARKERS[scenario],
                deliver: false,
                idempotencyKey: runId,
              }),
            ).toMatchObject({ runId, status: "started" });
            return runId;
          };
          const wait = (runId: string) =>
            vi.waitFor(async () => {
              const result = await client!.request<{ status: string }>(
                "agent.wait",
                { runId, timeoutMs: TIMEOUT_MS },
                { timeoutMs: TIMEOUT_MS + 5_000 },
              );
              // Queued follow-ups return pending immediately, before their owner runs.
              expect(result.status).not.toBe("pending");
              return result;
            }, WAIT);
          const waitForHeldAuth = async (marker: string, outcome: ReturnType<typeof wait>) => {
            await withinTest(
              Promise.race([
                receipts!.waitFor(marker, "held-before-token"),
                outcome.then((value) => {
                  throw new Error(
                    `Worker auth never reached its pending effect: ${JSON.stringify(value)}`,
                  );
                }),
              ]),
              signal,
            );
            const held = (await observations()).filter((entry) => entry.gate === marker);
            expect(held.length).toBeGreaterThan(0);
            for (const entry of held) {
              expect(entry).toMatchObject({ nodePid, parentAppServer: true });
              expect(processIsAlive(entry.helperPid)).toBe(true);
              expect(processIsAlive(entry.appServerPid)).toBe(true);
            }
            return held;
          };
          const checkEvidence = async (scenario: Scenario, directory: string) => {
            const evidence = await readJson<NativeEvidence>(
              path.join(directory, `p8-${scenario}.json`),
            );
            expect(evidence).toMatchObject({
              cwd: remoteWorkspace,
              providerKeyPresent: false,
              forgeTokenPresent: false,
              gatewayTokenPresent: false,
              runtimeInjectionPresent: false,
            });
            expect(evidence.home).not.toBe(nodeHome);
            expect(evidence.home.startsWith(`${nodeState}${path.sep}`)).toBe(true);
            return evidence;
          };
          let threadId: string | undefined;
          let firstNativeTurnId: unknown;
          for (const scenario of ["first", "second"] as const) {
            const manifest = (await describeSession(gateway)).placement?.workspaceBaseManifestRef;
            const allowedGate = "P8_AUTH_ALLOWED";
            if (scenario === "first") {
              await fs.writeFile(staged.authGate, allowedGate, { mode: 0o600 });
            }
            const runId = await start(scenario);
            const outcome = wait(runId);
            if (scenario === "first") {
              await waitForHeldAuth(allowedGate, outcome);
              expect(provider.requests).toHaveLength(0);
              await fs.rm(staged.authGate);
              receipts.release(allowedGate, "continue");
            }
            expect(await outcome, gateway.readLogsSince(0)).toMatchObject({ status: "ok" });
            await settlement.wait(client, SESSION_KEY, signal, manifest);
            await checkEvidence(scenario, localWorkspace);
            expect((await describeSession(gateway)).agentRuntime?.id).toBe("codex");
            const ready = threadReady.get(runId);
            expect(ready).toMatchObject({
              action: scenario === "first" ? "started" : "resumed",
              threadId: expect.any(String),
            });
            if (typeof ready?.threadId !== "string") {
              throw new Error("Native thread identity missing");
            }
            if (scenario === "first") {
              threadId = ready.threadId;
            } else {
              expect(ready.threadId).toBe(threadId);
            }
            expect(
              provider.requests
                .filter((entry) => entry.scenario === scenario)
                .map((entry) => ({ auth: entry.workerAuth, completed: entry.completed })),
            ).toEqual([
              { auth: true, completed: false },
              { auth: true, completed: true },
            ]);
            await expectNativeCleanup();
            const observed = (await observations()).at(-1)!;
            const providerCount = provider.requests.length;
            // Read the actual worker-owned store using its observed native binary, never resume it.
            await withCodexNativeThreadReader(
              {
                command: observed.executable,
                args: ["app-server", "--listen", "stdio://"],
                codexHome: observed.codexHome,
                stateDir: nodeState,
                cwd: remoteWorkspace,
                env: createChildEnv({ home: observed.home, tempDir: nodeTmp }),
                requestTimeoutMs: TIMEOUT_MS,
              },
              async (readThread) => {
                const result = await readThread(threadId!);
                expect(result).toMatchObject({ thread: { id: threadId } });
                const thread =
                  isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
                const turns = Array.isArray(thread?.turns) ? thread.turns : [];
                expect(turns).toHaveLength(scenario === "first" ? 1 : 2);
                expect(turns).toEqual(
                  expect.arrayContaining([expect.objectContaining({ status: "completed" })]),
                );
                const first = isRecord(turns[0]) ? turns[0] : undefined;
                if (scenario === "first") {
                  firstNativeTurnId = first?.id;
                }
                expect(firstNativeTurnId).toEqual(expect.any(String));
                expect(first?.id).toBe(firstNativeTurnId);
                expect(JSON.stringify(turns)).toContain(MARKERS.first + "_OK");
                if (scenario === "second") {
                  expect(JSON.stringify(turns)).toContain(MARKERS.second + "_OK");
                }
              },
            );
            expect(provider.requests).toHaveLength(providerCount);
          }
          const history = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: SESSION_KEY,
            limit: 50,
          });
          expect(JSON.stringify(history.messages)).toContain(`${MARKERS.first}_OK`);
          expect(JSON.stringify(history.messages)).toContain(`${MARKERS.second}_OK`);

          const cancelledRun = await start("cancel");
          const cancelledOutcome = wait(cancelledRun);
          await withinTest(
            Promise.race([
              receipts.waitFor(MARKERS.cancel, "started"),
              cancelledOutcome.then((outcome) => {
                throw new Error(
                  "Cancellation command never reached its held state: " + JSON.stringify(outcome),
                );
              }),
            ]),
            signal,
          );
          const held = await checkEvidence("cancel", remoteWorkspace);
          expect(processIsAlive(held.pid)).toBe(true);
          expect(threadReady.get(cancelledRun)).toMatchObject({ threadId, action: "resumed" });
          expect(
            await client.request("chat.abort", { sessionKey: SESSION_KEY, runId: cancelledRun }),
          ).toMatchObject({ aborted: true, runIds: expect.arrayContaining([cancelledRun]) });
          expect(await cancelledOutcome).toMatchObject({
            status: "error",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          });
          await withinTest(receipts.waitForExit(MARKERS.cancel), signal);
          await vi.waitFor(() => {
            expect(processIsAlive(held.pid)).toBe(false);
          }, WAIT);
          await expectNativeCleanup();
          expect(
            provider.requests.every(
              (entry) =>
                entry.workerAuth &&
                entry.model === MODEL_ID &&
                entry.tools.includes("exec_command"),
            ),
          ).toBe(true);
          expect(provider.requests.filter((entry) => entry.scenario === "cancel")).toHaveLength(1);

          {
            const scenario = "revoked";
            const key = `${SESSION_KEY}:${scenario}`;
            const { placed: target } = await createAndDispatch(key, `p8-${scenario}`);
            const placement = target.placement;
            if (
              !target.sessionId ||
              !placement?.remoteWorkspaceDir ||
              typeof placement.generation !== "number" ||
              typeof placement.activeOwnerEpoch !== "number" ||
              !placement.environmentId
            ) {
              throw new Error("Authority fixture omitted the actual placement owner identity");
            }
            const marker = `P8_AUTH_${scenario.toUpperCase()}`;
            const requestCount = provider.requests.length;
            await fs.writeFile(staged.authGate, marker, { mode: 0o600 });
            const runId = await start(scenario, key);
            const outcome = wait(runId);
            try {
              const heldAuth = await waitForHeldAuth(marker, outcome);
              expect(provider.requests).toHaveLength(requestCount);
              // Existing write settlement forbids ordinary reassignment while pending.
              // Observe that owner, rather than abandoning data to manufacture a move.
              await expect(
                gateway.call(
                  "sessions.move",
                  {
                    key,
                    expected: {
                      generation: placement.generation,
                      environmentId: placement.environmentId,
                      ownerEpoch: placement.activeOwnerEpoch,
                    },
                    target: { kind: "gateway" },
                  },
                  { timeoutMs: TIMEOUT_MS },
                ),
              ).rejects.toThrow("pending cloud workspace result");
              const helperExit = receipts.waitForExit(marker).then(() => Date.now());
              const nativeExit = expectNativeCleanup().then(() => Date.now());
              // The saved narrower mode cannot restart this Full-only carrier.
              // Its existing permission owner reports failure and stops the captured run.
              await expect(
                gateway.call("sessions.patch", { key, permissionMode: "workspace" }),
              ).rejects.toThrow(
                "Permissions were saved, but could not be applied to the active run",
              );
              expect((await describeSession(gateway, key)).permissionMode).toBe("workspace");
              expect(await outcome).toMatchObject({ status: "error" });
              const [exitedAt, nativeExitedAt] = await withinTest(
                Promise.all([helperExit, nativeExit]),
                signal,
              );
              for (const entry of heldAuth) {
                // Native command-auth expires at 5s: prove owner cancellation, not timeout.
                expect(exitedAt - entry.startedAt).toBeLessThan(4_000);
                expect(nativeExitedAt - entry.startedAt).toBeLessThan(4_000);
                expect(processIsAlive(entry.helperPid)).toBe(false);
              }
              // A late helper release cannot revive the withdrawn real owner.
              receipts.release(marker, "continue");
              expect(provider.requests).toHaveLength(requestCount);
              await expect(
                fs.access(path.join(placement.remoteWorkspaceDir, `p8-${scenario}.json`)),
              ).rejects.toMatchObject({ code: "ENOENT" });
              console.log(
                "P8_AUTHORITY_EFFECT_PROOF " +
                  JSON.stringify({
                    nearestForbiddenProviderRequests: 0,
                    pendingReassignment: "refused-with-pending-workspace-result",
                    revokedPermission: "workspace",
                    revokedProviderRequests: provider.requests.length - requestCount,
                    heldHelperExitMs: heldAuth.map((entry) => exitedAt - entry.startedAt),
                    heldNativeExitMs: heldAuth.map((entry) => nativeExitedAt - entry.startedAt),
                    nativeChildrenStoppedBeforeNodeShutdown: true,
                  }),
              );
            } finally {
              await fs.rm(staged.authGate, { force: true });
              receipts.release(marker, "continue");
            }
            // A subsequent attempt on the withdrawn placement must not begin another effect.
            const beforeForbidden = {
              requests: provider.requests.length,
              auth: (await observations()).length,
            };
            expect((await describeSession(gateway, key)).permissionMode).toBe("workspace");
            expect(await wait(await start("forbidden", key))).toMatchObject({ status: "error" });
            expect(provider.requests).toHaveLength(beforeForbidden.requests);
            expect(await observations()).toHaveLength(beforeForbidden.auth);
            await expect(
              fs.access(path.join(placement.remoteWorkspaceDir, "p8-forbidden.json")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(provider.errors).toEqual([]);
          expect(gateway.logs()).not.toContain("P8_UNEXPECTED_REMOTE_FETCH");

          await stopChild(node);
          expect(processIsAlive(nodePid!)).toBe(false);
          await vi.waitFor(async () => {
            expect(await readNode(gateway!, nodeId)).toMatchObject({ connected: false });
          }, WAIT);
          await client.stopAndWait({ timeoutMs: 5_000 });
          expect(clientClosed).toBe(true);
        },
        () => stopChild(node),
        () => client?.stopAndWait({ timeoutMs: 5_000 }),
        () => stopQaGatewayFixture(gatewayOwner),
        () => (published ? closeWireServer(published.server) : undefined),
        () => provider?.close(),
        () => receipts?.close(),
      ).catch((cause: unknown) => {
        throw new Error(
          `P8 worker fixture failed:\n${node?.logs() ?? "Node was not started"}\n${gateway?.readLogsSince(0) ?? ""}`,
          { cause },
        );
      });
    },
  );
});

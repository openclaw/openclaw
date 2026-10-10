import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../../../src/agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { validateConfigObject } from "../../../../src/config/validation-core.js";
import type { AgentJobTerminalSnapshot } from "../../../../src/gateway/agent-turn/types.js";
import { workspaceQuiescenceArgv } from "../../../../src/gateway/worker-environments/workspace-quiescence-scripts.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../../src/infra/kysely-sync.js";
import {
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { prepareNodeHostRuntime } from "../../../../src/node-host/runtime.js";
import { writeSkill } from "../../../../src/skills/test-support/e2e-test-helpers.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../../../src/state/openclaw-agent-db-readonly.js";
import type { DB as AgentDatabase } from "../../../../src/state/openclaw-agent-db.generated.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../../../src/state/openclaw-state-db.generated.js";
import { parseNodeWorkerLaunchInput } from "../../../../src/worker/node-supervisor-protocol.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../../../src/worker/node-workspace-protocol.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  startPairedNodeWorkerGateway,
  wireMessageText,
  type PairedNodeWorkerHost,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);
const [providerId, modelId] = MODEL_REF.split("/");
const QUIESCENCE_NONCE = "0".repeat(32);
const REMOTE_WORKSPACE_QUIESCE_JS = workspaceQuiescenceArgv(
  "/synthetic-workspace",
  { action: "acquire", nonce: QUIESCENCE_NONCE, timeoutMs: 1 },
  "dedicated",
)[2];
const REMOTE_WORKSPACE_RESUME_JS = workspaceQuiescenceArgv(
  "/synthetic-workspace",
  { action: "release", nonce: QUIESCENCE_NONCE },
  "dedicated",
)[2];

type Session = {
  key: string;
  sessionId: string;
  workspaceDir?: string;
  placement?: { state: string; workspaceResultReconciling?: boolean };
};
type Changed = { sessionKey?: string; session?: Session; phase?: string; reason?: string };

function readSettlement(gateway: WireGateway, key: string) {
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const query = getNodeSqliteKysely<StateDatabase>(db);
      const placement = executeSqliteQueryTakeFirstSync(
        db,
        query.selectFrom("worker_session_placements").selectAll().where("session_key", "=", key),
      );
      const pending =
        placement &&
        executeSqliteQueryTakeFirstSync(
          db,
          query
            .selectFrom("worker_workspace_pending_results")
            .selectAll()
            .where("session_id", "=", placement.session_id),
        );
      return { placement, pending };
    },
    { env: gateway.runtimeEnv },
  );
}

function readPendingInput(gateway: WireGateway, key: string, runId: string) {
  return withOpenClawAgentDatabaseReadOnly(
    ({ db }) =>
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<AgentDatabase>(db)
          .selectFrom("session_pending_inputs")
          .select(["session_id", "run_id", "state"])
          .where("session_key", "=", key)
          .where("run_id", "=", runId),
      ),
    { agentId: "qa", env: gateway.runtimeEnv },
  );
}

// Release E2E: no helper can prove required admission -> physical native process ->
// finishing ACK -> SQLite result fence -> projected clear -> SAME-session cursor reuse.
it.skipIf(process.platform === "win32")(
  "settles required native empty workspaces and same-session follow-ups through public RPC",
  async ({ signal }) => {
    const root = await realpath(tempDirs.make("required-native-same-session-"));
    const gatewayOwner = createQaGatewayChild();
    const identity = loadOrCreateDeviceIdentity({ path: path.join(root, "node-identity.sqlite") });
    const nodeHostRoot = path.join(root, "node-state", "node-host");
    await mkdir(nodeHostRoot, { recursive: true, mode: 0o700 });
    const remoteAgentWorkspace = path.join(root, "remote-agent-workspace");
    await writeSkill({
      dir: path.join(remoteAgentWorkspace, "skills", "workspace-proof"),
      name: "workspace-proof",
      description: "Synthetic node-hosted workspace skill",
    });
    const requests: string[] = [];
    const providerErrors: unknown[] = [];
    const observationFailure = createDeferred<never>();
    // Observers only inspect/call through. Surface their first failed assertion
    // instead of leaving the test suspended at a later gate.
    const checkpoint = async (promise: PromiseLike<void>, message: string) => {
      try {
        return await withinTest(Promise.race([promise, observationFailure.promise]), signal);
      } catch (error) {
        if (signal.aborted) {
          throw new Error(message, { cause: error });
        }
        throw error;
      }
    };
    const startedAt = Date.now();
    const record = (boundary: string, detail: unknown) => {
      const entry = { ms: Date.now() - startedAt, boundary, detail };
      console.info("required-native-boundary", JSON.stringify(entry));
    };
    let onNativeRequest: ((marker: string) => void) | undefined;
    const provider = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages: Array<{ role: string; content: string }>;
        };
        const marker = body.messages
          .filter((message) => message.role === "user")
          .map(
            (message) =>
              JSON.stringify(message.content).match(
                /Hello\. Reply exactly: (REQUIRED-NATIVE-[0-9]+-[AB])/u,
              )?.[1],
          )
          .findLast((candidate) => candidate !== undefined);
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.headers.authorization).toBe("Bearer synthetic-required-native-key");
        expect(marker).toBe(
          `REQUIRED-NATIVE-${Math.floor(requests.length / 2)}-${requests.length % 2 === 0 ? "A" : "B"}`,
        );
        expect(JSON.stringify(body.messages)).toContain("workspace-proof");
        expect(JSON.stringify(body.messages)).not.toContain("worktree-sources");
        requests.push(marker!);
        onNativeRequest?.(marker!);
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finish_reason] of [
          [{ role: "assistant", content: marker }, null],
          [{}, "stop"],
        ]) {
          response.write(
            "data: " +
              JSON.stringify({
                id: marker,
                object: "chat.completion.chunk",
                created: 1,
                model: modelId,
                choices: [{ index: 0, delta, finish_reason }],
              }) +
              "\n\n",
          );
        }
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) => {
        providerErrors.push(error);
        observationFailure.reject(error);
        response.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("missing native provider address");
    }
    const nativeConfig: OpenClawConfig = {
      models: {
        providers: {
          [providerId!]: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:" + address.port + "/v1",
            apiKey: "synthetic-required-native-key",
            models: [
              {
                id: modelId!,
                name: modelId!,
                contextWindow: 32768,
                maxTokens: 128,
                reasoning: true,
                thinkingLevelMap: { medium: "medium" },
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    let beforeInvoke: Parameters<typeof createPairedNodeWorkerHost>[0]["beforeInvoke"];
    let onChanged: ((event: Changed) => void) | undefined;
    const barriers: Array<{ resolve: () => void }> = [];
    const turnWaits: Promise<unknown>[] = [];
    await runQaGatewayFixture(
      async () => {
        const gateway = await startPairedNodeWorkerGateway({
          owner: gatewayOwner,
          providerBaseUrl: "http://127.0.0.1:1",
          nativeWorkerDeviceId: identity.deviceId,
          requiredProfile: "native",
          mockAuthAgentIds: [],
          mutateConfig: (config) => {
            // The node registry alone owns inference credentials; even QA placeholders
            // must not hide an accidental Gateway inference/auth dependency.
            config.gateway = {
              ...config.gateway,
              nodes: {
                ...config.gateway?.nodes,
                commands: {
                  ...config.gateway?.nodes?.commands,
                  allow: [
                    ...(config.gateway?.nodes?.commands?.allow ?? []),
                    "workspace.skills",
                    "workspace.memory",
                    "file.stat",
                    "file.fetch",
                    "dir.list",
                  ],
                },
              },
            };
            config.plugins = {
              ...config.plugins,
              allow: [...(config.plugins?.allow ?? []), "file-transfer"],
              entries: {
                ...config.plugins?.entries,
                "file-transfer": {
                  enabled: true,
                  config: {
                    policyVersion: 2,
                    workspaces: {
                      qa: { nodeId: identity.deviceId, remoteRoot: remoteAgentWorkspace },
                    },
                    nodes: {
                      [identity.deviceId]: {
                        allowReadPaths: [remoteAgentWorkspace, remoteAgentWorkspace + "/**"],
                        allowWritePaths: [],
                        followSymlinks: false,
                        ask: "off",
                      },
                    },
                  },
                },
              },
            };
            delete config.auth;
            for (const modelProvider of Object.values(config.models?.providers ?? {})) {
              delete modelProvider.apiKey;
            }
            return config;
          },
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
            tempParentDir: root,
          },
        });
        const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
        expect(config.cloudWorkers.requiredProfile).toBe("native");
        expect(config.auth).toBeUndefined();
        for (const agentId of ["main", "qa"]) {
          const agentDir = path.join(
            gateway.runtimeEnv.OPENCLAW_STATE_DIR!,
            "agents",
            agentId,
            "agent",
          );
          expect(
            loadAuthProfileStoreWithoutExternalProfiles(agentDir, { inheritedAuthDir: agentDir })
              .profiles,
          ).toEqual({});
        }
        expect(gateway.runtimeEnv.REQUIRED_NATIVE_KEY).toBeUndefined();
        expect(gateway.runtimeEnv.OPENAI_API_KEY).toBeUndefined();
        operator = await connectWireClient({
          gateway,
          role: "operator",
          identity: null,
          onEvent: (event) => {
            if (event.event === "sessions.changed") {
              try {
                onChanged?.(event.payload as Changed);
              } catch (error) {
                observationFailure.reject(error);
              }
            }
          },
        });
        expect(await operator.request("sessions.subscribe", {})).toMatchObject({
          subscribed: true,
        });
        // Node and Gateway have independent agent rosters; the configured path maps qa to node main.
        const nodeConfig = validateConfigObject({
          agents: { entries: { main: { workspace: remoteAgentWorkspace } } },
          plugins: { allow: ["file-transfer"], entries: { "file-transfer": { enabled: true } } },
        });
        if (!nodeConfig.ok) {
          throw new Error(JSON.stringify(nodeConfig.issues));
        }
        expect(Object.keys(nodeConfig.config.agents?.entries ?? {})).toEqual(["main"]);
        const pluginRuntime = await prepareNodeHostRuntime({
          config: nodeConfig.config,
          env: {
            ...process.env,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
            OPENCLAW_STATE_DIR: path.join(root, "node-state"),
          },
          commands: ["workspace.skills", "workspace.memory", "file.stat", "file.fetch", "dir.list"],
        });
        expect(pluginRuntime.manifest.commands).toContain("workspace.skills");
        node = await createPairedNodeWorkerHost({
          pluginRuntime,
          gateway,
          operator,
          root,
          capacity: 1,
          capacityWaitMs: 0,
          nodeConfig: { ...nodeConfig.config, models: nativeConfig.models },
          beforeInvoke: async (frame, host) => {
            try {
              await beforeInvoke?.(frame, host);
            } catch (error) {
              observationFailure.reject(error);
              throw error;
            }
          },
        });
        expect(node.identity.deviceId).toBe(identity.deviceId);
        const describe = async (key: string) =>
          (await operator!.request<{ session: Session }>("sessions.describe", { key })).session;
        const history = (key: string) =>
          operator!.request<{
            messages: unknown[];
            pendingInputs: { items: Array<{ runId?: string; state: string; queued?: boolean }> };
          }>("chat.history", { sessionKey: key });
        const wait = (runId: string) => {
          const pending = operator!
            .request<AgentJobTerminalSnapshot>(
              "agent.wait",
              { runId, timeoutMs: PROOF_TIMEOUT_MS },
              { timeoutMs: PROOF_TIMEOUT_MS + 5000 },
            )
            .then((result) => {
              record("agent.wait-terminal", { runId, ...result });
              if (result.status !== "ok") {
                console.info(
                  "required-native-dispatch-error",
                  gateway
                    .logs()
                    .split("\n")
                    .filter((line) => /workspace|skills|not allowed|POLICY_DENIED/i.test(line))
                    .join("\n"),
                );
                observationFailure.reject(new Error("agent.wait: " + JSON.stringify(result)));
              }
              return result;
            });
          turnWaits.push(pending);
          void pending.catch((error: unknown) => observationFailure.reject(error));
          return pending;
        };
        const send = async (key: string, marker: string) => {
          const result = await operator!.request("chat.send", {
            sessionKey: key,
            message: "Hello. Reply exactly: " + marker,
            deliver: false,
            idempotencyKey: marker,
          });
          expect(result).toMatchObject({ runId: marker, status: "started" });
          return result;
        };
        let pair = 0;
        for (const creation of ["implicit-main", "ordinary-create"] as const) {
          const key =
            creation === "implicit-main" ? "agent:qa:main" : "agent:qa:required-native-created";
          if (creation === "ordinary-create") {
            await operator.request(
              "sessions.create",
              { key, agentId: "qa" },
              { timeoutMs: PROOF_TIMEOUT_MS },
            );
          }
          let retained: ReturnType<typeof readSettlement>["placement"];
          for (const timing of ["after-agent-wait", "during-workspace-finish"] as const) {
            const markers = {
              A: "REQUIRED-NATIVE-" + pair + "-A",
              B: "REQUIRED-NATIVE-" + pair + "-B",
            };
            pair += 1;
            const atQuiesce = createDeferred();
            const continueQuiesce = createDeferred();
            const atResume = createDeferred();
            const continueResume = createDeferred();
            const changedClear = createDeferred();
            const bEntered = createDeferred();
            barriers.push(continueQuiesce, continueResume);
            let aClaim: string | undefined;
            let aRun: string | undefined;
            let bRun: string | undefined;
            let aDone = false;
            let sawPending = false;
            let finishReleased = false;
            let sawClear = false;
            let quiesced = false;
            let resumed = false;
            onChanged = (event) => {
              if ((event.sessionKey ?? event.session?.key) !== key) {
                return;
              }
              const placement = event.session?.placement;
              record("sessions.changed-snapshot", {
                creation,
                timing,
                phase: event.phase,
                reason: event.reason,
                state: placement?.state,
                reconciling: placement?.workspaceResultReconciling,
              });
              if (placement?.workspaceResultReconciling) {
                if (!sawPending) {
                  record("finishing-ACK-pending-publication", {
                    creation,
                    timing,
                    state: readSettlement(gateway, key),
                  });
                }
                sawPending = true;
              } else if (finishReleased && !sawClear && placement?.state === "active") {
                const settled = readSettlement(gateway, key);
                expect(settled.pending?.claim_id).not.toBe(aClaim);
                expect(settled.placement?.turn_claim_id).not.toBe(aClaim);
                sawClear = true;
                record("sessions.changed-clear", { creation, timing });
                changedClear.resolve();
              }
            };
            beforeInvoke = async (frame, host) => {
              if (frame.command !== NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
                return;
              }
              const input = parseNodeWorkerWorkspaceExecInput(frame.paramsJSON);
              if (
                input.argv[2] !== REMOTE_WORKSPACE_QUIESCE_JS &&
                input.argv[2] !== REMOTE_WORKSPACE_RESUME_JS
              ) {
                return;
              }
              // Ordinary node workspaces carry physical sessionId; sessionKey is
              // present only for prepared-workspace transport binding.
              if (input.sessionId !== readSettlement(gateway, key).placement?.session_id) {
                return;
              }
              if (!quiesced && input.argv[2] === REMOTE_WORKSPACE_QUIESCE_JS) {
                quiesced = true;
                const state = readSettlement(gateway, key);
                aClaim = state.placement?.turn_claim_id ?? undefined;
                aRun = state.placement?.turn_claim_run_id ?? undefined;
                expect(state.pending).toMatchObject({
                  claim_id: aClaim,
                  run_id: aRun,
                  workspace_accepted_at_ms: null,
                  staged_result_ref: null,
                });
                expect(state.placement?.last_transcript_ack_cursor).toBeGreaterThan(0);
                expect(state.placement?.last_live_event_ack_cursor).toBeGreaterThan(0);
                const launch = host.frames
                  .filter((item) => item.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND)
                  .map((item) => parseNodeWorkerLaunchInput(item.paramsJSON))
                  .findLast((item) => item.descriptor.assignment.runId === aRun)!;
                expect(launch.descriptor.assignment.inference).toBe("runtime-local");
                expect(await host.supervisor.status(launch.launchId)).toMatchObject({
                  state: "completed",
                  runId: aRun,
                });
                record("A-finishing-ACK-and-physical-receipt", { creation, timing, state });
                atQuiesce.resolve();
                await continueQuiesce.promise;
              } else if (!resumed && input.argv[2] === REMOTE_WORKSPACE_RESUME_JS) {
                resumed = true;
                const state = readSettlement(gateway, key);
                expect(state.pending).toMatchObject({
                  claim_id: aClaim,
                  run_id: aRun,
                  staged_result_ref: expect.any(String),
                  workspace_accepted_at_ms: expect.any(Number),
                });
                record("A-staged-and-accepted", { creation, timing, state });
                atResume.resolve();
                await continueResume.promise;
              }
            };
            onNativeRequest = (marker) => {
              record("native-HTTP-entry", { marker });
              if (marker !== markers.B) {
                return;
              }
              const state = readSettlement(gateway, key);
              expect(state.pending).toBeUndefined();
              expect(state.placement?.turn_claim_id).not.toBe(aClaim);
              expect(state.placement?.last_transcript_ack_cursor).toBeGreaterThan(0);
              if (retained) {
                expect(state.placement?.environment_id).toBe(retained.environment_id);
              }
              bRun = state.placement?.turn_claim_run_id ?? undefined;
              expect(bRun).toBeTruthy();
              record("B-after-A-atomic-clear", { admittedRunId: markers.B, ...state });
              bEntered.resolve();
            };
            await send(key, markers.A);
            const aWait = wait(markers.A).then((value) => {
              aDone = true;
              if (value.status !== "ok") {
                observationFailure.reject(new Error("A agent.wait: " + JSON.stringify(value)));
              }
              return value;
            });
            turnWaits.push(aWait);
            void aWait.catch(() => undefined);
            await checkpoint(
              atQuiesce.promise,
              "A never reached physical terminal receipt / quiescence",
            );
            const current = await describe(key);
            record("A-sessions.describe-pending", {
              creation,
              timing,
              sessionId: current.sessionId,
              placement: current.placement,
            });
            expect(current.placement).toMatchObject({
              state: "active",
              workspaceResultReconciling: true,
            });
            const committed = await history(key);
            record("A-chat.history-committed", {
              creation,
              timing,
              messages: committed.messages.length,
            });
            expect(
              committed.messages.some((message) => wireMessageText(message) === markers.A),
            ).toBe(true);
            expect(aDone).toBe(false);
            const placed = readSettlement(gateway, key).placement!;
            if (retained) {
              expect(placed.session_id).toBe(retained.session_id);
              expect(placed.environment_id).toBe(retained.environment_id);
              expect(placed.last_transcript_ack_cursor).toBeGreaterThan(
                retained.last_transcript_ack_cursor!,
              );
              expect(placed.last_live_event_ack_cursor).toBeGreaterThan(
                retained.last_live_event_ack_cursor!,
              );
            }
            // An owned empty worktree has a real HEAD, but no source origin or user files.
            const workspace = current.workspaceDir!;
            expect(workspace).toBeTruthy();
            const git = async (...args: string[]) =>
              (await execFileAsync("git", ["-C", workspace, ...args])).stdout.trim();
            expect(await git("rev-parse", "HEAD")).toMatch(/^[a-f0-9]{40,64}$/u);
            expect(await git("remote")).toBe("");
            expect(await git("ls-tree", "-r", "--name-only", "HEAD")).toBe("");
            if (timing === "during-workspace-finish") {
              await send(key, markers.B);
              expect(requests).not.toContain(markers.B);
              const pendingInput = readPendingInput(gateway, key, markers.B);
              expect(pendingInput).toMatchObject({
                found: true,
                value: { state: "queued", session_id: placed.session_id, run_id: markers.B },
              });
              const pendingHistory = (await history(key)).pendingInputs;
              record("B-public-pending-input", {
                creation,
                timing,
                items: pendingHistory.items.map(({ runId, state, queued }) => ({
                  runId,
                  state,
                  queued,
                })),
              });
              expect(pendingHistory.items).toContainEqual(
                // queued is an optional in-memory chatQueuedTurns hint. The
                // canonical queued receipt, then actual native HTTP entry, own this proof.
                expect.objectContaining({ runId: markers.B, state: "queued" }),
              );
              record("B-durable-pending-input", pendingInput);
            }
            continueQuiesce.resolve();
            await checkpoint(atResume.promise, "A never staged/accepted its workspace result");
            expect(aDone).toBe(false);
            finishReleased = true;
            continueResume.resolve();
            expect(await aWait).toMatchObject({ status: "ok" });
            record("A-agent.wait", { creation, timing });
            await checkpoint(changedClear.promise, "settled placement never published clear");
            if (timing === "after-agent-wait") {
              const settled = readSettlement(gateway, key);
              expect(settled.pending).toBeUndefined();
              expect(settled.placement?.turn_claim_id).toBeNull();
              const described = await describe(key);
              expect(described.placement).toMatchObject({ state: "active" });
              expect(described.placement?.workspaceResultReconciling).not.toBe(true);
              retained = settled.placement;
              await send(key, markers.B);
            }
            await checkpoint(bEntered.promise, "B never entered native HTTP on retained session");
            // A queued follow-up has its own execution runId. The original chat.send
            // id owns queue cancellation and returns "pending" until adoption settles.
            // Wait on the exact real claim observed at native HTTP admission.
            expect(await wait(bRun!)).toMatchObject({ status: "ok" });
            const final = readSettlement(gateway, key);
            expect(final.pending).toBeUndefined();
            expect(final.placement).toMatchObject({
              state: "active",
              turn_claim_id: null,
              session_id: placed.session_id,
              environment_id: placed.environment_id,
            });
            expect(final.placement!.last_transcript_ack_cursor).toBeGreaterThan(
              placed.last_transcript_ack_cursor!,
            );
            expect(final.placement!.last_live_event_ack_cursor).toBeGreaterThan(
              placed.last_live_event_ack_cursor!,
            );
            expect((await describe(key)).placement?.workspaceResultReconciling).not.toBe(true);
            const messages = (await history(key)).messages;
            for (const marker of Object.values(markers)) {
              expect(
                messages.filter((message) => wireMessageText(message) === marker),
              ).toHaveLength(1);
            }
            retained = final.placement;
            await node.waitForWorkersIdle();
            record("pair-settled", { creation, timing, state: final });
          }
        }
        const skillRequests = node.frames
          .filter((frame) => frame.command === "workspace.skills")
          .map((frame) => JSON.parse(frame.paramsJSON!));
        expect(skillRequests.map((request) => request.operation)).toContain("watch");
        expect(skillRequests.map((request) => request.operation)).toContain("discovery");
        expect(JSON.stringify(skillRequests)).not.toContain("worktree-sources");
        await node.stopPluginCommands();
        await node.waitForInvokes();
        expect(requests).toHaveLength(8);
        expect(providerErrors).toEqual([]);
        expect(node.invokeErrors).toEqual([]);
        expect(await node.supervisor.hasActiveWork()).toBe(false);
        record("proof-complete", { requests, pairs: 4, sameNode: node.identity.deviceId });
      },
      async () => {
        for (const barrier of barriers) {
          barrier.resolve();
        }
        await Promise.allSettled(turnWaits);
        await node?.stop();
      },
      async () => {
        await operator?.stopAndWait({ timeoutMs: 2000 });
      },
      () => stopQaGatewayFixture(gatewayOwner),
      async () => {
        await Promise.allSettled(turnWaits);
      },
      () => closeWireServer(provider),
    );
    record("cleanup-complete", { nodeStopped: true, gatewayStopped: true, providerClosed: true });
  },
  PROOF_TIMEOUT_MS + 180_000,
);

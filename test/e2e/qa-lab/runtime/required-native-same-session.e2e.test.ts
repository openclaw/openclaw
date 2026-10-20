import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../../../src/agents/auth-profiles/store-runtime.js";
import type { ModelProviderConfig } from "../../../../src/config/types.models.js";
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
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
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

const execFileAsync = promisify(execFile);
const [providerId, modelId] = MODEL_REF.split("/");
const REPLY_MARKER = /Hello\. Reply exactly: (REQUIRED-NATIVE-[0-9]+-[AB])/u;
const QUIESCENCE_NONCE = "0".repeat(32);
const workspaceCommands = [
  "workspace.skills",
  "workspace.memory",
  "file.stat",
  "file.fetch",
  "dir.list",
];
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
  workspaceDir?: string;
  placement?: { state: string; workspaceResultReconciling?: boolean };
};
type Changed = { sessionKey?: string; session?: Session; phase?: string; reason?: string };
type Placement = NonNullable<ReturnType<typeof readSettlement>["placement"]>;

function expectCursorAdvance(current: Placement, previous?: Placement) {
  for (const cursor of ["last_transcript_ack_cursor", "last_live_event_ack_cursor"] as const) {
    expect(current[cursor]).toBeGreaterThan(previous ? previous[cursor]! : 0);
  }
}

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

it.skipIf(process.platform === "win32")(
  "settles required native empty workspaces and same-session follow-ups through public RPC",
  async (context) => {
    const { signal } = context;
    const gatewayOwner = createQaGatewayChild();
    const requests: string[] = [];
    const providerErrors: unknown[] = [];
    const observationFailure = createDeferred<never>();
    // Fail immediately when an asynchronous observer's assertion fails.
    const checkpoint = (promise: PromiseLike<void>) =>
      withinTest(Promise.race([promise, observationFailure.promise]), signal);
    let onNativeRequest: ((marker: string) => void) | undefined;
    let nativeServer: ReturnType<typeof createServer> | undefined;
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    let beforeInvoke: Parameters<typeof createPairedNodeWorkerHost>[0]["beforeInvoke"];
    let onChanged: ((event: Changed) => void) | undefined;
    const barriers: Array<{ resolve: () => void }> = [];
    const turnWaits: Promise<unknown>[] = [];
    await runQaGatewayTestFixture(
      context,
      async ({ createTempDir }) => {
        const root = await realpath(createTempDir("required-native-same-session-"));
        const identity = loadOrCreateDeviceIdentity({
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "node-state") },
        });
        await mkdir(path.join(root, "node-state", "node-host"), { recursive: true, mode: 0o700 });
        const remoteAgentWorkspace = path.join(root, "remote-agent-workspace");
        await writeSkill({
          dir: path.join(remoteAgentWorkspace, "skills", "workspace-proof"),
          name: "workspace-proof",
          description: "Synthetic node-hosted workspace skill",
        });
        const provider = (nativeServer = createServer((request, response) => {
          void (async () => {
            const body = (await json(request)) as {
              messages: Array<{ role: string; content: string }>;
            };
            const marker = body.messages
              .filter((message) => message.role === "user")
              .map((message) => JSON.stringify(message.content).match(REPLY_MARKER)?.[1])
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
              const chunk = {
                id: marker,
                object: "chat.completion.chunk",
                created: 1,
                model: modelId,
                choices: [{ index: 0, delta, finish_reason }],
              };
              response.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            response.end("data: [DONE]\n\n");
          })().catch((error: unknown) => {
            providerErrors.push(error);
            observationFailure.reject(error);
            response.destroy();
          });
        }));
        await new Promise<void>((resolve, reject) => {
          provider.once("error", reject);
          provider.listen(0, "127.0.0.1", resolve);
        });
        const address = provider.address();
        if (!address || typeof address === "string") {
          throw new Error("missing native provider address");
        }
        const nativeProvider: ModelProviderConfig = {
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
        };
        const gateway = await startPairedNodeWorkerGateway({
          owner: gatewayOwner,
          providerBaseUrl: "http://127.0.0.1:1",
          nativeWorkerDeviceId: identity.deviceId,
          requiredProfile: "native",
          mockAuthAgentIds: [],
          mutateConfig: (config) => {
            const commands = (((config.gateway ??= {}).nodes ??= {}).commands ??= {});
            commands.allow = [...(commands.allow ?? []), ...workspaceCommands];
            const plugins = (config.plugins ??= {});
            plugins.allow = [...(plugins.allow ?? []), "file-transfer"];
            (plugins.entries ??= {})["file-transfer"] = {
              enabled: true,
              config: {
                policyVersion: 2,
                workspaces: {
                  qa: { nodeId: identity.deviceId, remoteRoot: remoteAgentWorkspace },
                },
                nodes: {
                  [identity.deviceId]: {
                    allowReadPaths: [remoteAgentWorkspace, remoteAgentWorkspace + "/**"],
                    ask: "off",
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
            `agents/${agentId}/agent`,
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
        const pluginRuntime = await prepareNodeHostRuntime({
          config: nodeConfig.config,
          env: {
            ...process.env,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
            OPENCLAW_STATE_DIR: path.join(root, "node-state"),
          },
          commands: workspaceCommands,
        });
        node = await createPairedNodeWorkerHost({
          pluginRuntime,
          gateway,
          operator,
          root,
          capacity: 1,
          nodeConfig: {
            ...nodeConfig.config,
            models: { providers: { [providerId!]: nativeProvider } },
          },
          beforeInvoke: async (frame, host) => {
            try {
              await beforeInvoke?.(frame, host);
            } catch (error) {
              observationFailure.reject(error);
              throw error;
            }
          },
        });
        const describe = async (key: string) =>
          (await operator!.request<{ session: Session }>("sessions.describe", { key })).session;
        const history = (key: string) =>
          operator!.request<{
            messages: unknown[];
            pendingInputs: { items: Array<{ runId?: string; state: string; queued?: boolean }> };
          }>("chat.history", { sessionKey: key });
        const wait = (runId: string) => {
          const pending = operator!.request<AgentJobTerminalSnapshot>(
            "agent.wait",
            { runId, timeoutMs: PROOF_TIMEOUT_MS },
            { timeoutMs: PROOF_TIMEOUT_MS + 5000 },
          );
          turnWaits.push(pending);
          void pending.catch((error: unknown) => observationFailure.reject(error));
          return pending;
        };
        const send = async (key: string, marker: string) => {
          await expect(
            operator!.request("chat.send", {
              sessionKey: key,
              message: "Hello. Reply exactly: " + marker,
              deliver: false,
              idempotencyKey: marker,
            }),
          ).resolves.toMatchObject({ runId: marker, status: "started" });
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
            const bWorkspaceSettled = createDeferred();
            barriers.push(continueQuiesce, continueResume);
            let aClaim: string | undefined;
            let aRun: string | undefined;
            let bRun: string | undefined;
            let finishReleased = false;
            let sawClear = false;
            const observedPhases = { acquire: false, release: false };
            onChanged = (event) => {
              if ((event.sessionKey ?? event.session?.key) !== key) {
                return;
              }
              const placement = event.session?.placement;
              if (event.phase === "error" || event.reason === "chat.dispatch-error") {
                // Queued follow-up execution IDs are not known until native HTTP entry.
                throw new Error(
                  `${creation} ${timing} run failed before settlement: ${JSON.stringify({
                    phase: event.phase,
                    reason: event.reason,
                  })}\n${gateway.logs().slice(-12_000)}`,
                );
              }
              if (bRun && placement?.state === "active" && !placement.workspaceResultReconciling) {
                // A delayed snapshot from A cannot prove that B released its workspace.
                const current = readSettlement(gateway, key);
                if (!current.pending && current.placement?.turn_claim_id === null) {
                  bWorkspaceSettled.resolve();
                }
              }
              if (
                !placement?.workspaceResultReconciling &&
                finishReleased &&
                !sawClear &&
                placement?.state === "active"
              ) {
                const settled = readSettlement(gateway, key);
                expect(settled.pending?.claim_id).not.toBe(aClaim);
                expect(settled.placement?.turn_claim_id).not.toBe(aClaim);
                sawClear = true;
                changedClear.resolve();
              }
            };
            beforeInvoke = async (frame, host) => {
              if (frame.command !== NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
                return;
              }
              const input = parseNodeWorkerWorkspaceExecInput(frame.paramsJSON);
              const script = input.argv[2];
              const phase = script === REMOTE_WORKSPACE_QUIESCE_JS ? "acquire" : "release";
              if (
                (script !== REMOTE_WORKSPACE_QUIESCE_JS && script !== REMOTE_WORKSPACE_RESUME_JS) ||
                observedPhases[phase]
              ) {
                return;
              }
              // Ordinary node workspaces bind physical sessionId, not sessionKey.
              if (input.sessionId !== readSettlement(gateway, key).placement?.session_id) {
                return;
              }
              observedPhases[phase] = true;
              const state = readSettlement(gateway, key);
              const acquiring = phase === "acquire";
              if (acquiring) {
                aClaim = state.placement?.turn_claim_id ?? undefined;
                aRun = state.placement?.turn_claim_run_id ?? undefined;
              }
              expect(state.pending).toMatchObject({
                claim_id: aClaim,
                run_id: aRun,
                staged_result_ref: null,
                workspace_accepted_at_ms: acquiring ? null : expect.any(Number),
              });
              if (acquiring) {
                expectCursorAdvance(state.placement!);
                const launch = host.frames
                  .filter((item) => item.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND)
                  .map((item) => parseNodeWorkerLaunchInput(item.paramsJSON))
                  .findLast((item) => item.descriptor.assignment.runId === aRun)!;
                expect(launch.descriptor.assignment.inference).toBe("runtime-local");
                expect(await host.supervisor.status(launch.launchId)).toMatchObject({
                  state: "completed",
                  runId: aRun,
                });
              }
              (acquiring ? atQuiesce : atResume).resolve();
              await (acquiring ? continueQuiesce : continueResume).promise;
            };
            onNativeRequest = (marker) => {
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
              bEntered.resolve();
            };
            await send(key, markers.A);
            const aWait = wait(markers.A);
            await checkpoint(atQuiesce.promise);
            expect(await aWait).toMatchObject({ status: "ok" });
            const current = await describe(key);
            expect(current.placement).toMatchObject({
              state: "active",
              workspaceResultReconciling: true,
            });
            expect((await history(key)).messages.map(wireMessageText)).toContain(markers.A);
            const placed = readSettlement(gateway, key).placement!;
            if (retained) {
              expect(placed).toMatchObject({
                session_id: retained.session_id,
                environment_id: retained.environment_id,
              });
              expectCursorAdvance(placed, retained);
            }
            // An owned empty worktree has a real HEAD, but no source origin or user files.
            const workspace = current.workspaceDir!;
            const git = async (...args: string[]) =>
              (await execFileAsync("git", ["-C", workspace, ...args])).stdout.trim();
            expect(await git("rev-parse", "HEAD")).toMatch(/^[a-f0-9]{40,64}$/u);
            expect(await git("remote")).toBe("");
            expect(await git("ls-tree", "-r", "--name-only", "HEAD")).toBe("");
            if (timing === "during-workspace-finish") {
              await send(key, markers.B);
              expect(requests).not.toContain(markers.B);
              expect(readPendingInput(gateway, key, markers.B)).toMatchObject({
                found: true,
                value: { state: "queued", session_id: placed.session_id, run_id: markers.B },
              });
              expect((await history(key)).pendingInputs.items).toContainEqual(
                expect.objectContaining({ runId: markers.B, state: "queued" }),
              );
            }
            continueQuiesce.resolve();
            await checkpoint(atResume.promise);
            finishReleased = true;
            continueResume.resolve();
            await checkpoint(changedClear.promise);
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
            await checkpoint(bEntered.promise);
            // Wait on the adopted execution claim, not chat.send's queue-cancellation ID.
            expect(await wait(bRun!)).toMatchObject({ status: "ok" });
            await checkpoint(bWorkspaceSettled.promise);
            const final = readSettlement(gateway, key);
            expect(final.pending).toBeUndefined();
            expect(final.placement).toMatchObject({
              state: "active",
              turn_claim_id: null,
              session_id: placed.session_id,
              environment_id: placed.environment_id,
            });
            expectCursorAdvance(final.placement!, placed);
            expect((await describe(key)).placement?.workspaceResultReconciling).not.toBe(true);
            const messages = (await history(key)).messages.map(wireMessageText);
            for (const marker of Object.values(markers)) {
              expect(messages.filter((message) => message === marker)).toHaveLength(1);
            }
            retained = final.placement;
            await node.waitForWorkersIdle();
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
      () => (nativeServer ? closeWireServer(nativeServer) : undefined),
    );
  },
  PROOF_TIMEOUT_MS + 180_000,
);

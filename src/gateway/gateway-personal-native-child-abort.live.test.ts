// Opt-in native witness: real personal ingress, real Codex children, fixture-owned barriers.
import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { createServer } from "node:tls";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { bundledPluginFileAt } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import type { NativeSubagentsSnapshot } from "../../packages/gateway-protocol/src/index.js";
import type { ModelsListResult } from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { assertGatewayAgentsAdmitted } from "../../test/helpers/gateway-agent-admission.js";
import { withCodexNativeThreadReader } from "../../test/helpers/gateway-codex-harness-native-subagent.js";
import {
  createCodexHarnessLiveInstance,
  createCodexHarnessWorkspace,
  parseCodexHarnessModelKey,
} from "../../test/helpers/gateway-codex-harness.js";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import { buildCodexHarnessAppServerArgs } from "./gateway-codex-harness.live-helpers.js";
import { liveOpenAiApiKeyModels } from "./live-openai-models.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const describeLive =
  isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_HARNESS_PERSONAL_STOP)
    ? describe
    : describe.skip;
const WAIT_MS = 180_000;
const pollOptions = { timeout: WAIT_MS, interval: 250 };
type NativeRecord = Record<string, unknown>;

function records(value: unknown): NativeRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Native history omitted its requested turn/item array");
  }
  return value.flatMap((item) => {
    const record = asOptionalRecord(item);
    return record ? [record] : [];
  });
}

function nativeThread(value: unknown, threadId: string): NativeRecord {
  const thread = asOptionalRecord(asOptionalRecord(value)?.thread);
  if (!thread || thread.id !== threadId) {
    throw new Error("Native history did not return the requested fixture thread");
  }
  return thread;
}

describeLive("gateway live (personal native descendant Stop)", () => {
  it("stops Alice's parent and native child from her second device while preserving Bob's child", async ({
    signal,
    annotate,
  }) => {
    // A selected witness must fail at preparation, never silently report a skipped live case.
    if (process.env.OPENCLAW_LIVE_CODEX_HARNESS_AUTH !== "api-key") {
      throw new Error("This native witness requires OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key");
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("This native witness requires the approved live OPENAI_API_KEY");
    }
    const modelKey = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL?.trim();
    if (!modelKey || parseCodexHarnessModelKey(modelKey).provider !== "openai") {
      throw new Error("Set OPENCLAW_LIVE_CODEX_HARNESS_MODEL to the approved openai model");
    }
    const thinkingText = process.env.OPENCLAW_LIVE_CODEX_HARNESS_THINKING;
    const thinking = thinkingText ? normalizeThinkLevel(thinkingText) : undefined;
    if (thinkingText && !thinking) {
      throw new Error("Invalid OPENCLAW_LIVE_CODEX_HARNESS_THINKING");
    }
    const codexPackage = bundledPluginFileAt(
      path.resolve(import.meta.dirname, "../.."),
      "codex",
      "package.json",
    );
    const codexCommand = createRequire(codexPackage).resolve("@openai/codex/bin/codex.js");
    const nativeArgs = buildCodexHarnessAppServerArgs([]);
    const instance = await createCodexHarnessLiveInstance(`test-${randomUUID()}`, "api-key");
    const clients: GatewayClient[] = [];
    const sockets = new Set<net.Socket>();
    const releases: string[] = [];
    const starts = new Map<
      string,
      {
        thread: ReturnType<typeof createDeferred<string>>;
        ended: AbortController;
        key: string;
        yielded: boolean;
      }
    >();
    let frontClaim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
    const front = createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM }, (socket) => {
      const upstream = net.connect(instance.port, "127.0.0.1");
      for (const stream of [socket, upstream]) {
        sockets.add(stream);
        stream.on("close", () => sockets.delete(stream));
        stream.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
      }
      socket.pipe(upstream).pipe(socket);
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    await runQaGatewayFixture(
      async () => {
        instance.state.applyEnv();
        delete instance.env.OPENCLAW_GATEWAY_TOKEN;
        delete instance.env.CODEX_API_KEY;
        delete instance.env.OPENCLAW_CODEX_APP_SERVER_BIN;
        delete instance.env.OPENCLAW_CODEX_APP_SERVER_ARGS;
        const workspace = instance.state.workspaceDir;
        await createCodexHarnessWorkspace(workspace);
        const scopes: OperatorScope[] = ["operator.read", "operator.write"];
        const config: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: instance.port,
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                allowUsers: ["alice@native-stop.example.test", "bob@native-stop.example.test"],
                allowLoopback: true,
                deviceAutoApprove: { enabled: true, scopes },
              },
            },
            trustedProxies: ["127.0.0.1"],
            controlUi: { enabled: false, allowedOrigins: ["https://native-stop.example.test"] },
            roles: {
              default: "writer",
              definitions: {
                writer: { sessions: { others: "write" }, agents: "*", scopes },
              },
            },
          },
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              utilityModel: "",
              timeoutSeconds: 600,
              maxConcurrent: 4,
              subagents: { maxConcurrent: 2, maxChildrenPerAgent: 1 },
              model: { primary: modelKey },
              models: { [modelKey]: { agentRuntime: { id: "codex" } } },
              ...(thinking ? { thinkingDefault: thinking } : {}),
              sandbox: { mode: "off" },
            },
            entries: { dev: { workspace } },
          },
          plugins: {
            allow: ["codex"],
            slots: { memory: "none" },
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    args: nativeArgs,
                    mode: "yolo",
                    homeScope: "agent",
                  },
                },
              },
            },
          },
          secrets: { providers: { default: { source: "env" } } },
          models: liveOpenAiApiKeyModels(),
        };
        await instance.state.writeConfig(config);
        frontClaim = await acquireTestPortBlock({ offsets: [0], signal });
        const frontPort = frontClaim.port;
        await instance.startGateway();
        await new Promise<void>((resolve, reject) => {
          front.once("error", reject);
          front.listen(frontPort, "127.0.0.1", resolve);
        });
        const identities = ["alice-a", "alice-b", "bob"].map((name) =>
          loadOrCreateDeviceIdentity({
            path: instance.state.statePath(
              "test-device-identities",
              name,
              "client",
              "credentials.sqlite",
            ),
          }),
        );
        expect(new Set(identities.map((identity) => identity.deviceId)).size).toBe(3);
        for (const [index, deviceIdentity] of identities.entries()) {
          clients.push(
            await connectGatewayClient({
              url: `wss://127.0.0.1:${frontPort}`,
              tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
              clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              origin: "https://native-stop.example.test",
              scopes,
              caps: ["tool-events"],
              deviceIdentity,
              edgeAuthHeaders: {
                "x-forwarded-user": `${index === 2 ? "bob" : "alice"}@native-stop.example.test`,
                "x-forwarded-for": `203.0.113.${50 + index}`,
                "x-forwarded-proto": "https",
              },
              signal,
              requestTimeoutMs: WAIT_MS,
              onHelloOk: (hello) => expect(hello.auth?.scopes).not.toContain("operator.admin"),
              onEvent: (event) => {
                const payload = asOptionalRecord(event.payload);
                const pending =
                  typeof payload?.runId === "string" ? starts.get(payload.runId) : undefined;
                if (!pending || payload?.sessionKey !== pending.key) {
                  return;
                }
                if (event.event === "agent" && payload?.stream === "codex_app_server.lifecycle") {
                  const data = asOptionalRecord(payload.data);
                  if (data?.phase === "thread_ready" && typeof data.threadId === "string") {
                    pending.thread.resolve(data.threadId);
                  }
                } else if (event.event === "agent" && payload?.stream === "lifecycle") {
                  const data = asOptionalRecord(payload.data);
                  if (
                    data?.phase === "end" &&
                    data.yielded === true &&
                    data.livenessState === "paused" &&
                    data.stopReason === "end_turn" &&
                    data.aborted !== true &&
                    !data.error
                  ) {
                    pending.yielded = true;
                  }
                } else if (
                  event.event === "chat" &&
                  (payload?.state === "error" || payload?.state === "aborted")
                ) {
                  pending.ended.abort(
                    new Error(`Native parent ended with ${payload?.state} before child readiness`),
                  );
                }
              },
            }),
          );
        }
        const [aliceA, aliceB, bob] = clients;
        if (!aliceA || !aliceB || !bob) {
          throw new Error("Missing personal fixture client");
        }
        const profiles = await Promise.all(
          clients.map(
            async (client) =>
              (await client.request<{ profile: { id: string } }>("users.self", {})).profile.id,
          ),
        );
        expect(profiles[0]).toBe(profiles[1]);
        expect(profiles[0]).not.toBe(profiles[2]);
        expect(profiles).not.toContain(GATEWAY_OWNER_PROFILE_ID);
        await assertGatewayAgentsAdmitted(aliceA, ["dev"]);

        const start = async (client: GatewayClient, name: string) => {
          const key = `agent:dev:dashboard:native-stop-${name}-${randomUUID()}`;
          const created = await client.request<{ key: string }>("sessions.create", {
            key,
            agentId: "dev",
            visibility: "shared",
          });
          expect(created.key).toBe(key);
          const expected = parseCodexHarnessModelKey(modelKey);
          const catalog = await client.request<ModelsListResult>("models.list", {
            agentId: "dev",
            sessionKey: key,
          });
          const selected = catalog.models.filter(
            (entry) => entry.id === expected.modelId && entry.provider === expected.provider,
          );
          expect(selected.length > 0, "Configured model is available to the personal caller").toBe(
            true,
          );
          expect(
            selected.some((entry) => entry.agentRuntime?.id === "codex"),
            "Configured native runtime is available",
          ).toBe(true);
          const heartbeat = path.join(workspace, `${name}-heartbeat`);
          const release = path.join(workspace, `${name}-release`);
          const command = path.join(workspace, `${name}-wait.cjs`);
          releases.push(release);
          await fs.writeFile(
            command,
            [
              'const fs = require("node:fs");',
              "let ticks = 0;",
              "const deadline = Date.now() + 600000;",
              "const timer = setInterval(() => {",
              `  fs.writeFileSync(${JSON.stringify(heartbeat + ".pending")}, JSON.stringify({ ticks: ++ticks, threadId: process.env.CODEX_THREAD_ID }));`,
              `  fs.renameSync(${JSON.stringify(heartbeat + ".pending")}, ${JSON.stringify(heartbeat)});`,
              `  if (fs.existsSync(${JSON.stringify(release)})) {`,
              "    clearInterval(timer);",
              '    process.stdout.write("NATIVE-BARRIER-RELEASED\\n");',
              "  } else if (Date.now() > deadline) { process.exit(1); }",
              "}, 100);",
            ].join("\n"),
          );
          const runId = randomUUID();
          const pending = {
            thread: createDeferred<string>(),
            ended: new AbortController(),
            key,
            yielded: false,
          };
          starts.set(runId, pending);
          const setupSignal = AbortSignal.any([
            signal,
            pending.ended.signal,
            AbortSignal.timeout(WAIT_MS),
          ]);
          try {
            expect(
              await client.request("chat.send", {
                sessionKey: key,
                idempotencyKey: runId,
                message: [
                  "This is a synthetic native cancellation test.",
                  "Delegate the following task to one helper and wait for that helper to finish.",
                  `Have the helper run the existing Node.js script at ${JSON.stringify(command)}. It records progress while waiting for the fixture owner to release it. Do not modify the script or create its release file.`,
                  "Stay active until the helper finishes; do not run its script yourself.",
                ].join("\n"),
              }),
            ).toMatchObject({ runId, status: "started" });
            const threadId = await withinTest(pending.thread.promise, setupSignal);
            await waitForFile(heartbeat, setupSignal);
            return { key, runId, threadId, heartbeat, command, pending, client };
          } catch (error) {
            starts.delete(runId);
            throw error;
          }
        };
        const alice = await start(aliceA, "alice");
        const foreign = await start(bob, "bob");
        await withCodexNativeThreadReader(
          {
            command: process.execPath,
            args: [codexCommand, ...nativeArgs],
            codexHome: path.join(resolveAgentDir(config, "dev", instance.env), "codex-home"),
            stateDir: instance.stateDir,
            cwd: workspace,
            env: instance.env,
            requestTimeoutMs: WAIT_MS,
          },
          async (readNativeThread) => {
            const assertRunning = async (parent: typeof alice, childId: string) => {
              await expect
                .poll(async () => {
                  const result = await parent.client.request<{
                    nativeSubagents?: NativeSubagentsSnapshot;
                  }>("sessions.describe", { key: parent.key, includeNativeSubagents: true });
                  const roster = result.nativeSubagents;
                  return (
                    roster?.coverage === "live" &&
                    roster.children.some(
                      (child) => child.id === `codex:${childId}` && child.status === "running",
                    )
                  );
                }, pollOptions)
                .toBe(true);
            };
            const captureChild = async (parent: typeof alice) => {
              let spawned: { id: string; parentTurnId: string } | undefined;
              const inheritedTurnIds = new Set<string>();
              await expect
                .poll(async () => {
                  const thread = nativeThread(
                    await readNativeThread(parent.threadId),
                    parent.threadId,
                  );
                  for (const turn of records(thread.turns)) {
                    if (typeof turn.id === "string") {
                      inheritedTurnIds.add(turn.id);
                    }
                  }
                  const children = records(thread.turns).flatMap((turn) =>
                    records(turn.items).flatMap((item) =>
                      item.type === "subAgentActivity" &&
                      item.kind === "started" &&
                      typeof item.agentThreadId === "string" &&
                      typeof turn.id === "string"
                        ? [{ id: item.agentThreadId, parentTurnId: turn.id }]
                        : [],
                    ),
                  );
                  expect(children.length).toBeLessThanOrEqual(1);
                  spawned = children[0];
                  return children.length;
                }, pollOptions)
                .toBe(1);
              if (!spawned) {
                throw new Error("Native child must belong to an exact spawning parent turn");
              }
              const { id, parentTurnId } = spawned;
              const heartbeat = asOptionalRecord(
                JSON.parse(await fs.readFile(parent.heartbeat, "utf8")),
              );
              expect(heartbeat?.threadId).toBe(id);
              expect(Number.isFinite(heartbeat?.ticks)).toBe(true);
              await assertRunning(parent, id);
              let turnId: string | undefined;
              let observation: unknown;
              try {
                await expect
                  .poll(async () => {
                    const thread = nativeThread(await readNativeThread(id), id);
                    expect(thread.parentThreadId).toBe(parent.threadId);
                    observation = records(thread.turns)
                      .slice(-10)
                      .map((turn) => ({
                        id: turn.id,
                        status: turn.status,
                        startedAt: turn.startedAt,
                        completedAt: turn.completedAt,
                        items: records(turn.items)
                          .slice(-20)
                          .map((item) => ({
                            type: item.type,
                            fixtureCommand:
                              typeof item.command === "string" &&
                              item.command.includes(path.basename(parent.command)),
                          })),
                      }));
                    const unfinished = records(thread.turns).filter(
                      (candidate) =>
                        typeof candidate.id === "string" &&
                        !inheritedTurnIds.has(candidate.id) &&
                        Number.isFinite(candidate.startedAt) &&
                        candidate.completedAt == null &&
                        candidate.status !== "failed" &&
                        candidate.status !== "completed",
                    );
                    expect(
                      unfinished.length,
                      "Exactly one child-owned unfinished native turn",
                    ).toBeLessThanOrEqual(1);
                    turnId = typeof unfinished[0]?.id === "string" ? unfinished[0].id : undefined;
                    return turnId;
                  }, pollOptions)
                  .toBeTypeOf("string");
              } catch (error) {
                const described = await parent.client.request<{
                  nativeSubagents?: NativeSubagentsSnapshot;
                }>("sessions.describe", { key: parent.key, includeNativeSubagents: true });
                throw new Error(
                  `Native barrier turn unavailable: ${JSON.stringify({
                    turns: observation,
                    native: described.nativeSubagents && {
                      coverage: described.nativeSubagents.coverage,
                      children: described.nativeSubagents.children.map((child) => ({
                        id: child.id,
                        status: child.status,
                      })),
                    },
                  })}`,
                  { cause: error },
                );
              }
              if (!turnId) {
                throw new Error("Native child did not expose an active turn");
              }
              await assertRunning(parent, id);
              return { id, turnId, parentTurnId };
            };
            const child = await captureChild(alice);
            const otherChild = await captureChild(foreign);
            expect(child.id).not.toBe(otherChild.id);
            // Cold reads normalize active status but never invent completedAt. The live
            // roster proves activity; this exact turn's real timestamp proves settlement.
            const readTurn = async (threadId: string, turnId: string) => {
              const thread = nativeThread(await readNativeThread(threadId), threadId);
              const turn = records(thread.turns).find((candidate) => candidate.id === turnId);
              if (!turn) {
                throw new Error("Native history omitted the exact observed turn");
              }
              return turn;
            };
            const assertInterrupted = async (threadId: string, turnId: string) => {
              await expect
                .poll(async () => {
                  const turn = await readTurn(threadId, turnId);
                  return turn.status === "interrupted" && Number.isFinite(turn.completedAt);
                }, pollOptions)
                .toBe(true);
            };
            const qualifyParent = async (parent: typeof alice, parentTurnId: string) => {
              let observed: unknown;
              await expect
                .poll(async () => {
                  const turn = await readTurn(parent.threadId, parentTurnId);
                  observed = { status: turn.status, completedAt: turn.completedAt };
                  return (
                    turn.completedAt == null ||
                    ((turn.status === "completed" || turn.status === "interrupted") &&
                      Number.isFinite(turn.completedAt) &&
                      parent.pending.yielded)
                  );
                }, pollOptions)
                .toBe(true);
              return { nativeTurn: observed, hostYielded: parent.pending.yielded };
            };
            const aliceBefore = await qualifyParent(alice, child.parentTurnId);
            const bobBefore = await qualifyParent(foreign, otherChild.parentTurnId);
            const threadTurns = async (id: string) =>
              records(nativeThread(await readNativeThread(id), id).turns);
            const aliceParentTurnIds = (await threadTurns(alice.threadId)).map((turn) => turn.id);
            const aliceChildTurnIds = (await threadTurns(child.id)).map((turn) => turn.id);
            // This is the product's session Stop action, deliberately without a runId.
            expect(await aliceB.request("sessions.abort", { key: alice.key })).toMatchObject({
              status: "aborted",
            });
            await assertInterrupted(child.id, child.turnId);
            const parentAfterStop = await readTurn(alice.threadId, child.parentTurnId);
            expect(Number.isFinite(parentAfterStop.completedAt)).toBe(true);
            expect(
              parentAfterStop.status === "interrupted" ||
                (parentAfterStop.status === "completed" && alice.pending.yielded),
            ).toBe(true);
            await expect
              .poll(async () => {
                const result = await aliceB.request<{
                  session: { abortedLastRun?: boolean; hasActiveRun?: boolean };
                }>("sessions.describe", { key: alice.key });
                return {
                  aborted: result.session.abortedLastRun,
                  active: result.session.hasActiveRun === true,
                };
              }, pollOptions)
              .toEqual({ aborted: true, active: false });
            const stoppedHeartbeat = await fs.readFile(alice.heartbeat, "utf8");
            const assertAliceRemainsStopped = async () => {
              const parentTurns = await threadTurns(alice.threadId);
              const childTurns = await threadTurns(child.id);
              expect(parentTurns.map((turn) => turn.id)).toEqual(aliceParentTurnIds);
              expect(childTurns.map((turn) => turn.id)).toEqual(aliceChildTurnIds);
              expect(
                Number.isFinite(
                  parentTurns.find((turn) => turn.id === child.parentTurnId)?.completedAt,
                ),
              ).toBe(true);
              expect(
                Number.isFinite(childTurns.find((turn) => turn.id === child.turnId)?.completedAt),
              ).toBe(true);
              expect(await fs.readFile(alice.heartbeat, "utf8")).toBe(stoppedHeartbeat);
            };
            await assertAliceRemainsStopped();
            const before = await fs.readFile(foreign.heartbeat, "utf8");
            await expect
              .poll(() => fs.readFile(foreign.heartbeat, "utf8"), pollOptions)
              .not.toBe(before);
            await assertRunning(foreign, otherChild.id);
            expect((await readTurn(otherChild.id, otherChild.turnId)).completedAt == null).toBe(
              true,
            );
            await qualifyParent(foreign, otherChild.parentTurnId);
            await assertAliceRemainsStopped();
            expect(await bob.request("sessions.describe", { key: foreign.key })).not.toMatchObject({
              session: { abortedLastRun: true },
            });
            // Bob's independent same-agent child survives until this explicit owned cleanup.
            expect(await bob.request("sessions.abort", { key: foreign.key })).toMatchObject({
              status: "aborted",
            });
            await assertInterrupted(otherChild.id, otherChild.turnId);
            await assertAliceRemainsStopped();
            await annotate("native-session-stop", {
              body: JSON.stringify({
                alice: {
                  runId: alice.runId,
                  parentThreadId: alice.threadId,
                  parentTurnId: child.parentTurnId,
                  childThreadId: child.id,
                  childTurnId: child.turnId,
                  parentBeforeStop: aliceBefore,
                  parentAfterStop: {
                    status: parentAfterStop.status,
                    completedAt: parentAfterStop.completedAt,
                  },
                  childState: "interrupted",
                  noResurrection: true,
                },
                bob: {
                  runId: foreign.runId,
                  childThreadId: otherChild.id,
                  childTurnId: otherChild.turnId,
                  parentBeforeStop: bobBefore,
                  preservedUntilExplicitStop: true,
                },
                sameAgent: "dev",
                distinctAliceDevices: true,
                stopMethod: "sessions.abort",
                exactRunParameter: false,
              }),
              bodyEncoding: "utf-8",
              contentType: "application/json",
            });
          },
        );
      },
      async () => {
        await Promise.all(releases.map((file) => fs.writeFile(file, "release")));
      },
      async () => {
        await Promise.all(clients.map((client) => client.stopAndWait()));
      },
      async () => {
        for (const socket of sockets) {
          socket.destroy();
        }
        if (front.listening) {
          await new Promise<void>((resolve, reject) => {
            front.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      () => frontClaim?.release(),
      () => instance.cleanup(),
    );
  }, 900_000);
});

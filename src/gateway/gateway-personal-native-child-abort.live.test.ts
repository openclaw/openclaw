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
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { assertGatewayAgentsAdmitted } from "../../test/helpers/gateway-agent-admission.js";
import { withCodexNativeThreadReader } from "../../test/helpers/gateway-codex-harness-native-subagent.js";
import {
  createCodexHarnessLiveInstance,
  createCodexHarnessWorkspace,
  parseCodexHarnessModelKey,
} from "../../test/helpers/gateway-codex-harness.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import { buildCodexHarnessAppServerArgs } from "./gateway-codex-harness.live-helpers.js";
import { liveOpenAiApiKeyModels } from "./live-openai-models.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;
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
    const events: Array<{ event?: string; payload?: unknown }> = [];
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
                    command: codexCommand,
                    args: nativeArgs,
                    mode: "yolo",
                    homeScope: "agent",
                  },
                },
              },
            },
          },
          secrets: { providers: { default: { source: "env" } } },
          tools: { deny: ["sessions_spawn"] },
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
                if (
                  event.event === "agent" &&
                  asOptionalRecord(event.payload)?.stream === "codex_app_server.lifecycle"
                ) {
                  events.push(event);
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
              `  fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks));`,
              `  if (fs.existsSync(${JSON.stringify(release)})) {`,
              "    clearInterval(timer);",
              '    process.stdout.write("NATIVE-BARRIER-RELEASED\\n");',
              "  } else if (Date.now() > deadline) { process.exit(1); }",
              "}, 100);",
            ].join("\n"),
          );
          const runId = randomUUID();
          expect(
            await client.request("chat.send", {
              sessionKey: key,
              idempotencyKey: runId,
              message: [
                "This is a synthetic native cancellation test.",
                "Delegate the following task to one helper and wait for that helper to finish.",
                `Have the helper run the existing Node.js script at ${JSON.stringify(command)}. It waits for the fixture owner to release it. Do not create, edit, or remove files.`,
                "Stay active until the helper finishes; do not run its script yourself.",
              ].join("\n"),
            }),
          ).toMatchObject({ runId, status: "started" });
          await expect
            .poll(() => fs.readFile(heartbeat, "utf8").catch(() => ""), pollOptions)
            .not.toBe("");
          let threadId: string | undefined;
          await expect
            .poll(() => {
              const readyEvent = events.find((event) => {
                const payload = asOptionalRecord(event.payload);
                return (
                  event.event === "agent" &&
                  payload?.runId === runId &&
                  payload.sessionKey === key &&
                  payload.stream === "codex_app_server.lifecycle" &&
                  asOptionalRecord(payload.data)?.phase === "thread_ready"
                );
              });
              const value = asOptionalRecord(asOptionalRecord(readyEvent?.payload)?.data)?.threadId;
              threadId = typeof value === "string" ? value : undefined;
              return threadId;
            }, pollOptions)
            .toBeTypeOf("string");
          if (!threadId) {
            throw new Error("Native parent thread was not observed");
          }
          return { key, runId, threadId, heartbeat, command };
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
            const captureChild = async (parent: typeof alice) => {
              let childId: string | undefined;
              let parentTurnId: string | undefined;
              await expect
                .poll(async () => {
                  const thread = nativeThread(
                    await readNativeThread(parent.threadId),
                    parent.threadId,
                  );
                  const active = records(thread.turns).find((turn) => turn.status === "inProgress");
                  parentTurnId = typeof active?.id === "string" ? active.id : undefined;
                  const children = new Set(
                    records(thread.turns)
                      .flatMap((turn) => records(turn.items))
                      .flatMap((item) =>
                        item.type === "subAgentActivity" &&
                        item.kind === "started" &&
                        typeof item.agentThreadId === "string"
                          ? [item.agentThreadId]
                          : [],
                      ),
                  );
                  expect(children.size).toBeLessThanOrEqual(1);
                  childId = [...children][0];
                  return children.size;
                }, pollOptions)
                .toBe(1);
              if (!childId || !parentTurnId) {
                throw new Error(
                  "Native parent must retain an active turn while its child is working",
                );
              }
              const id = childId;
              const capturedParentTurnId = parentTurnId;
              let turnId: string | undefined;
              await expect
                .poll(async () => {
                  const thread = nativeThread(await readNativeThread(id), id);
                  expect(thread.parentThreadId).toBe(parent.threadId);
                  const turn = records(thread.turns).find(
                    (candidate) => candidate.status === "inProgress",
                  );
                  const ownsBarrier =
                    turn &&
                    records(turn.items).some(
                      (item) =>
                        item.type === "commandExecution" &&
                        typeof item.command === "string" &&
                        item.command.includes(parent.command),
                    );
                  turnId = ownsBarrier && typeof turn?.id === "string" ? turn.id : undefined;
                  return turnId;
                }, pollOptions)
                .toBeTypeOf("string");
              if (!turnId) {
                throw new Error("Native child did not expose an active turn");
              }
              return { id, turnId, parentTurnId: capturedParentTurnId };
            };
            const child = await captureChild(alice);
            const otherChild = await captureChild(foreign);
            expect(child.id).not.toBe(otherChild.id);
            const status = async (threadId: string, turnId: string) => {
              const thread = nativeThread(await readNativeThread(threadId), threadId);
              return records(thread.turns).find((turn) => turn.id === turnId)?.status;
            };
            expect(await status(alice.threadId, child.parentTurnId)).toBe("inProgress");
            expect(await status(foreign.threadId, otherChild.parentTurnId)).toBe("inProgress");
            // This is the product's session Stop action, deliberately without a runId.
            expect(await aliceB.request("sessions.abort", { key: alice.key })).toMatchObject({
              status: "aborted",
            });
            await expect
              .poll(() => status(child.id, child.turnId), pollOptions)
              .toBe("interrupted");
            await expect
              .poll(() => status(alice.threadId, child.parentTurnId), pollOptions)
              .toBe("interrupted");
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
            const before = await fs.readFile(foreign.heartbeat, "utf8");
            await expect
              .poll(() => fs.readFile(foreign.heartbeat, "utf8"), pollOptions)
              .not.toBe(before);
            expect(await status(otherChild.id, otherChild.turnId)).toBe("inProgress");
            expect(await status(foreign.threadId, otherChild.parentTurnId)).toBe("inProgress");
            expect(await bob.request("sessions.describe", { key: foreign.key })).not.toMatchObject({
              session: { abortedLastRun: true },
            });
            // Bob's independent same-agent child survives until this explicit owned cleanup.
            expect(await bob.request("sessions.abort", { key: foreign.key })).toMatchObject({
              status: "aborted",
            });
            await expect
              .poll(() => status(otherChild.id, otherChild.turnId), pollOptions)
              .toBe("interrupted");
            await annotate("native-session-stop", {
              body: JSON.stringify({
                alice: {
                  runId: alice.runId,
                  parentThreadId: alice.threadId,
                  parentTurnId: child.parentTurnId,
                  childThreadId: child.id,
                  childTurnId: child.turnId,
                  state: "interrupted",
                },
                bob: {
                  runId: foreign.runId,
                  childThreadId: otherChild.id,
                  childTurnId: otherChild.turnId,
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

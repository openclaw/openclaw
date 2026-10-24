// Goal Resume must retain operator authority across real process death, not just RPC replay.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  restartEnv,
  restartModelConfig,
  restartProviderServer,
  restartToolNames,
  writeRestartJsonText,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const cases = ["continue", "stop", "revoked"] as const;
type Case = (typeof cases)[number];
const key = (name: Case) => `agent:main:goal-resume-restart-${name}`;
const objective = (name: Case) => `GOAL_RESTART_${name.toUpperCase()}`;
const final = "GOAL_RESUME_RECOVERED_RESULT";

it.skipIf(process.platform === "win32")(
  "recovers Goal effects across crashes but rejects stopped and revoked operators",
  { timeout: 180_000 },
  async (context) => {
    const { signal } = context;
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const reached = cases.map(() => Array.from({ length: 4 }, () => createDeferred()));
    const resumeCalls = { continue: 0, stop: 0, revoked: 0 };
    const release = createDeferred();
    const releaseRevoked = createDeferred();
    const revokedResponseReleased = createDeferred();
    let allowedEffect = "";
    let revokedEffect = "";
    let ordinal = 0;
    const provider = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        restartProviderServer(
          failed,
          async (request, response, body) => {
            expect(request.url).toBe("/v1/responses");
            const input = JSON.stringify(body.input);
            const text = (value: string) => {
              const id = `goal_restart_${++ordinal}`;
              if (body.stream === false) {
                writeRestartJsonText(response, value, id);
              } else {
                writeOpenAiResponsesText(response, {
                  text: value,
                  messageId: `msg_${id}`,
                  responseId: `resp_${id}`,
                });
              }
            };
            if (restartToolNames(body).length === 0) {
              text("Synthetic Goal title");
              return;
            }
            const name = cases.find((candidate) => input.includes(objective(candidate)));
            expect(name, input).toBeDefined();
            if (!name) {
              throw new Error("Unexpected Goal model input");
            }
            if (!input.includes("Continue pursuing the current goal.")) {
              text("Initial Goal work complete.");
              return;
            }
            const count = ++resumeCalls[name];
            expect(count).toBeLessThanOrEqual(name === "continue" ? 4 : name === "revoked" ? 2 : 1);
            reached[cases.indexOf(name)]![count - 1]!.resolve();
            if (count > 1) {
              expect(input).toContain("interrupted by a gateway restart");
            }
            // Release a stale tool response only after its original operator is revoked.
            // The Gateway must cancel it before exec (or any follow-up provider I/O).
            if (name === "revoked" && count === 2) {
              await withinTest(releaseRevoked.promise, signal);
              writeRestartToolCall(
                response,
                name,
                "exec",
                { command: `printf forbidden > ${JSON.stringify(revokedEffect)}` },
                ++ordinal,
              );
              revokedResponseReleased.resolve();
              return;
            }
            // Initial requests and the first recovered request die with their processes.
            if (name !== "continue" || count < 3) {
              return;
            }
            if (count === 3) {
              await withinTest(release.promise, signal);
              writeRestartToolCall(
                response,
                name,
                "exec",
                { command: `printf allowed >> ${JSON.stringify(allowedEffect)}` },
                ++ordinal,
              );
            } else {
              expect(await readFile(allowedEffect, "utf8")).toBe("allowed");
              text(final);
            }
          },
          { ignoreAborted: true },
        ),
    });
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
      .filter(Boolean)
      .join(",");
    const instance = await createOpenClawTestInstance({
      name: "gateway-goal-resume-restart",
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      env: { ...restartEnv, NO_PROXY: noProxy, no_proxy: noProxy, OPENCLAW_NO_RESPAWN: "1" },
    });
    instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
    allowedEffect = path.join(instance.state.workspaceDir, "allowed-effect");
    revokedEffect = path.join(instance.state.workspaceDir, "revoked-effect");
    const revokedIdentity = loadOrCreateDeviceIdentity({
      path: instance.state.path("revoked-device", "client", "credentials.sqlite"),
    });
    const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${provider.claim.port}/v1`);
    await instance.state.writeConfig({
      update: { checkOnStart: false },
      browser: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      plugins: { enabled: false },
      logging: { file: path.join(instance.state.root, "gateway.log") },
      ...restartModelConfig(
        model,
        instance.state.workspaceDir,
        {},
        { catalogRefresh: { enabled: false } },
      ),
      tools: {
        allow: ["exec"],
        codeMode: { enabled: false },
        exec: { host: "gateway", security: "full", ask: "off" },
      },
      gateway: {
        mode: "local",
        controlUi: { enabled: false },
        bind: "loopback",
        port: instance.port,
        auth: { mode: "token", token: instance.gatewayToken },
      },
    });
    let client: GatewayClient | undefined;
    let revokedClient: GatewayClient | undefined;
    const pids: number[] = [];
    const race = <T>(work: Promise<T>) => withinTest(Promise.race([work, failed.promise]), signal);
    const rows = async () =>
      (await client!.request<SessionsListResult>("sessions.list", { agentId: "main" })).sessions;
    const row = async (name: Case) => (await rows()).find((entry) => entry.key === key(name));
    const connect = async () => {
      client = await connectRestartClient(instance, { mode: "test" }, signal);
      expect(instance.child?.pid).toBeTypeOf("number");
      pids.push(instance.child!.pid!);
    };
    context.onTestFailed(() => {
      console.error(JSON.stringify({ pids, resumeCalls }));
      console.error(instance.logs().replaceAll(instance.gatewayToken, "[fixture token]"));
    });
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        await connect();
        revokedClient = await connectRestartClient(
          instance,
          { mode: "test", deviceIdentity: revokedIdentity },
          signal,
        );
        const identities = new Map<Case, { sessionId: string; goalId: string }>();
        for (const name of cases) {
          const operator = name === "revoked" ? revokedClient : client;
          await operator!.request("sessions.create", {
            key: key(name),
            agentId: "main",
            permissionMode: "full",
          });
          const accepted = await operator!.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: key(name),
              message: objective(name),
              idempotencyKey: randomUUID(),
              intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
            },
            { expectFinal: false },
          );
          expect(
            await client!.request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 }),
          ).toMatchObject({ status: "ok" });
          await race(
            vi.waitFor(
              async () =>
                expect(await row(name)).toMatchObject({
                  hasActiveRun: false,
                  goal: { status: "active" },
                }),
              { timeout: 30_000 },
            ),
          );
          const current = (await row(name))!;
          expect(current.sessionId).toBeTypeOf("string");
          expect(current.goal?.id).toBeTypeOf("string");
          identities.set(name, { sessionId: current.sessionId!, goalId: current.goal!.id });
          await operator!.request("sessions.goal.update", {
            sessionKey: key(name),
            ...identities.get(name),
            action: "complete",
            operationId: randomUUID(),
            issuedAtMs: Date.now(),
          });
          expect(await row(name)).toMatchObject({ goal: { status: "complete" } });
          const resumeRequest = {
            sessionKey: key(name),
            ...identities.get(name),
            action: "resume",
            operationId: randomUUID(),
            issuedAtMs: Date.now(),
          };
          // The row clears before dispatch cleanup; the public API explicitly
          // rejects that short window as retryable. Keep one operation identity.
          const resumed = await race(
            vi.waitFor(
              () =>
                operator!.request("sessions.goal.update", resumeRequest, { expectFinal: false }),
              { timeout: 30_000, interval: 200 },
            ),
          );
          expect(resumed).toMatchObject({ status: "started" });
          await race(reached[cases.indexOf(name)]![0]!.promise);
          expect(await row(name)).toMatchObject({ hasActiveRun: true, goal: { status: "active" } });
        }
        expect(await client!.request("chat.abort", { sessionKey: key("stop") })).toMatchObject({
          aborted: true,
        });
        await race(
          vi.waitFor(
            async () =>
              expect(await row("stop")).toMatchObject({ status: "killed", hasActiveRun: false }),
            { timeout: 30_000 },
          ),
        );
        await revokedClient.stopAndWait();
        revokedClient = undefined;
        for (let restart = 1; restart <= 2; restart++) {
          await client!.stopAndWait();
          client = undefined;
          await instance.crashGateway();
          await instance.startGateway();
          await connect();
          // Readiness alone is not recovery: observe the newly admitted model request.
          await race(reached[0]![restart]!.promise);
          if (restart === 1) {
            await race(reached[2]![1]!.promise);
            expect(await row("revoked")).toMatchObject({ hasActiveRun: true });
            await client!.request("device.token.revoke", {
              deviceId: revokedIdentity.deviceId,
              role: "operator",
            });
            releaseRevoked.resolve();
            await race(revokedResponseReleased.promise);
            await race(
              vi.waitFor(
                async () => expect(await row("revoked")).toMatchObject({ hasActiveRun: false }),
                { timeout: 30_000 },
              ),
            );
            await expect(readFile(revokedEffect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(await row("revoked")).toMatchObject({ hasActiveRun: false });
          }
          expect(await row("continue")).toMatchObject({
            sessionId: identities.get("continue")!.sessionId,
            hasActiveRun: true,
          });
          expect(await row("stop")).toMatchObject({
            sessionId: identities.get("stop")!.sessionId,
            status: "killed",
            hasActiveRun: false,
          });
        }
        release.resolve();
        await race(
          vi.waitFor(
            async () => {
              expect(
                JSON.stringify(
                  await client!.request("chat.history", { sessionKey: key("continue") }),
                ),
              ).toContain(final);
              expect(await row("continue")).toMatchObject({
                hasActiveRun: false,
                status: "done",
                goal: { id: identities.get("continue")!.goalId },
              });
            },
            { timeout: 30_000 },
          ),
        );
        expect(new Set(pids).size).toBe(3);
        expect(resumeCalls).toEqual({ continue: 4, stop: 1, revoked: 2 });
        expect(await readFile(allowedEffect, "utf8")).toBe("allowed");
        await expect(readFile(revokedEffect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        for (const name of ["stop", "revoked"] as const) {
          expect(
            JSON.stringify(await client!.request("chat.history", { sessionKey: key(name) })),
          ).not.toContain(final);
        }
        console.log(
          JSON.stringify({
            proof: "goal-resume-cold-restart",
            pids,
            resumeCalls,
            allowedRecoveredEffect: true,
            revokedEffectAbsent: true,
            entrypoint: await instance.entrypoint(),
            stateRoot: instance.state.root,
            node: process.version,
          }),
        );
      },
      async () => {
        await revokedClient?.stopAndWait();
        await client?.stopAndWait();
      },
      () => instance.cleanup(),
      async () => {
        release.resolve();
        releaseRevoked.resolve();
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
      },
    );
  },
);

// Goal Resume must retain operator authority across real process death, not just RPC replay.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  restartEnv,
  restartModelConfig,
  restartProviderServer,
  restartToolNames,
  writeRestartJsonText,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const cases = ["continue", "stop"] as const;
type Case = (typeof cases)[number];
const key = (name: Case) => `agent:main:goal-resume-restart-${name}`;
const objective = (name: Case) => `GOAL_RESTART_${name.toUpperCase()}`;
const final = "GOAL_RESUME_RECOVERED_RESULT";

it.skipIf(process.platform === "win32")(
  "resumes an operator Goal through two process crashes but never resumes a stopped Goal",
  { timeout: 180_000 },
  async (context) => {
    const { signal } = context;
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const reached = cases.map(() => Array.from({ length: 3 }, () => createDeferred()));
    const resumeCalls = { continue: 0, stop: 0 };
    const release = createDeferred();
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
            expect(count).toBeLessThanOrEqual(3);
            reached[cases.indexOf(name)]![count - 1]!.resolve();
            if (count > 1) {
              expect(input).toContain("interrupted by a gateway restart");
            }
            // The first two requests remain in flight until their owning processes die.
            if (name === "stop" || count < 3) {
              return;
            }
            await withinTest(release.promise, signal);
            if (!response.destroyed) {
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
      tools: { allow: ["exec"], codeMode: { enabled: false } },
      gateway: {
        mode: "local",
        controlUi: { enabled: false },
        bind: "loopback",
        port: instance.port,
        auth: { mode: "token", token: instance.gatewayToken },
      },
    });
    let client: GatewayClient | undefined;
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
        const identities = new Map<Case, { sessionId: string; goalId: string }>();
        for (const name of cases) {
          await client!.request("sessions.create", {
            key: key(name),
            agentId: "main",
            permissionMode: "full",
          });
          const accepted = await client!.request<{ runId: string }>(
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
          await client!.request("sessions.goal.update", {
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
              () => client!.request("sessions.goal.update", resumeRequest, { expectFinal: false }),
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
        for (let restart = 1; restart <= 2; restart++) {
          await client!.stopAndWait();
          client = undefined;
          await instance.crashGateway();
          await instance.startGateway();
          await connect();
          // Readiness alone is not recovery: observe the newly admitted model request.
          await race(reached[0]![restart]!.promise);
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
        expect(resumeCalls).toEqual({ continue: 3, stop: 1 });
        expect(
          JSON.stringify(await client!.request("chat.history", { sessionKey: key("stop") })),
        ).not.toContain(final);
        console.log(
          JSON.stringify({
            proof: "goal-resume-cold-restart",
            pids,
            resumeCalls,
            entrypoint: await instance.entrypoint(),
            stateRoot: instance.state.root,
            node: process.version,
          }),
        );
      },
      async () => client?.stopAndWait(),
      () => instance.cleanup(),
      async () => {
        release.resolve();
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
      },
    );
  },
);

// Load the runtime before starting the bounded Gateway fixture.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

it(
  "keeps the chat's client capabilities when its queued message replays after a restart",
  { timeout: 90_000 },
  async ({ signal }) =>
    withOpenClawTestState(kernelGatewayTestStateOptions("queued-input-restart"), async () => {
      const target = { agentId: "main", sessionKey: "agent:main:dashboard:queued-restart" };
      const restartNotice = "The Gateway restarted while you were working.";
      const answer = "Resumed after restart.";
      const reached = createDeferred();
      let restarted = false;
      const fixture = createChatFixture("queued-input-restart", {
        // A Control UI client records a capability catalog beyond the WebChat default.
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        configure: (cfg) => ({
          ...cfg,
          agents: { defaults: { ...cfg.agents?.defaults, utilityModel: "" } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        }),
        async respond() {
          if (restarted) {
            return answer;
          }
          reached.resolve();
          return undefined; // Keep the first turn live until the Gateway stops it.
        },
      });
      await runQaGatewayFixture(
        async () => {
          await fixture.start();
          expect(
            await fixture.client.request("chat.send", {
              ...target,
              message: "OWNER_RUNNING",
              idempotencyKey: "owner-restart-running",
            }),
          ).toMatchObject({ status: "started" });
          await withinTest(reached.promise, signal);
          await fixture.client.request("chat.send", {
            ...target,
            message: "OWNER_QUEUED",
            queueMode: "followup",
            idempotencyKey: "owner-restart-queued",
          });
          const recorded = (await readSessionEntryReadOnlyInWorker(target))?.clientCapabilities;
          expect(recorded).toContain(GATEWAY_CLIENT_CAPS.APPROVALS);
          const before = fixture.requests.length;
          restarted = true;
          await fixture.restart();
          // The replayed input reports pending until its queued turn starts.
          await vi.waitFor(
            async () =>
              expect(
                await fixture.client.request("agent.wait", {
                  runId: "owner-restart-queued",
                  timeoutMs: 5_000,
                }),
              ).toMatchObject({ status: "ok" }),
            { timeout: 30_000 },
          );
          const history = await fixture.client.request<{ messages: unknown[] }>(
            "chat.history",
            target,
          );
          expect(JSON.stringify(history.messages)).toContain("OWNER_QUEUED");
          expect(JSON.stringify(history.messages)).toContain(answer);
          expect(
            fixture.requests.slice(before).some((body) => body.includes(restartNotice)),
            "running turn resumed",
          ).toBe(true);
          expect((await readSessionEntryReadOnlyInWorker(target))?.clientCapabilities).toEqual(
            recorded,
          );
          expect(fixture.errors).toEqual([]);
        },
        () => fixture.close(),
      );
    }),
);

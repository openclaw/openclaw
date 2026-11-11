import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

type JobView = {
  id: string;
  enabled?: boolean;
  delivery?: Record<string, unknown>;
  state?: Record<string, unknown>;
};

// Real Gateway RPC, cron service, agent runs against a scripted model, command jobs, and
// SQLite conversation history. Each job names its own creator so a deleted creator pauses
// only the job that owns it.
it(
  "routes automation output to a selected conversation through a real Gateway",
  { timeout: 300_000 },
  async () => {
    await withOpenClawTestState(kernelGatewayTestStateOptions("cron-selected-inbox"), async () => {
      const fixture = createChatFixture("cron-selected-inbox", {
        configure: (config) => ({
          ...config,
          // Occurrence admission of agent-less jobs uses the system agent, not the session key.
          agents: {
            ...config.agents,
            ownership: "explicit",
            defaults: { ...config.agents?.defaults, systemAgent: { agentId: "main" } },
            entries: { main: {}, worker: {} },
          },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "coding", codeMode: false, toolSearch: false },
          cron: { enabled: false, triggers: { enabled: false } },
        }),
        respond: async (body) =>
          body.includes("conversationLabelSource")
            ? "Proof"
            : (body.match(/SELECTED_PROOF_[A-Z]+/)?.[0] ?? "UNEXPECTED_PROMPT"),
      });
      await runQaGatewayFixture(
        async () => {
          await fixture.start();
          const rpc = <T = Record<string, unknown>>(method: string, params: object) =>
            fixture.client.request<T>(method, params, { timeoutMs: 90_000 });
          const conversation = async (agentId: string) =>
            (await rpc<{ key: string }>("sessions.create", { agentId })).key;
          const history = async (sessionKey: string) =>
            JSON.stringify(
              (await rpc<{ messages: unknown[] }>("chat.history", { sessionKey })).messages,
            );
          const run = (id: string) =>
            rpc<{ run?: { status?: string; error?: string } }>("cron.run", {
              id,
              mode: "force",
              waitTimeoutMs: 60_000,
            });
          const get = (id: string) => rpc<JobView>("cron.get", { id });
          const notice = { timeout: 30_000 };
          const lastRun = async (id: string) =>
            (await rpc<{ entries: Array<Record<string, unknown>> }>("cron.runs", { id, limit: 1 }))
              .entries[0];
          const base = {
            enabled: false,
            schedule: { kind: "every", everyMs: 86_400_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
          };
          const agentTurn = (token: string) => ({
            kind: "agentTurn",
            message: `Reply with exactly ${token}`,
            toolsAllow: [],
          });
          const failingCommand = { kind: "command", argv: ["sh", "-c", "exit 3"] };

          const creator = await conversation("main");
          const pausedCreator = await conversation("main");
          const inbox = await conversation("main");
          const workerCreator = await conversation("worker");
          const workerInbox = await conversation("worker");

          // Add and read back: the public key is canonical; the captured generation is private.
          const announce = await rpc<JobView>("cron.add", {
            ...base,
            name: "Selected announce",
            agentId: "main",
            sessionKey: creator,
            payload: agentTurn("SELECTED_PROOF_ANNOUNCE"),
            delivery: { mode: "announce", sessionKey: inbox },
          });
          expect(announce.delivery).toEqual({ mode: "announce", sessionKey: inbox });
          expect(JSON.stringify(announce)).not.toContain("deliveryConversation");
          expect((await get(announce.id)).delivery).toEqual({
            mode: "announce",
            sessionKey: inbox,
          });
          expect(JSON.stringify(await get(announce.id))).not.toContain("deliveryConversation");

          // Announce result lands in the selected conversation, not in the creator.
          expect(await run(announce.id)).toMatchObject({ run: { status: "ok" } });
          await expect.poll(() => history(inbox)).toContain("SELECTED_PROOF_ANNOUNCE");
          expect(await history(creator)).not.toContain("SELECTED_PROOF_ANNOUNCE");

          // A reset destination fails closed: no write to its new generation or the creator.
          await rpc("sessions.reset", { key: inbox, reason: "new" });
          expect(await run(announce.id)).toMatchObject({ run: { status: "ok" } });
          expect(await lastRun(announce.id)).toMatchObject({ deliveryStatus: "not-delivered" });
          expect(await history(inbox)).not.toContain("SELECTED_PROOF_ANNOUNCE");
          expect(await history(creator)).not.toContain("SELECTED_PROOF_ANNOUNCE");
          // Selecting the same key again follows the new generation.
          await rpc("cron.update", {
            id: announce.id,
            patch: { delivery: { mode: "announce", sessionKey: inbox } },
          });
          expect(await run(announce.id)).toMatchObject({ run: { status: "ok" } });
          await expect.poll(() => history(inbox)).toContain("SELECTED_PROOF_ANNOUNCE");
          expect(await history(creator)).not.toContain("SELECTED_PROOF_ANNOUNCE");
          // Clearing restores implicit delivery.
          await rpc("cron.update", { id: announce.id, patch: { delivery: { sessionKey: null } } });
          expect((await get(announce.id)).delivery).toEqual({ mode: "announce" });

          // A silent job selected through update stays silent on success.
          // Enabled so its parent pause can disable it; the scheduler itself is off.
          const quiet = await rpc<JobView>("cron.add", {
            ...base,
            enabled: true,
            name: "Selected quiet",
            agentId: "main",
            sessionKey: pausedCreator,
            payload: agentTurn("SELECTED_PROOF_QUIET"),
            delivery: { mode: "none" },
          });
          await rpc("cron.update", {
            id: quiet.id,
            patch: { delivery: { mode: "none", sessionKey: inbox } },
          });
          expect((await get(quiet.id)).delivery).toEqual({ mode: "none", sessionKey: inbox });
          expect(await run(quiet.id)).toMatchObject({ run: { status: "ok" } });
          expect(await lastRun(quiet.id)).toMatchObject({ status: "ok" });
          expect(await history(inbox)).not.toContain("SELECTED_PROOF_QUIET");
          expect(await history(pausedCreator)).not.toContain("SELECTED_PROOF_QUIET");
          // Its safety notice still reaches the selected conversation after its creator is gone.
          await rpc("sessions.delete", { key: pausedCreator });
          expect(await run(quiet.id)).toMatchObject({ run: { status: "skipped" } });
          await expect.poll(() => history(inbox), notice).toContain("Selected quiet");
          expect(await history(inbox)).toContain("is paused");
          expect((await get(quiet.id)).enabled).toBe(false);

          // An explicit alert of a silent job goes to the selected conversation.
          const silentFailure = await rpc<JobView>("cron.add", {
            ...base,
            name: "Selected silent failure",
            agentId: "main",
            sessionKey: creator,
            payload: failingCommand,
            delivery: { mode: "none", sessionKey: inbox },
            failureAlert: { after: 1, cooldownMs: 0 },
          });
          expect(await run(silentFailure.id)).toMatchObject({ run: { status: "error" } });
          await expect.poll(() => history(inbox), notice).toContain("Selected silent failure");
          expect(await history(creator)).not.toContain("Selected silent failure");

          // An explicit "last" failure route wins over the selected conversation.
          const alternate = await rpc<JobView>("cron.add", {
            ...base,
            name: "Selected alternate route",
            agentId: "main",
            sessionKey: creator,
            payload: failingCommand,
            delivery: { mode: "announce", sessionKey: inbox },
            failureAlert: { after: 1, cooldownMs: 0, channel: "last" },
          });
          expect(await run(alternate.id)).toMatchObject({ run: { status: "error" } });
          await expect
            .poll(
              async () => (await get(alternate.id)).state?.lastFailureNotificationDeliveryStatus,
              notice,
            )
            .toBe("not-delivered");
          expect(await history(inbox)).not.toContain("Selected alternate route");
          expect(await history(creator)).not.toContain("Selected alternate route");

          // An agent-less command job delivers as the agent named by its session key.
          const worker = await rpc<JobView>("cron.add", {
            ...base,
            name: "Selected worker",
            sessionKey: workerCreator,
            payload: { kind: "command", argv: ["printf", "SELECTED_PROOF_WORKER"] },
            delivery: { mode: "announce", sessionKey: workerInbox },
          });
          const workerRun = await run(worker.id);
          expect(workerRun, JSON.stringify(workerRun.run)).toMatchObject({ run: { status: "ok" } });
          await expect.poll(() => history(workerInbox)).toContain("SELECTED_PROOF_WORKER");
          expect(await history(workerCreator)).not.toContain("SELECTED_PROOF_WORKER");
          expect(await history(inbox)).not.toContain("SELECTED_PROOF_WORKER");
          expect(fixture.errors).toEqual([]);
        },
        () => fixture.close(),
      );
    });
  },
);

it.each(["current", "persistent"] as const)(
  "delivers a selected result from %s through its actual execution route",
  async (target) => {
    await withOpenClawTestState(kernelGatewayTestStateOptions("cron-selected-shared"), async () => {
      const fixture = createChatFixture("cron-selected-shared", {
        configure: (config) => ({
          ...config,
          plugins: { slots: { memory: "none" } },
          cron: { enabled: false, triggers: { enabled: false } },
        }),
        respond: async (body) =>
          body.includes("conversationLabelSource") ? "Proof" : "SELECTED_SHARED_PROOF",
      });
      await runQaGatewayFixture(
        async () => {
          await fixture.start();
          const rpc = <T = Record<string, unknown>>(method: string, params: object) =>
            fixture.client.request<T>(method, params, { timeoutMs: 90_000 });
          const execution = (await rpc<{ key: string }>("sessions.create", { agentId: "main" }))
            .key;
          const inbox = (await rpc<{ key: string }>("sessions.create", { agentId: "main" })).key;
          const history = async (sessionKey: string) =>
            JSON.stringify(
              (
                await rpc<{
                  messages: Array<{ role?: string; model?: string; content?: unknown }>;
                }>("chat.history", { sessionKey })
              ).messages.filter(
                (message) => message.role === "assistant" && message.model === "automation-result",
              ),
            );
          const job = await rpc<JobView>("cron.add", {
            name: "Selected shared session",
            agentId: "main",
            enabled: false,
            sessionKey: execution,
            sessionTarget: target === "current" ? "current" : `session:${execution}`,
            schedule: { kind: "every", everyMs: 86_400_000 },
            payload: {
              kind: "agentTurn",
              message: "Reply with SELECTED_SHARED_PROOF",
              toolsAllow: [],
            },
            delivery: { mode: "announce", sessionKey: inbox },
          });
          expect(
            await rpc("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 60_000 }),
          ).toMatchObject({
            run: { status: "ok" },
          });
          await expect
            .poll(() => history(inbox), { timeout: 3_000 })
            .toContain("SELECTED_SHARED_PROOF");
          if (target === "persistent") {
            expect(await history(execution)).toContain("SELECTED_SHARED_PROOF");
          } else {
            // current is detached; the creator is not its execution conversation.
            expect(await history(execution)).not.toContain("SELECTED_SHARED_PROOF");
          }
          const runs = await rpc<{ entries: Array<Record<string, unknown>> }>("cron.runs", {
            id: job.id,
            limit: 1,
          });
          expect(runs.entries[0]).toMatchObject({ deliveryStatus: "delivered" });
          await rpc("sessions.reset", { key: inbox, reason: "new" });
          expect(
            await rpc("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 60_000 }),
          ).toMatchObject({
            run: { status: "ok" },
          });
          expect(
            (
              await rpc<{ entries: Array<Record<string, unknown>> }>("cron.runs", {
                id: job.id,
                limit: 1,
              })
            ).entries[0],
          ).toMatchObject({ deliveryStatus: "not-delivered" });
          expect(await history(inbox)).not.toContain("SELECTED_SHARED_PROOF");
          await rpc("cron.update", {
            id: job.id,
            patch: { delivery: { mode: "none", sessionKey: inbox } },
          });
          expect(
            await rpc("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 60_000 }),
          ).toMatchObject({
            run: { status: "ok" },
          });
          expect(await history(inbox)).not.toContain("SELECTED_SHARED_PROOF");
          expect(fixture.errors).toEqual([]);
        },
        () => fixture.close(),
      );
    });
  },
  180_000,
);

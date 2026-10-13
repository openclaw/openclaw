import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as inProcessGateway from "../../agents/tools/in-process-gateway.js";
import { prepareSessionsSendCommunication } from "../../agents/tools/sessions-send-communication.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { CommunicationEndpoint } from "../../sessions/communication-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { requestSessionCommunicationApproval } from "../session-communication-approval.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import {
  broadcast,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();
async function fixture(
  run: (fixture: {
    endpoint: CommunicationEndpoint;
    cfg: OpenClawConfig;
    creator: GatewayClient;
    admin: GatewayClient;
    peer: GatewayClient;
    ask: (signal?: AbortSignal) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.path("sessions.json");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: { entries: { main: {} } },
    };
    const creator = createOperatorClient({ profileId: "recipient", scopes: ["operator.write"] });
    const admin = createOperatorClient({ profileId: "admin", scopes: ["operator.admin"] });
    const peer = createOperatorClient({
      profileId: "sender",
      scopes: ["operator.questions", "operator.write"],
    });
    const endpoint: CommunicationEndpoint = {
      agentId: "main",
      sessionKey: "agent:main:communication-recipient",
      storePath,
      entry: {
        sessionId: "recipient-session",
        updatedAt: 1,
        communication: { receive: "ask" },
        createdActor: { type: "human", source: "profile", id: "recipient" },
      },
    };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: endpoint.sessionKey, storePath: endpoint.storePath },
      endpoint.entry!,
    );
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      questionManager: manager,
      broadcast,
    });
    const ask = (signal?: AbortSignal) =>
      requestSessionCommunicationApproval({
        context,
        approval: { direction: "receive", endpoint },
        source: { ...endpoint, sessionKey: "agent:main:sender" },
        target: endpoint,
        message: "exact message\n  with whitespace ",
        assertCurrent: () => {},
        signal,
      });
    await run({ endpoint, cfg, creator, admin, peer, ask });
  });
}

it("publishes to the real recipient under sender ALS and refuses model/admin self-approval", async () => {
  await fixture(async ({ endpoint, cfg, creator, admin, ask }) => {
    const model = { ...admin, internal: { syntheticClient: true as const } };
    broadcast.mockImplementation((event, _payload, options) => {
      if (event === "question.requested") {
        expect(options?.questionRecipient?.(creator)).toBe(true);
        expect(options?.questionRecipient?.(model)).toBe(false);
      }
    });
    const pending = withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:sender" },
      () => ask(),
    );
    const question = manager.list()[0]!;
    expect(question.sessionKey).toBe(endpoint.sessionKey);
    expect(question.questions[0]?.header.length).toBeLessThanOrEqual(12);
    expect(question.questions[0]?.question).toContain("exact message\n  with whitespace ");
    const resolve = { id: question.id, answers: { answers: { communication: ["Allow once"] } } };
    expect((await callQuestionRpc("question.resolve", resolve, { cfg, client: model }))[0]).toBe(
      false,
    );
    expect(manager.get(question.id)?.status).toBe("pending");
    expect((await callQuestionRpc("question.resolve", resolve, { cfg, client: creator }))[0]).toBe(
      true,
    );
    await expect(pending).resolves.toBeUndefined();
  });
});

it("retains creator/admin rights without treating assigned responsibility as authority", async () => {
  await fixture(async ({ endpoint, cfg, creator, admin, peer, ask }) => {
    endpoint.entry!.owner = { actor: { type: "human", id: "sender" } };
    const pending = expect(ask()).rejects.toThrow("not authorized");
    const question = manager.list()[0]!;
    const canRead = async (client: GatewayClient) =>
      (await callQuestionRpc("question.get", { id: question.id }, { cfg, client }))[0];
    expect(await canRead(creator)).toBe(true);
    expect(await canRead(admin)).toBe(true);
    expect(await canRead(peer)).toBe(false);
    const solo = { ...admin, internal: { operatorRoleActor: { kind: "system" as const } } };
    expect(await canRead(solo)).toBe(true);
    creator.invalidated = true;
    await expect(canRead(creator)).rejects.toThrow("requester authority changed");
    await callQuestionRpc(
      "question.resolve",
      { id: question.id, answers: { answers: { communication: ["Deny"] } } },
      { cfg, client: admin },
    );
    await pending;
  });
});

it("rejects an already displayed decision after the recipient incarnation changes", async () => {
  await fixture(async ({ endpoint, cfg, creator, admin, ask }) => {
    const pending = ask();
    const denied = expect(pending).rejects.toThrow("not authorized");
    const question = manager.list()[0]!;
    await upsertSessionEntryCore(
      { agentId: endpoint.agentId, sessionKey: endpoint.sessionKey, storePath: endpoint.storePath },
      {
        ...endpoint.entry!,
        sessionId: "replacement-recipient-session",
        lifecycleRevision: "replacement-recipient-lifecycle",
      },
    );
    expect(
      (
        await callQuestionRpc(
          "question.resolve",
          {
            id: question.id,
            answers: { answers: { communication: ["Allow once"] } },
          },
          { cfg, client: creator },
        )
      )[0],
    ).toBe(false);
    expect(manager.get(question.id)?.status).toBe("pending");
    expect(
      (
        await callQuestionRpc(
          "question.resolve",
          { id: question.id, answers: { answers: { communication: ["Allow once"] } } },
          { cfg, client: admin },
        )
      )[0],
    ).toBe(false);
    manager.cancel(question.id, "recipient-replaced");
    await denied;
  });
});

it("does not leak bound questions through broad question list/get scopes", async () => {
  await fixture(async ({ cfg, peer, admin, ask }) => {
    const pending = ask();
    const rejected = expect(pending).rejects.toThrow("not authorized");
    const question = manager.list()[0]!;
    expect(
      (await callQuestionRpc("question.get", { id: question.id }, { cfg, client: peer }))[0],
    ).toBe(false);
    expect((await callQuestionRpc("question.list", {}, { cfg, client: peer }))[1]).toEqual({
      questions: [],
    });
    await callQuestionRpc(
      "question.resolve",
      { id: question.id, answers: { answers: { communication: ["Deny"] } } },
      { cfg, client: admin },
    );
    await rejected;
  });
});

it("cancellation and expiration settle without approval and cannot be released by later policy changes", async () => {
  await fixture(async ({ ask }) => {
    const controller = new AbortController();
    const cancelled = ask(controller.signal);
    const cancelledCheck = expect(cancelled).rejects.toThrow();
    controller.abort();
    await cancelledCheck;
    const expired = ask();
    const expiredCheck = expect(expired).rejects.toThrow("not authorized");
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await expiredCheck;
    expect(manager.list()).toEqual([]);
  });
});

it.each(["Allow once", "Deny"] as const)(
  "missing configured main gets real recipient consent after empty creation: %s",
  async (decision) => {
    await fixture(async ({ endpoint, cfg, creator, admin }) => {
      cfg.session!.communication = { send: "ask", receive: "ask" };
      const context = createDirectChatContext({
        getRuntimeConfig: () => cfg,
        questionManager: manager,
        broadcast,
      });
      const read = async (key: string): Promise<CommunicationEndpoint> => {
        const loaded = await resolveGatewaySessionStoreTargetInWorker({
          cfg,
          key,
          agentId: "main",
        });
        return {
          agentId: loaded.agentId,
          sessionKey: loaded.canonicalKey,
          storePath: loaded.readSource?.path ?? loaded.storePath,
          entry: loaded.store[loaded.canonicalKey],
        };
      };
      const source = await read(endpoint.sessionKey);
      const target = await read("agent:main:main");
      expect(target.entry).toBeUndefined();
      const sendQuestion = createDeferredCore<string>();
      const receiveQuestion = createDeferredCore<string>();
      broadcast.mockImplementation((event, payload) => {
        if (event !== "question.requested") {
          return;
        }
        const record = payload as { id: string; sessionKey?: string };
        if (record.sessionKey === source.sessionKey) {
          sendQuestion.resolve(record.id);
        }
        if (record.sessionKey === target.sessionKey) {
          receiveQuestion.resolve(record.id);
        }
      });
      const ensureTarget = vi.fn(async (assertCurrent: () => void) => {
        assertCurrent();
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: target.sessionKey, storePath: endpoint.storePath },
          {
            sessionId: "created-empty-main",
            updatedAt: 1,
            createdActor: { type: "agent", id: source.sessionKey },
          },
        );
        assertCurrent();
        return read(target.sessionKey);
      });
      const callGateway = vi
        .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
        .mockResolvedValue(undefined);
      const operationalRunInstance = createOperationalRunInstanceRef("communication-sender");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      try {
        const pending = withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: source.sessionKey,
            gatewayContextResolver: () => context,
            operationalRunInstance,
            approvalAuthority: authority,
            receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
          },
          () =>
            prepareSessionsSendCommunication({
              config: cfg,
              source,
              target,
              message: "exact new-main message",
              ensureTarget,
              callGateway: inProcessGateway.callAgentToolGatewayRequest,
            }),
        );
        const observed = pending.then(
          (gate) => ({ gate, error: undefined }),
          (error: unknown) => ({ gate: undefined, error }),
        );
        const senderId = await Promise.race([
          sendQuestion.promise,
          pending.then(() => {
            throw new Error("Expected sender approval before admission");
          }),
        ]);
        expect(ensureTarget).not.toHaveBeenCalled();
        expect(callGateway).not.toHaveBeenCalled();
        expect(
          (
            await callQuestionRpc(
              "question.resolve",
              { id: senderId, answers: { answers: { communication: ["Allow once"] } } },
              { cfg, client: creator },
            )
          )[0],
        ).toBe(true);
        const recipientId = await Promise.race([
          receiveQuestion.promise,
          pending.then(() => {
            throw new Error("Expected recipient approval before admission");
          }),
        ]);
        expect(ensureTarget).toHaveBeenCalledOnce();
        expect(callGateway).not.toHaveBeenCalled();
        expect(manager.get(recipientId)).toMatchObject({
          sessionKey: target.sessionKey,
          status: "pending",
        });
        expect((await read(target.sessionKey)).entry?.sessionId).toBe("created-empty-main");
        expect(
          (
            await callQuestionRpc(
              "question.resolve",
              { id: recipientId, answers: { answers: { communication: [decision] } } },
              { cfg, client: admin },
            )
          )[0],
        ).toBe(true);
        const result = await observed;
        if (decision === "Deny") {
          expect(result.error).toBeInstanceOf(Error);
          expect(callGateway).not.toHaveBeenCalled();
        } else {
          expect(result.error).toBeUndefined();
          expect(result.gate).toBeDefined();
          await result.gate!.callGateway({
            method: "agent",
            params: {
              agentId: "main",
              sessionKey: target.sessionKey,
              message: "exact new-main message",
            },
          });
          expect(callGateway).toHaveBeenCalledOnce();
          result.gate!.close();
        }
      } finally {
        callGateway.mockRestore();
        releaseAgentRunDelegatedAuthority(authority);
      }
    });
  },
);

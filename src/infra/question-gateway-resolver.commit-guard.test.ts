import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { QuestionManager } from "../gateway/question-manager.js";
import { createRequestGatewayMethodRegistry } from "../gateway/server-methods.js";
import { createQuestionHandlers } from "../gateway/server-methods/question.js";
import { createSecretStoreWriteService } from "../gateway/server-methods/secrets.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";
import {
  cancelQuestionOverGateway,
  getQuestionOverGateway,
  resolveQuestionAnswersOverGateway,
} from "./question-gateway-resolver.js";

const answers = { target: ["Production"], regions: ["EU", "APAC"] };
const operations = ["answer", "skip"] as const;

async function withQuestionOwner(
  run: (fixture: {
    id: string;
    manager: QuestionManager;
    replaceHandler: (
      method: "question.get" | "question.resolve",
      decorate: (original: GatewayRequestHandler) => GatewayRequestHandler,
    ) => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const scheduler = createTestGatewayScheduler();
    const manager = new QuestionManager(scheduler);
    const context = createContext();
    context.getRuntimeConfig = () => cfg;
    context.questionManager = manager;
    const handlers = createQuestionHandlers(
      manager,
      createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
      scheduler,
    );
    let registry = createRequestGatewayMethodRegistry(handlers);
    context.getGatewayMethodRegistry = () => registry;
    const record = manager.request({
      id: `ask_${randomUUID().replaceAll("-", "")}`,
      questions: [
        {
          questionId: "target",
          header: "Target",
          question: "Where?",
          options: [{ label: "Production", value: "prod" }],
          multiSelect: false,
          isOther: false,
          isSecret: false,
        },
        {
          questionId: "regions",
          header: "Regions",
          question: "Which regions?",
          options: [{ label: "EU" }],
          multiSelect: true,
          isOther: true,
          isSecret: false,
        },
      ],
      timeoutMs: 60_000,
    });
    try {
      await withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
        run({
          id: record.id,
          manager,
          replaceHandler: (method, decorate) => {
            registry = createRequestGatewayMethodRegistry({
              ...handlers,
              [method]: decorate(handlers[method]),
            });
          },
        }),
      );
    } finally {
      manager.close();
      await manager.drain();
    }
  });
}

it.each(operations)(
  "commits an admitted native %s through the actual question owner",
  async (action) => {
    await withQuestionOwner(async ({ id, manager }) => {
      const params = {
        cfg: {},
        questionId: id,
        senderId: "synthetic-responder",
        authorize: () => () => true,
      };
      const result =
        action === "answer"
          ? await resolveQuestionAnswersOverGateway({ ...params, answers })
          : await cancelQuestionOverGateway(params);
      expect(result).toEqual({ status: action === "answer" ? "answered" : "cancelled" });
      expect(manager.get(id)).toMatchObject({
        status: action === "answer" ? "answered" : "cancelled",
        resolvedBy: "synthetic-responder",
        ...(action === "answer"
          ? { answers: { answers: { target: ["prod"], regions: ["EU", "APAC"] } } }
          : {}),
      });
      const publicRecord = await getQuestionOverGateway({ cfg: {}, questionId: id });
      expect(publicRecord?.status).toBe(action === "answer" ? "answered" : "cancelled");
      expect(publicRecord).not.toHaveProperty("answers");
    });
  },
);

it.each(operations)(
  "denies %s when responder or account authority closes before native commit",
  async (action) => {
    for (const retirement of ["responder", "account"] as const) {
      await withQuestionOwner(async ({ id, manager, replaceHandler }) => {
        let senderCurrent = true;
        const account = new AbortController();
        const entered = createDeferred();
        const release = createDeferred();
        replaceHandler("question.resolve", (original) => async (options) => {
          entered.resolve();
          await release.promise;
          await original(options);
        });
        const params = {
          cfg: {},
          questionId: id,
          authorize: async () => () => senderCurrent && !account.signal.aborted,
        };
        const pending =
          action === "answer"
            ? resolveQuestionAnswersOverGateway({ ...params, answers })
            : cancelQuestionOverGateway(params);
        try {
          await entered.promise;
          expect(manager.get(id)?.status).toBe("pending");
          if (retirement === "account") {
            account.abort();
          } else {
            senderCurrent = false;
          }
          release.resolve();
          expect(await pending).toEqual({ status: "denied" });
          expect(manager.get(id)?.status).toBe("pending");
          expect(manager.get(id)?.resolvedBy).toBeUndefined();
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
        }
      });
    }
  },
);

it.each(operations)(
  "preserves an accepted %s when its caller closes before the reply settles",
  async (action) => {
    await withQuestionOwner(async ({ id, manager, replaceHandler }) => {
      let current = true;
      const authority = claimAgentRunDelegatedAuthority({
        instanceId: "question-writer",
        runId: "question-write",
      });
      replaceHandler("question.resolve", (original) => async (options) => {
        const respond = options.respond;
        options.respond = (...response) => {
          if (response[0]) {
            current = false;
          }
          respond(...response);
        };
        try {
          await original(options);
        } finally {
          options.respond = respond;
        }
      });
      try {
        const result = await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:caller",
            operationalRunInstance: authority.operationalRunInstance,
            receiptAuthority: () => current,
          },
          () => {
            const params = { cfg: {}, questionId: id, authorize: () => () => current };
            return action === "answer"
              ? resolveQuestionAnswersOverGateway({ ...params, answers })
              : cancelQuestionOverGateway(params);
          },
        );
        expect(current).toBe(false);
        expect(result).toEqual({ status: action === "answer" ? "answered" : "cancelled" });
        expect(manager.get(id)?.status).toBe(action === "answer" ? "answered" : "cancelled");
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
      }
    });
  },
);

it("retains completion revalidation for a question read whose caller closes", async () => {
  await withQuestionOwner(async ({ id, manager, replaceHandler }) => {
    let current = true;
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "question-reader",
      runId: "question-read",
    });
    replaceHandler("question.get", (original) => async (options) => {
      const respond = options.respond;
      options.respond = (...response) => {
        current = false;
        respond(...response);
      };
      try {
        await original(options);
      } finally {
        options.respond = respond;
      }
    });
    try {
      await expect(
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:caller",
            operationalRunInstance: authority.operationalRunInstance,
            receiptAuthority: () => current,
          },
          () => getQuestionOverGateway({ cfg: {}, questionId: id }),
        ),
      ).rejects.toThrow("caller authority is no longer active");
      expect(manager.get(id)?.status).toBe("pending");
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
    }
  });
});

it.each(operations)("rejects a legacy boolean authorizer for native %s", async (action) => {
  await withQuestionOwner(async ({ id, manager }) => {
    const params = { cfg: {}, questionId: id, answers, authorize: () => true };
    // Exercise an untyped JavaScript plugin; it cannot opt out of the required guard.
    const operation =
      action === "answer" ? resolveQuestionAnswersOverGateway : cancelQuestionOverGateway;
    await expect(Reflect.apply(operation, undefined, [params])).rejects.toThrow(
      "prepared synchronous authority",
    );
    expect(manager.get(id)?.status).toBe("pending");
  });
});

it("retains native answer validation and refuses secret question answers", async () => {
  await withQuestionOwner(async ({ id, manager }) => {
    const params = { cfg: {}, questionId: id, authorize: () => () => true };
    const invalid = await resolveQuestionAnswersOverGateway({
      ...params,
      answers: { target: ["Production"] },
    });
    expect(invalid.status).toBe("invalid");
    expect(manager.get(id)?.status).toBe("pending");
    const question = manager.get(id)?.questions[0];
    expect(question).toBeDefined();
    if (!question) {
      throw new Error("native question fixture must exist");
    }
    const secret = manager.request({
      id: `ask_${randomUUID().replaceAll("-", "")}`,
      questions: [{ ...question, isSecret: true }],
      timeoutMs: 60_000,
    });
    await expect(
      resolveQuestionAnswersOverGateway({
        ...params,
        questionId: secret.id,
        answers: { target: ["synthetic secret"] },
      }),
    ).rejects.toThrow("secret questions");
    expect(manager.get(secret.id)?.status).toBe("pending");
  });
});

it.each(operations)("returns terminal outcomes without a native %s effect", async (action) => {
  await withQuestionOwner(async ({ id, manager }) => {
    manager.cancel(id, "synthetic-management");
    const call = (questionId: string) => {
      const params = { cfg: {}, questionId, authorize: () => () => true };
      return action === "answer"
        ? resolveQuestionAnswersOverGateway({ ...params, answers })
        : cancelQuestionOverGateway(params);
    };
    expect(await call(id)).toEqual({ status: "already-terminal", reason: "already-terminal" });
    expect(await call("ask_0123456789abcdef0123456789abcdef")).toEqual({
      status: "already-terminal",
      reason: "not-found",
    });
    expect(manager.get(id)).toMatchObject({
      status: "cancelled",
      resolvedBy: "synthetic-management",
    });
  });
});

it.each(operations)("refuses standalone and explicit remote native %s", async (action) => {
  const params = {
    cfg: {},
    questionId: "ask_0123456789abcdef0123456789abcdef",
    answers,
    authorize: () => () => true,
  };
  const operation = () =>
    action === "answer"
      ? resolveQuestionAnswersOverGateway(params)
      : cancelQuestionOverGateway(params);
  await expect(operation()).rejects.toThrow("admitted in-process Gateway");
  await withQuestionOwner(async ({ id, manager }) => {
    const remote = { ...params, questionId: id, gatewayUrl: "ws://127.0.0.1:1" };
    await expect(
      action === "answer"
        ? resolveQuestionAnswersOverGateway(remote)
        : cancelQuestionOverGateway(remote),
    ).rejects.toThrow("admitted in-process Gateway");
    expect(manager.get(id)?.status).toBe("pending");
  });
});

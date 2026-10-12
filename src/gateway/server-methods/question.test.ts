import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  getAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import * as secretsRuntimeState from "../../secrets/runtime-state.js";
import {
  listSecretStoreEntries,
  readSecretStoreValue,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abortChatRunById,
  registerChatAbortController,
  type ChatAbortControllerEntry,
} from "../chat-abort.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createChatRunState } from "../server-chat-state.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { canReceiveSessionEvent } from "../session-sharing.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc as call,
  installQuestionTestHooks,
  manager,
  reloadSecrets,
  requesterAuthority,
  requestParams,
  requestSecretQuestion,
  secretRequestParams,
  secretRequestQuestion,
  storeWriteService,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

const invalidRequest = [false, undefined, { code: "INVALID_REQUEST" }];

const publicationOptions = {
  questionRecipient: expect.any(Function),
};

function mockReferencedStoreSnapshot() {
  vi.spyOn(secretsRuntimeState, "getActiveSecretsRuntimeSnapshotState").mockReturnValue({
    sourceConfig: {
      models: {
        providers: {
          test: {
            baseUrl: "https://provider.example.test",
            models: [],
            apiKey: { source: "store", provider: "default", id: "SERVICE_API_KEY" },
          },
        },
      },
    },
    config: {},
    authStores: [],
    authStoreCredentialsRevision: 0,
    authStoreSnapshotsRevision: 0,
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  });
}

async function sharingFixture(others: "none" | "suggest" = "none") {
  const owner = ensureProfileForEmail("owner@example.test");
  const guest = ensureProfileForEmail("guest@example.test");
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: requestParams.sessionKey },
    {
      sessionId: "question-session",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: owner.id },
    },
  );
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others }, agents: "*", scopes: ["operator.questions"] },
          viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.questions"] },
        },
      },
    },
  };
  const profile = (user: typeof guest) => ({
    profileId: user.id,
    displayName: user.displayName,
    avatarRevision: "",
    hasAvatar: false,
    updatedAt: user.updatedAt,
  });
  const client = {
    connect: { scopes: ["operator.questions"] },
    authenticatedUserProfile: profile(guest),
  } as GatewayClient;
  return { owner, guest, cfg, client, profile };
}

it("conceals foreign session questions for role-none readers while preserving global prompts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { client, cfg } = await sharingFixture();
    manager.request({ ...requestParams, id: "foreign-question" });
    manager.request({
      questions: requestParams.questions,
      id: "global-question",
      timeoutMs: 100,
    });

    expect((await call("question.list", {}, { client, cfg }))[1]).toMatchObject({
      questions: [{ id: "global-question" }],
    });
    for (const method of ["question.get", "question.waitAnswer"] as const) {
      expect(await call(method, { id: "foreign-question" }, { client, cfg })).toMatchObject([
        false,
        undefined,
        { details: { reason: "QUESTION_NOT_FOUND" } },
      ]);
    }
    expect(
      await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
    ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
    expect(manager.get("foreign-question")?.status).toBe("pending");
  });
});

it("requires membership to resolve a suggest-capped guest question", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, guest, cfg, client } = await sharingFixture("suggest");
    manager.request({ ...requestParams, id: "foreign-question" });

    expect((await call("question.get", { id: "foreign-question" }, { client, cfg }))[0]).toBe(true);
    expect(
      await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
    ).toMatchObject([false, undefined, { details: { code: "SESSION_PARTICIPATION_REQUIRED" } }]);
    addSessionMember(
      { agentId: "main", sessionKey: requestParams.sessionKey },
      { identityId: guest.id, addedBy: owner.id, expectedSessionId: "question-session" },
    );
    expect(
      await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
    ).toEqual([true, { status: "cancelled" }, undefined]);
  });
});

it("scopes requested and resolved questions to operators allowed to see their session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, guest, cfg, profile: userProfile } = await sharingFixture();
    const viewer = ensureProfileForEmail("viewer@example.test");
    setUserProfileRole(viewer.id, "viewer");
    const makeQuestionClient = (
      profile: ReturnType<typeof ensureProfileForEmail>,
      connId: string,
    ) => {
      const socket = { bufferedAmount: 0, close: vi.fn(), readyState: 1, send: vi.fn() };
      const client: GatewayWsClient = {
        socket: socket as unknown as GatewayWsClient["socket"],
        connect: {
          role: "operator",
          scopes: ["operator.questions"],
        } as GatewayWsClient["connect"],
        connId,
        usesSharedGatewayAuth: false,
        authenticatedUserProfile: userProfile(profile),
      };
      return { client, socket };
    };
    const ownerClient = makeQuestionClient(owner, "question-owner");
    const viewerClient = makeQuestionClient(viewer, "question-viewer");
    const guestClient = makeQuestionClient(guest, "question-guest");
    const gatewayBroadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([
        ownerClient.client,
        viewerClient.client,
        guestClient.client,
      ]),
      canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
        canReceiveSessionEvent({ cfg, client, sessionKeys, agentId, event, payload }),
    });
    broadcast.mockImplementation(gatewayBroadcaster.broadcast);

    const request = await call("question.request", requestParams, {
      cfg,
      client: ownerClient.client,
    });
    const id = (request[1] as { id: string }).id;
    const answers = { answers: { destination: ["Home"] } };
    const sessionScope = {
      sessionKeys: [requestParams.sessionKey],
      agentId: "main",
      ...publicationOptions,
    };

    expect(ownerClient.socket.send).toHaveBeenCalledTimes(1);
    expect(viewerClient.socket.send).toHaveBeenCalledTimes(1);
    expect(guestClient.socket.send).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      "question.requested",
      expect.objectContaining({ id, sessionKey: requestParams.sessionKey }),
      sessionScope,
    );

    await call("question.resolve", { id, answers }, { cfg, client: ownerClient.client });
    await manager.drain();

    expect(broadcast).toHaveBeenCalledWith(
      "question.resolved",
      { id, status: "answered", answers },
      sessionScope,
    );
    expect(ownerClient.socket.send).toHaveBeenCalledTimes(2);
    expect(viewerClient.socket.send).toHaveBeenCalledTimes(2);
    expect(guestClient.socket.send).not.toHaveBeenCalled();
  });
});

const credentialUrl = new URL("https://example.test/connect");
credentialUrl.username = "fixture-user";
credentialUrl.password = "fixture-password";

it.each([
  ["script", "javascript:alert(1)"],
  ["relative", "/connect"],
  ["credentials", credentialUrl.href],
])("rejects a %s browser URL before publishing", async (_name, url) => {
  expect(
    await call("question.request", {
      ...requestParams,
      questions: [{ ...requestParams.questions[0], url }],
    }),
  ).toMatchObject(invalidRequest);
  expect(manager.list()).toEqual([]);
  expect(broadcast).not.toHaveBeenCalled();
});

it("rejects duplicate ids and admits a bounded rich single-option question at the request boundary", async () => {
  const duplicate = await call("question.request", {
    questions: [requestParams.questions[0], requestParams.questions[0]],
  });
  expect(duplicate[0]).toBe(false);
  expect((duplicate[2] as { message: string }).message).toContain("duplicate question id");

  const oneOption = await call("question.request", {
    ...requestParams,
    id: "rich-question",
    questions: [
      {
        ...requestParams.questions[0],
        url: "https://example.test/connect",
        allowEmpty: true,
        presentation: "form",
        options: [{ label: "Only", thumbnail: "https://example.com/only.png" }],
      },
    ],
  });
  expect(oneOption[0]).toBe(true);
  const richQuestion = expect.objectContaining({
    id: "rich-question",
    questions: [expect.objectContaining({ url: "https://example.test/connect" })],
  });
  expect(broadcast).toHaveBeenCalledWith("question.requested", richQuestion, publicationOptions);
  expect(await call("question.get", { id: "rich-question" })).toEqual([
    true,
    { question: richQuestion },
    undefined,
  ]);
  expect(await call("question.list", {})).toEqual([true, { questions: [richQuestion] }, undefined]);
  expect(
    (
      await call("question.resolve", {
        id: "rich-question",
        answers: { answers: { destination: [] } },
      })
    )[1],
  ).toEqual({ status: "answered", answers: { answers: { destination: [] } } });
  expect(
    (
      await call("question.request", {
        questions: [
          {
            ...requestParams.questions[0],
            options: [{ label: "Unsafe", thumbnail: "javascript:alert(1)" }],
          },
        ],
      })
    )[0],
  ).toBe(false);

  const clientId = "duplicate-client-id";
  expect((await call("question.request", { ...requestParams, id: clientId }))[0]).toBe(true);
  const reusedId = await call("question.request", { ...requestParams, id: clientId });
  expect(reusedId[0]).toBe(false);
  expect(reusedId[2]).toMatchObject({
    code: "INVALID_REQUEST",
    details: { reason: "QUESTION_ID_IN_USE" },
  });
});

it("rejects secret questions and duplicate normalized option labels", async () => {
  const secret = await call("question.request", {
    ...requestParams,
    questions: [{ ...requestParams.questions[0], isSecret: true }],
  });
  expect(secret[0]).toBe(false);
  expect((secret[2] as { message: string }).message).toContain(
    "question 'destination': secret questions are not supported yet",
  );

  const duplicateLabels = await call("question.request", {
    ...requestParams,
    questions: [
      {
        ...requestParams.questions[0],
        options: [{ label: " Deploy " }, { label: "deploy" }],
      },
    ],
  });
  expect(duplicateLabels[0]).toBe(false);
  expect((duplicateLabels[2] as { message: string }).message).toContain(
    "question 'destination' has duplicate option label",
  );
});

it.each([
  {
    behavior: "bindings without the secret-input marker",
    questions: [{ ...secretRequestParams.questions[0], isSecret: false }],
  },
  {
    behavior: "secret requests mixed with another question",
    questions: [secretRequestParams.questions[0], requestParams.questions[0]],
  },
  {
    behavior: "invalid secret store entry names",
    questions: [
      {
        ...secretRequestParams.questions[0],
        secretStore: { ...secretRequestQuestion.secretStore, name: "lowercase" },
      },
    ],
  },
])("rejects $behavior before opening a pending secret question", async ({ questions }) => {
  const response = await call(
    "question.request",
    { ...requestParams, questions },
    { client: adminRequestClient },
  );

  expect(response).toMatchObject(invalidRequest);
  expect(manager.list()).toEqual([]);
});

it("requires admin scope to mint store-bound questions", async () => {
  const client = { connect: { scopes: ["operator.questions"] } } as GatewayClient;
  expect(await call("question.request", secretRequestParams, { client })).toMatchObject([
    false,
    undefined,
    { code: "INVALID_REQUEST", message: expect.stringContaining("operator.admin") },
  ]);
  expect(manager.list()).toEqual([]);
});

it.each(["replacement", "abort"] as const)(
  "fences a pending credential on exact requester %s while preserving ordinary questions",
  async (closure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const id = await requestSecretQuestion();
      const ordinary = await call("question.request", requestParams);
      const ordinaryId = (ordinary[1] as { id: string }).id;
      const waiting = manager.waitAnswer(id);
      let successor: AgentRunDelegatedAuthority | undefined;
      if (closure === "replacement") {
        successor = claimAgentRunDelegatedAuthority({
          instanceId: "successor-instance",
          runId: requestParams.runId,
        });
      } else {
        const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
        const registration = registerChatAbortController({
          chatAbortControllers,
          runId: requestParams.runId,
          sessionId: "question-session",
          sessionKey: requestParams.sessionKey,
          timeoutMs: 60_000,
          operationalRunInstance: requesterAuthority.operationalRunInstance,
        });
        registration.bindAgentRunDelegatedAuthority(requesterAuthority);
        // Projection cleanup is not an abort; exercise the owner that revokes
        // the exact claim before notifying the run's abort listeners.
        try {
          expect(
            abortChatRunById(
              {
                chatAbortControllers,
                chatRunState: createChatRunState(),
                removeChatRun: () => undefined,
                agentRunSeq: new Map(),
                broadcast: vi.fn(),
                nodeSendToSession: vi.fn(),
              },
              { runId: requestParams.runId, sessionKey: requestParams.sessionKey },
            ),
          ).toEqual({ aborted: true });
        } finally {
          registration.cleanup();
        }
      }
      try {
        if (closure !== "abort") {
          expect(getAgentRunContext(requestParams.runId)).toBeDefined();
        }
        const resolved = await call("question.resolve", {
          id,
          answers: { answers: { secret_value: ["test-secret-stale-requester"] } },
        });
        expect(resolved).toMatchObject(invalidRequest);
        expect(await listSecretStoreEntries({ scope: { kind: "team" } })).toEqual([]);
        expect(reloadSecrets).not.toHaveBeenCalled();
        expect(manager.get(id)?.status).toBe("cancelled");
        await expect(waiting).resolves.toEqual({ status: "cancelled" });
        await manager.drain();
        expect(broadcast).toHaveBeenCalledWith(
          "question.resolved",
          { id, status: "cancelled" },
          publicationOptions,
        );
        expect(
          (
            await call("question.resolve", {
              id: ordinaryId,
              answers: { answers: { destination: ["Home"] } },
            })
          )[0],
        ).toBe(true);
        if (successor) {
          const successorClient = {
            ...adminRequestClient,
            internal: {
              agentRuntimeIdentity: {
                ...adminRequestClient.internal!.agentRuntimeIdentity!,
                operationalRunInstance: successor.operationalRunInstance,
                delegatedAuthority: { kind: "local", ...successor },
              },
            },
          } as GatewayClient;
          const replacement = await call("question.request", secretRequestParams, {
            client: successorClient,
          });
          const replacementId = (replacement[1] as { id: string }).id;
          expect(
            (
              await call("question.resolve", {
                id: replacementId,
                answers: { answers: { secret_value: ["test-secret-current-requester"] } },
              })
            )[0],
          ).toBe(true);
          expect(
            await readSecretStoreValue({ scope: { kind: "team" }, name: "SERVICE_API_KEY" }),
          ).toEqual({
            ok: true,
            value: "test-secret-current-requester",
          });
        }
      } finally {
        if (successor) {
          releaseAgentRunDelegatedAuthority(successor);
        }
      }
    });
  },
);

it("requires admitted authority, not an admin's supplied run metadata", async () => {
  expect(
    await call("question.request", secretRequestParams, {
      client: { connect: { scopes: ["operator.admin"] } } as GatewayClient,
    }),
  ).toMatchObject(invalidRequest);
  expect(manager.list()).toEqual([]);
});

it("diverts operator-entered credentials into the store and exposes only a stored marker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const id = await requestSecretQuestion();
    const value = "test-secret-value-gateway-diversion-123";
    const client = {
      connect: { client: { displayName: "Trusted Operator" }, scopes: ["operator.questions"] },
    } as GatewayClient;

    const resolved = await call(
      "question.resolve",
      { id, answers: { answers: { secret_value: [value] } }, resolvedBy: "control-ui" },
      { client },
    );
    const safeAnswers = { answers: { secret_value: ["stored"] } };

    expect(resolved).toEqual([true, { status: "answered", answers: safeAnswers }, undefined]);
    expect(await listSecretStoreEntries({ scope: { kind: "team" } })).toMatchObject([
      {
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.test"],
        updatedBy: "Trusted Operator",
      },
    ]);
    expect(manager.get(id)).toMatchObject({ status: "answered", answers: safeAnswers });
    expect(await call("question.waitAnswer", { id })).toEqual([
      true,
      { status: "answered", answers: safeAnswers },
      undefined,
    ]);
    await manager.drain();
    expect(broadcast).toHaveBeenCalledWith(
      "question.resolved",
      { id, status: "answered", answers: safeAnswers },
      publicationOptions,
    );
    expect(JSON.stringify([resolved, manager.get(id), broadcast.mock.calls])).not.toContain(value);
    expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
  });
});

it("uses operator-edited hosts and keeps invalid store submissions pending for retry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const id = await requestSecretQuestion();
    const value = "test-secret-value-retry-123";
    const answers = { answers: { secret_value: [value] } };

    const invalid = await call("question.resolve", {
      id,
      answers,
      secretStoreAllowedHosts: ["*.example.test"],
    });
    expect(invalid).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: expect.stringContaining("wildcard") },
    ]);
    expect(manager.get(id)?.status).toBe("pending");
    expect(isSecretValueRegisteredForRedaction(value)).toBe(true);

    const retried = await call("question.resolve", {
      id,
      answers,
      secretStoreAllowedHosts: ["replacement.example.test"],
    });
    expect(retried[0]).toBe(true);
    expect((await listSecretStoreEntries({ scope: { kind: "team" } }))[0]).toMatchObject({
      allowedHosts: ["replacement.example.test"],
    });
  });
});

it.each([
  { behavior: "no submitted value", answers: { secret_value: [] } },
  {
    behavior: "an unrelated submitted answer",
    answers: { secret_value: ["test-secret-value-only"], destination: ["Home"] },
  },
])("keeps a secret question pending when there is $behavior", async ({ answers }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const id = await requestSecretQuestion();

    expect(await call("question.resolve", { id, answers: { answers } })).toMatchObject(
      invalidRequest,
    );
    expect(manager.get(id)?.status).toBe("pending");
    expect(await listSecretStoreEntries({ scope: { kind: "team" } })).toEqual([]);
  });
});

it("rejects masked env requests while preserving ordinary question host validation and cancellation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    expect(
      await call(
        "question.request",
        {
          ...secretRequestParams,
          questions: [
            { ...secretRequestQuestion, secretStore: { name: "SERVICE_URL", kind: "env" } },
          ],
        },
        { client: adminRequestClient },
      ),
    ).toMatchObject(invalidRequest);
    expect(manager.list()).toEqual([]);
    expect(await listSecretStoreEntries({ scope: { kind: "team" } })).toEqual([]);
    const ordinaryResponse = await call("question.request", requestParams);
    const ordinaryId = (ordinaryResponse[1] as { id: string }).id;
    expect(
      await call("question.resolve", {
        id: ordinaryId,
        answers: { answers: { destination: ["Home"] } },
        secretStoreAllowedHosts: ["example.test"],
      }),
    ).toMatchObject(invalidRequest);
    expect(manager.get(ordinaryId)?.status).toBe("pending");
    const id = await requestSecretQuestion();
    expect(await call("question.resolve", { id, cancel: true })).toEqual([
      true,
      { status: "cancelled" },
      undefined,
    ]);
  });
});

it("settles the SQLite commit before a second answer races its deferred refresh", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    mockReferencedStoreSnapshot();
    const reload = createDeferred<{ warningCount: number }>();
    const reloadStarted = createDeferred();
    reloadSecrets.mockImplementation(() => {
      reloadStarted.resolve();
      return reload.promise;
    });
    const id = await requestSecretQuestion();
    const firstValue = "test-secret-committed-first";
    const pending = call("question.resolve", {
      id,
      answers: { answers: { secret_value: [firstValue] } },
    });
    const competitors: Array<ReturnType<typeof call>> = [];
    try {
      await Promise.race([
        reloadStarted.promise,
        pending.then(() => {
          throw new Error("Question resolve settled before entering its deferred refresh");
        }),
      ]);
      competitors.push(
        call("question.resolve", {
          id,
          answers: { answers: { secret_value: ["test-secret-late-overwrite"] } },
        }),
      );
      expect(
        await readSecretStoreValue({ scope: { kind: "team" }, name: "SERVICE_API_KEY" }),
      ).toEqual({
        ok: true,
        value: firstValue,
      });
      expect(manager.get(id)?.status).toBe("answered");
      expect(reloadSecrets).toHaveBeenCalledTimes(1);
      expect(reloadSecrets).toHaveBeenCalledWith({
        forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
        joinInFlight: false,
      });
    } finally {
      reload.resolve({ warningCount: 0 });
      await Promise.all([pending, ...competitors]);
    }
    expect((await pending)[0]).toBe(true);
    for (const competitor of competitors) {
      expect((await competitor)[0]).toBe(false);
    }
    expect(await manager.waitAnswer(id)).toEqual({
      status: "answered",
      answers: { answers: { secret_value: ["stored"] } },
    });
  });
});

it("keeps a committed answer terminal and reports refresh failure without inviting overwrite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    mockReferencedStoreSnapshot();
    reloadSecrets.mockRejectedValue(new Error("synthetic refresh failure"));
    const id = await requestSecretQuestion();
    const value = "test-secret-refresh-failed";
    const resolutionId = "committed-before-refresh";
    const result = await call("question.resolve", {
      id,
      answers: { answers: { secret_value: [value] } },
      resolutionId,
    });
    expect(result).toMatchObject([
      false,
      undefined,
      { code: "UNAVAILABLE", message: expect.stringContaining("was saved") },
    ]);
    expect(manager.get(id)?.status).toBe("answered");
    expect(await manager.waitAnswer(id)).toEqual({
      status: "answered",
      answers: { answers: { secret_value: ["stored"] } },
    });
    expect(await call("question.waitAnswer", { id, includeResolutionId: true })).toEqual([
      true,
      { status: "answered", answers: { answers: { secret_value: ["stored"] } }, resolutionId },
      undefined,
    ]);
    expect(
      (
        await call("question.resolve", {
          id,
          answers: { answers: { secret_value: ["test-secret-overwrite"] } },
        })
      )[0],
    ).toBe(false);
    expect(
      await readSecretStoreValue({ scope: { kind: "team" }, name: "SERVICE_API_KEY" }),
    ).toEqual({
      ok: true,
      value,
    });
    expect(reloadSecrets).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([result, manager.get(id), broadcast.mock.calls])).not.toContain(value);
  });
});

it("keeps store-bound questions pending when the write service is unavailable", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.spyOn(storeWriteService, "write").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    const id = await requestSecretQuestion();

    expect(
      await call("question.resolve", {
        id,
        answers: { answers: { secret_value: ["test-secret-value-unavailable-123"] } },
      }),
    ).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
    expect(manager.get(id)?.status).toBe("pending");
  });
});

it("returns INVALID_REQUEST for answers that violate the stored question", async () => {
  const requested = await call("question.request", {
    ...requestParams,
    questions: [
      {
        ...requestParams.questions[0],
        options: [{ label: "Home" }, { label: "Office" }],
        isOther: false,
      },
    ],
  });
  const id = (requested[1] as { id: string }).id;

  const resolved = await call("question.resolve", {
    id,
    answers: { answers: { destination: ["Somewhere else"] } },
  });

  expect(resolved[0]).toBe(false);
  expect(resolved[2]).toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("question 'destination'"),
    details: { reason: "QUESTION_INVALID_ANSWER" },
  });
  expect(manager.get(id)?.status).toBe("pending");
});

it.each([
  {
    scenario: "concurrent creation",
    existing: false,
    proposal: undefined,
    override: undefined,
    shown: [],
  },
  {
    scenario: "concurrent host update",
    existing: true,
    proposal: undefined,
    override: undefined,
    shown: ["a.example.test"],
  },
  {
    scenario: "empty proposed policy",
    existing: true,
    proposal: [],
    override: undefined,
    shown: [],
  },
  {
    scenario: "operator clears policy",
    existing: true,
    proposal: undefined,
    override: [],
    shown: ["a.example.test"],
  },
])(
  "saves only the consented host policy: $scenario",
  async ({ existing, proposal, override, shown }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const entry = {
        scope: { kind: "team" as const },
        name: "SERVICE_API_KEY",
        kind: "secret" as const,
        value: "test-secret-existing",
        updatedBy: "Previous Operator",
      };
      if (existing) {
        await writeSecretStoreEntry({ ...entry, allowedHosts: ["a.example.test"] });
      }
      const id = await requestSecretQuestion({
        name: entry.name,
        kind: entry.kind,
        ...(proposal !== undefined ? { allowedHosts: proposal } : {}),
      });
      const question = {
        secretStore: { name: entry.name, kind: entry.kind, allowedHosts: shown },
        ...(existing
          ? { secretStoreExisting: { updatedAtMs: 1_000, updatedBy: entry.updatedBy } }
          : {}),
      };
      const displayed = await call("question.get", { id });
      expect(displayed).toMatchObject([true, { question: { questions: [question] } }, undefined]);
      expect(JSON.stringify(displayed)).not.toContain(entry.value);
      expect(broadcast).toHaveBeenCalledWith(
        "question.requested",
        expect.objectContaining({ id, questions: [expect.objectContaining(question)] }),
        publicationOptions,
      );
      if (!existing) {
        expect(manager.get(id)?.questions[0]).not.toHaveProperty("secretStoreExisting");
      }
      await writeSecretStoreEntry({ ...entry, allowedHosts: ["b.example.test"] });
      expect((await listSecretStoreEntries({ scope: entry.scope }))[0]?.allowedHosts).toEqual([
        "b.example.test",
      ]);
      const value = "test-secret-consented-replacement";
      const resolved = await call("question.resolve", {
        id,
        answers: { answers: { secret_value: [value] } },
        ...(override !== undefined ? { secretStoreAllowedHosts: override } : {}),
      });
      const safeAnswers = { answers: { secret_value: ["stored"] } };
      expect(resolved).toEqual([true, { status: "answered", answers: safeAnswers }, undefined]);
      expect(manager.get(id)).toMatchObject({ status: "answered", answers: safeAnswers });
      expect(await listSecretStoreEntries({ scope: entry.scope })).toMatchObject([
        { name: entry.name, kind: "secret", allowedHosts: override ?? shown },
      ]);
      expect(await readSecretStoreValue({ scope: entry.scope, name: entry.name })).toEqual({
        ok: true,
        value,
      });
    });
  },
);

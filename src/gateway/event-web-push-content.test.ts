import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/schema/questions.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";

const {
  listDevicePairingMock,
  prepareDevicePairingMock,
  authorityCompletedMock,
  prepareUserProfileCatalogMock,
  prepareSessionMutationFactsMock,
  listBoundWebPushSubscriptionsMock,
  hasBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSenderMock,
  preparedWebPushSendMock,
  readCurrentProfileIdentityMock,
  getUserPreferenceValuesMock,
  resolveOperatorRolePolicyForAssignmentMock,
  canReceiveSessionEventMock,
  webPushWarnMock,
} = vi.hoisted(() => ({
  listDevicePairingMock: vi.fn(),
  prepareDevicePairingMock: vi.fn(),
  authorityCompletedMock: vi.fn(),
  prepareUserProfileCatalogMock: vi.fn(),
  prepareSessionMutationFactsMock: vi.fn(),
  listBoundWebPushSubscriptionsMock: vi.fn(),
  hasBoundWebPushSubscriptionsMock: vi.fn(),
  prepareWebPushNotificationSenderMock: vi.fn(),
  preparedWebPushSendMock: vi.fn(),
  readCurrentProfileIdentityMock: vi.fn(),
  getUserPreferenceValuesMock: vi.fn(),
  resolveOperatorRolePolicyForAssignmentMock: vi.fn(),
  canReceiveSessionEventMock: vi.fn(),
  webPushWarnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/web-push" ? { ...logger, warn: webPushWarnMock } : logger;
    },
  };
});

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return actual;
});

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (
      paired: import("../infra/device-pairing.types.js").PairedDevice[],
    ) => { start: () => T } | undefined,
    preparePublication?: () => Promise<void>,
  ) => {
    await prepareDevicePairingMock();
    const paired = listDevicePairingMock().paired;
    if (preparePublication) {
      await preparePublication();
    }
    return prepare(paired)?.start();
  },
}));

vi.mock("../infra/push-web.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/push-web.js")>()),
  withBoundWebPushSubscriptions: async <T>(
    stateDir: string | undefined,
    prepare: (
      subscriptions: BoundWebPushSubscription[],
      assertCurrent: () => void,
    ) =>
      | { start: () => T | Promise<T> }
      | undefined
      | Promise<{ start: () => T | Promise<T> } | undefined>,
  ) => {
    try {
      return await (
        await prepare(await listBoundWebPushSubscriptionsMock(stateDir), () => {})
      )?.start();
    } finally {
      authorityCompletedMock();
    }
  },
  hasBoundWebPushSubscriptions: hasBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSender: prepareWebPushNotificationSenderMock,
}));

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  prepareUserProfileCatalog: prepareUserProfileCatalogMock,
}));

vi.mock("./session-sharing-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing-preparation.js")>()),
  prepareSessionMutationFacts: prepareSessionMutationFactsMock,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferenceValues: getUserPreferenceValuesMock,
}));

vi.mock("./operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-role-policy.js")>()),
  resolveOperatorRolePolicyForAssignment: resolveOperatorRolePolicyForAssignmentMock,
}));

vi.mock("./session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing.js")>()),
  canReceiveSessionEvent: canReceiveSessionEventMock,
}));

const { createEventWebPushDelivery } = await import("./event-web-push.js");
let authorityCompleted = createDeferred();

function boundSubscription(
  deviceId: string,
  userProfileId: string | null = null,
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
      },
    },
  };
}

function pairedOperator(deviceId: string, scopes = ["operator.read"]) {
  return {
    deviceId,
    roles: ["operator"],
    role: "operator",
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: { token: `token-${deviceId}`, role: "operator", scopes },
    },
  };
}

describe("consented event Web Push content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBoundWebPushSubscriptionsMock.mockResolvedValue([boundSubscription("browser-device")]);
    hasBoundWebPushSubscriptionsMock.mockResolvedValue(true);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("browser-device")],
    });
    prepareWebPushNotificationSenderMock.mockResolvedValue(preparedWebPushSendMock);
    preparedWebPushSendMock.mockResolvedValue([]);
    prepareDevicePairingMock.mockResolvedValue(undefined);
    authorityCompleted = createDeferred();
    authorityCompletedMock.mockImplementation(() => authorityCompleted.resolve());
    prepareUserProfileCatalogMock.mockResolvedValue({
      readCurrentIdentity: readCurrentProfileIdentityMock,
      release: () => {},
    });
    prepareSessionMutationFactsMock.mockResolvedValue({
      readCurrent: () => ({ target: null, membership: new Set<string>() }),
      release: () => {},
    });
    readCurrentProfileIdentityMock.mockImplementation((profileId: string) => ({
      profileId,
      role: null,
      aliases: new Set([profileId]),
    }));
    getUserPreferenceValuesMock.mockResolvedValue({ values: new Map(), isCurrent: () => true });
    resolveOperatorRolePolicyForAssignmentMock.mockReturnValue(undefined);
    canReceiveSessionEventMock.mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  describe("explicit content previews", () => {
    const sessionKey = "agent:research:thread.1";
    const finalEvent = {
      state: "final",
      runId: "exact-run",
      sessionKey,
      message: { role: "assistant", content: [{ type: "text", text: "The draft is ready." }] },
    };
    const scope = {
      sessionKeys: [sessionKey],
      agentId: "research",
      answerPreview: { payload: finalEvent, text: "The draft is ready.", canPreview: () => true },
    };
    function previewSubscription(deviceId: string) {
      const subscription = boundSubscription(deviceId);
      subscription.devicePreferences = {
        ...subscription.devicePreferences,
        detailLevel: "detailed",
        answerPreviewConsentVersion: 1,
        questionPreviewConsentVersion: 1,
      };
      return subscription;
    }

    it("builds separate envelopes for consented and legacy recipients of the same exact run", async () => {
      const legacy = boundSubscription("legacy");
      legacy.devicePreferences.detailLevel = "detailed";
      const consented = previewSubscription("consented");
      listBoundWebPushSubscriptionsMock.mockResolvedValue([legacy, consented]);
      listDevicePairingMock.mockReturnValue({
        paired: [pairedOperator("legacy"), pairedOperator("consented")],
      });
      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
        "chat",
        finalEvent,
        scope,
      );
      await authorityCompleted.promise;
      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
      expect(
        preparedWebPushSendMock.mock.calls.map(([send]) => ({
          ids: send.subscriptions.map(
            (subscription: BoundWebPushSubscription) => subscription.deviceId,
          ),
          payload: send.payload,
        })),
      ).toEqual([
        {
          ids: ["legacy"],
          payload: {
            title: "OpenClaw agent finished",
            body: "research: An agent completed its response.",
            tag: "openclaw-agent-finished-exact-run",
            renotify: false,
            url: "chat/research/thread%2E1",
          },
        },
        {
          ids: ["consented"],
          payload: {
            title: "OpenClaw agent finished",
            body: "The draft is ready.",
            tag: "openclaw-agent-finished-exact-run",
            renotify: false,
            url: "chat/research/thread%2E1",
            preview: {
              version: 1,
              kind: "answer",
              sessionKey,
              runId: "exact-run",
              text: "The draft is ready.",
            },
          },
        },
      ]);
    });

    it.each(["revoked", "scope", "visibility", "consent"])(
      "rechecks %s after transport preparation before releasing answer content",
      async (change) => {
        const subscription = previewSubscription("browser-device");
        listBoundWebPushSubscriptionsMock.mockResolvedValue([subscription]);
        const preparation = createDeferred<typeof preparedWebPushSendMock>();
        const started = createDeferred();
        prepareWebPushNotificationSenderMock.mockImplementation(() => {
          started.resolve();
          return preparation.promise;
        });
        createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
          "chat",
          finalEvent,
          scope,
        );
        await started.promise;
        if (change === "revoked") {
          listDevicePairingMock.mockReturnValue({ paired: [] });
        } else if (change === "scope") {
          listDevicePairingMock.mockReturnValue({ paired: [pairedOperator("browser-device", [])] });
        } else if (change === "visibility") {
          canReceiveSessionEventMock.mockReturnValue(false);
        } else {
          delete subscription.devicePreferences.answerPreviewConsentVersion;
        }
        preparation.resolve(preparedWebPushSendMock);
        await authorityCompleted.promise;
        if (change === "consent") {
          expect(preparedWebPushSendMock).toHaveBeenCalledOnce();
          expect(
            expectDefined(preparedWebPushSendMock.mock.calls[0], "expected a notification send")[0]
              .payload,
          ).not.toHaveProperty("preview");
        } else {
          expect(preparedWebPushSendMock).not.toHaveBeenCalled();
        }
      },
    );

    it.each(["missing", "retired", "different-event"])(
      "keeps answer text private when its original source is %s",
      async (source) => {
        listBoundWebPushSubscriptionsMock.mockResolvedValue([
          previewSubscription("browser-device"),
        ]);
        createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
          "chat",
          finalEvent,
          {
            ...scope,
            answerPreview:
              source === "missing"
                ? undefined
                : {
                    payload: source === "different-event" ? { ...finalEvent } : finalEvent,
                    text: "The draft is ready.",
                    canPreview: () => source !== "retired",
                  },
          },
        );
        await authorityCompleted.promise;
        expect(preparedWebPushSendMock).toHaveBeenCalledOnce();
        expect(
          expectDefined(preparedWebPushSendMock.mock.calls[0], "expected a notification send")[0]
            .payload,
        ).not.toHaveProperty("preview");
      },
    );

    it("falls back as a whole when the encoded route plus preview exceeds the payload budget", async () => {
      listBoundWebPushSubscriptionsMock.mockResolvedValue([previewSubscription("browser-device")]);
      const key = `agent:research:${'"'.repeat(800)}`;
      const payload = { ...finalEvent, sessionKey: key };
      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent("chat", payload, {
        ...scope,
        sessionKeys: [key],
        answerPreview: { payload, canPreview: () => true },
      });
      await authorityCompleted.promise;
      expect(preparedWebPushSendMock).toHaveBeenCalledOnce();
      const delivered = expectDefined(
        preparedWebPushSendMock.mock.calls[0],
        "expected a notification send",
      )[0].payload;
      expect(delivered).not.toHaveProperty("preview");
      expect(delivered.body).toBe("research: An agent completed its response.");
    });

    it("carries a producer-authorized simple question through the real connection broadcast", async () => {
      listBoundWebPushSubscriptionsMock.mockResolvedValue([previewSubscription("browser-device")]);
      listDevicePairingMock.mockReturnValue({
        paired: [pairedOperator("browser-device", ["operator.read", "operator.questions"])],
      });
      const record: QuestionRecord = {
        id: "request:42",
        agentId: "research",
        sessionKey,
        runId: "exact-run",
        createdAtMs: 1,
        expiresAtMs: 60_001,
        status: "pending",
        questions: [
          {
            questionId: "next",
            header: "Next",
            question: "Continue?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      };
      const { createGatewayConnectionState } = await import("./server-connection-state.js");
      const state = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(),
        bootId: "push-preview-test",
        cfg: {},
      });
      onTestFinished(() => state.mentionInbox.dispose());
      state.broadcast("question.requested", record, {
        questionPreview: { record, canPreview: () => true },
      });
      await authorityCompleted.promise;
      expect(preparedWebPushSendMock).toHaveBeenCalledOnce();
      expect(
        expectDefined(preparedWebPushSendMock.mock.calls[0], "expected a notification send")[0]
          .payload,
      ).toMatchObject({
        body: "Continue?\n• Yes\n• No",
        url: "ask/request%3A42",
        preview: {
          version: 1,
          kind: "question",
          requestId: "request:42",
          sessionKey,
          runId: "exact-run",
          expiresAtMs: 60_001,
          question: {
            id: "next",
            text: "Continue?",
            choices: ["Yes", "No"],
            allowTextReply: false,
          },
        },
      });
    });

    it.each(["retired", "different-record", "different-route", "missing-owner"])(
      "keeps question content generic for %s even with consent",
      async (caseName) => {
        listBoundWebPushSubscriptionsMock.mockResolvedValue([
          previewSubscription("browser-device"),
        ]);
        listDevicePairingMock.mockReturnValue({
          paired: [pairedOperator("browser-device", ["operator.read", "operator.questions"])],
        });
        const record: QuestionRecord = {
          id: "request:42",
          sessionKey,
          createdAtMs: 1,
          expiresAtMs: 60_001,
          status: "pending",
          questions: [{ questionId: "next", header: "Next", question: "Continue?", options: [] }],
        };
        const questionPreview =
          caseName === "missing-owner"
            ? undefined
            : {
                record: caseName === "different-record" ? { ...record } : record,
                canPreview: () => caseName !== "retired",
              };
        createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
          "question.requested",
          record,
          {
            ...scope,
            ...(caseName === "different-route" ? { sessionKeys: ["agent:research:other"] } : {}),
            questionPreview,
          },
        );
        await authorityCompleted.promise;
        expect(preparedWebPushSendMock).toHaveBeenCalledOnce();
        expect(
          expectDefined(preparedWebPushSendMock.mock.calls[0], "expected a notification send")[0]
            .payload,
        ).not.toHaveProperty("preview");
        expect(
          expectDefined(preparedWebPushSendMock.mock.calls[0], "expected a notification send")[0]
            .payload.body,
        ).toBe("research: An agent has a question for you.");
      },
    );

    it("keeps exact cron failure routing without exposing errors or output under either consent", async () => {
      listBoundWebPushSubscriptionsMock.mockResolvedValue([previewSubscription("browser-device")]);
      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
        "cron",
        {
          action: "finished",
          status: "error",
          jobId: "nightly",
          runId: "cron:nightly:42",
          error: "private failure detail",
          output: "private tool output",
        },
        scope,
      );
      await authorityCompleted.promise;
      expect(
        expectDefined(preparedWebPushSendMock.mock.calls[0], "expected a notification send")[0]
          .payload,
      ).toEqual({
        title: "OpenClaw scheduled task failed",
        body: "research: A scheduled task needs attention.",
        tag: "openclaw-cron-failed-nightly",
        renotify: false,
        url: "automations?job=nightly&run=cron%3Anightly%3A42",
      });
    });
  });
});

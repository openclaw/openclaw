import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { removePairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { WEB_PUSH_USER_PREFERENCES_KEY } from "../infra/push-web-preferences.js";
import {
  registerWebPushSubscription,
  setWebPushSubscriptionPreferences,
} from "../infra/push-web.js";
import { setCanonicalUserPreferences } from "../state/user-preferences.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OperatorScope } from "./operator-scopes.js";
import { QuestionManager } from "./question-manager.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createQuestionHandlers } from "./server-methods/question.js";
import { createSecretStoreWriteService } from "./server-methods/secrets.js";
import type { RespondFn } from "./server-methods/types.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import * as webPushAuthority from "./web-push-authority.js";

const sessionKey = "agent:main:delivery-proof";
const endpoint = "https://push.example.test/delivery-proof";
const deviceId = "delivery-proof-browser";
const scopes: OperatorScope[] = ["operator.read", "operator.questions"];
const preferences = {
  detailLevel: "detailed",
  answerPreviewConsentVersion: 1,
  questionPreviewConsentVersion: 1,
  categories: { agentFinished: true, agentQuestion: true },
};

afterEach(() => vi.restoreAllMocks());

function captureEncryptedPush() {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = randomBytes(16);
  const requests: Array<{ options: https.RequestOptions; body: Buffer }> = [];
  // Only the external HTTPS boundary is replaced. web-push still encrypts and signs.
  vi.spyOn(https, "request").mockImplementation((input, options, callback) => {
    if (typeof input !== "object" || input instanceof URL) {
      throw new Error("Expected Web Push HTTPS request options");
    }
    const respond = typeof options === "function" ? options : callback;
    const chunks: Buffer[] = [];
    const request = new ClientRequest({
      createConnection: () => new Socket(),
      agent: false,
    });
    vi.spyOn(request, "write").mockImplementation((chunk) => {
      chunks.push(Buffer.from(chunk));
      return true;
    });
    vi.spyOn(request, "end").mockImplementation(() => {
      requests.push({ options: input, body: Buffer.concat(chunks) });
      const response = new IncomingMessage(new Socket());
      response.statusCode = 201;
      response.headers = {};
      respond?.(response);
      response.emit("end");
      request.destroy();
      return request;
    });
    return request;
  });
  const decrypt = (index = 0): unknown => {
    const { body, options } = expectDefined(requests[index], "encrypted Web Push request");
    expect(options).toMatchObject({
      hostname: "push.example.test",
      path: "/delivery-proof",
      method: "POST",
      headers: { "Content-Encoding": "aes128gcm", TTL: 300 },
    });
    // RFC 8291 key schedule and RFC 8188 record framing, independent of web-push.
    const salt = body.subarray(0, 16);
    const keyLength = expectDefined(body[20], "Web Push sender key length");
    const senderKey = body.subarray(21, 21 + keyLength);
    const keyInfo = Buffer.concat([
      Buffer.from("WebPush: info\0"),
      receiver.getPublicKey(),
      senderKey,
    ]);
    const ikm = hkdfSync("sha256", receiver.computeSecret(senderKey), auth, keyInfo, 32);
    const key = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
    const nonce = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
    const ciphertext = body.subarray(21 + keyLength);
    const decipher = createDecipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, -16)),
      decipher.final(),
    ]);
    expect(plaintext.at(-1)).toBe(2);
    return JSON.parse(plaintext.subarray(0, -1).toString("utf8"));
  };
  return {
    requests,
    decrypt,
    keys: {
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
}

function observeDelivery() {
  const started = createDeferred<{ settled: Promise<unknown> }>();
  const original = webPushAuthority.withCurrentWebPushAuthority;
  // Observe the real promise to join void broadcast delivery, without replacing
  // authority decisions, storage reads, preparation, or the prepared sender.
  vi.spyOn(webPushAuthority, "withCurrentWebPushAuthority").mockImplementation(function observed<T>(
    params: Parameters<typeof original>[0],
    prepare: (
      authority: webPushAuthority.WebPushAuthority,
    ) => { start: () => T | Promise<T> } | undefined,
  ) {
    const settled = original(params, prepare);
    started.resolve({ settled });
    return settled;
  });
  return started.promise;
}

async function withDeliveryFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: {
        OPENCLAW_VAPID_PUBLIC_KEY: undefined,
        OPENCLAW_VAPID_PRIVATE_KEY: undefined,
        OPENCLAW_VAPID_SUBJECT: undefined,
      },
    },
    async (state) => {
      const fixture = await createFixture(state);
      try {
        await run(fixture);
      } finally {
        fixture.manager.close();
        await fixture.manager.drain();
        fixture.detach();
        fixture.projection.dispose();
        await fixture.connection.mentionInbox.dispose();
      }
    },
  );
}

async function createFixture(state: Parameters<Parameters<typeof withOpenClawTestState>[1]>[0]) {
  const capture = captureEncryptedPush();
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "member",
        definitions: {
          member: { agents: "*", sessions: { others: "none" }, scopes },
        },
      },
    },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const owner = ensureProfileForEmail("owner@example.test");
  const stranger = ensureProfileForEmail("stranger@example.test");
  const requested = await requestDevicePairing({
    deviceId,
    publicKey: "synthetic-pairing-public-key",
    role: "operator",
    scopes,
  });
  expect(
    await approveDevicePairing(requested.request.requestId, { callerScopes: ["operator.admin"] }),
  ).toMatchObject({ status: "approved" });
  const bind = async (profileId: string) => {
    await registerWebPushSubscription({
      endpoint,
      keys: capture.keys,
      binding: { deviceId, userProfileId: profileId },
    });
    expect(
      await setWebPushSubscriptionPreferences({
        endpoint,
        expectedDeviceId: deviceId,
        expectedUserProfileId: profileId,
        preferences: { enabled: true, label: "" },
      }),
    ).toBe(true);
    expect(
      await setCanonicalUserPreferences(profileId, {
        [WEB_PUSH_USER_PREFERENCES_KEY]: preferences,
      }),
    ).toMatchObject({ ok: true });
  };
  await bind(owner.id);
  const entry = {
    sessionId: "delivery-session",
    lifecycleRevision: "delivery-generation",
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
  };
  await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
  const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  const scheduler = createTestGatewayScheduler();
  const connection = createGatewayConnectionState({ cfg, scheduler, bootId: "delivery-proof" });
  const detach = connection.attachSessionRowProjection(projection);
  await upsertSessionEntryCore({ agentId: "main", sessionKey }, { ...entry, updatedAt: 2 });
  expect(projection.capture({ agentId: "main", key: sessionKey })?.publishedSource).toBeDefined();
  const manager = new QuestionManager(scheduler);
  const handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    scheduler,
  );
  const answer = () =>
    connection.broadcast(
      "chat",
      {
        state: "final",
        runId: "answer-run",
        sessionKey,
        message: { role: "assistant", content: [{ type: "text", text: "The draft is ready." }] },
      },
      { agentId: "main", sessionKeys: [sessionKey] },
    );
  const question = async () => {
    const params = {
      id: "question:42",
      agentId: "main",
      sessionKey,
      runId: "question-run",
      timeoutMs: 60_000,
      questions: [
        {
          questionId: "next",
          header: "Next",
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    };
    const responses: Parameters<RespondFn>[] = [];
    await expectDefined(
      handlers["question.request"],
      "question request handler",
    )({
      req: { type: "req", id: "request", method: "question.request", params },
      params,
      client: sharingPolicyClient({ scopes: ["operator.admin"] }),
      respond: (...args) => responses.push(args),
      isWebchatConnect: () => false,
      context: createDirectChatContext({
        getRuntimeConfig: () => cfg,
        broadcast: connection.broadcast,
        questionManager: manager,
      }),
    });
    expect(responses).toMatchObject([[true, { id: "question:42" }, undefined]]);
    return expectDefined(manager.get("question:42"), "canonical pending question");
  };
  return { capture, connection, projection, detach, manager, answer, question, bind, stranger };
}

it("delivers a consented answer through real authority and encrypted Web Push", async () => {
  await withDeliveryFixture(async ({ answer, capture }) => {
    const delivery = observeDelivery();
    answer();
    await (
      await delivery
    ).settled;
    expect(capture.requests).toHaveLength(1);
    expect(capture.decrypt()).toEqual({
      title: "OpenClaw agent finished",
      body: "The draft is ready.",
      tag: "openclaw-agent-finished-answer-run",
      renotify: false,
      url: "chat/main/delivery-proof",
      preview: {
        version: 1,
        kind: "answer",
        sessionKey,
        runId: "answer-run",
        text: "The draft is ready.",
      },
    });
  });
});

it("delivers exact simple question choices from the real question owner", async () => {
  await withDeliveryFixture(async ({ question, capture }) => {
    const delivery = observeDelivery();
    const record = await question();
    await (
      await delivery
    ).settled;
    expect(capture.requests).toHaveLength(1);
    expect(capture.decrypt()).toEqual({
      title: "OpenClaw needs an answer",
      body: "Continue?\n• Yes\n• No",
      tag: "openclaw-question-question:42",
      renotify: false,
      url: "ask/question%3A42",
      preview: {
        version: 1,
        kind: "question",
        requestId: "question:42",
        sessionKey,
        runId: "question-run",
        expiresAtMs: record.expiresAtMs,
        question: { id: "next", text: "Continue?", choices: ["Yes", "No"], allowTextReply: false },
      },
    });
  });
});

it("rejects a paired consented recipient without session access before any HTTPS request", async () => {
  await withDeliveryFixture(async ({ answer, bind, stranger, capture }) => {
    await bind(stranger.id);
    const delivery = observeDelivery();
    answer();
    await (
      await delivery
    ).settled;
    expect(capture.requests).toEqual([]);
    expect(https.request).not.toHaveBeenCalled();
  });
});

it("rechecks a real pairing revocation during preparation before any HTTPS request", async () => {
  await withDeliveryFixture(async ({ answer, capture }) => {
    const held = createDeferred();
    const mutate = createDeferred();
    const locked = withDevicePairingLock(async () => {
      held.resolve();
      await mutate.promise;
      await removePairedDevice(deviceId);
    });
    await held.promise;
    const delivery = observeDelivery();
    answer();
    try {
      const pending = await delivery;
      expect(capture.requests).toEqual([]);
      mutate.resolve();
      await locked;
      await pending.settled;
      expect(capture.requests).toEqual([]);
      expect(https.request).not.toHaveBeenCalled();
    } finally {
      mutate.resolve();
      await locked;
    }
  });
});

it("suppresses content when the original question retires during preparation", async () => {
  await withDeliveryFixture(async ({ question, manager, capture }) => {
    const held = createDeferred();
    const release = createDeferred();
    const locked = withDevicePairingLock(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const delivery = observeDelivery();
    try {
      await question();
      const pending = await delivery;
      manager.reset();
      expect(capture.requests).toEqual([]);
      release.resolve();
      await locked;
      await pending.settled;
      expect(capture.requests).toHaveLength(1);
      expect(capture.decrypt()).toEqual({
        title: "OpenClaw needs an answer",
        body: "main: An agent has a question for you.",
        tag: "openclaw-question-question:42",
        renotify: false,
        url: "ask/question%3A42",
      });
    } finally {
      release.resolve();
      await locked;
    }
  });
});

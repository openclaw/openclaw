import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { findChatSubmissionMessage } from "../lib/chat/history-message-identity.ts";
import { shouldDisplayChatSubmission } from "../pages/chat/history-merge.ts";
import { buildInitialChatSubmission } from "../pages/chat/user-message-content.ts";
import { createChatSubmissions, type RetainedChatSubmission } from "./chat-submissions.ts";

function message(text: string): NonNullable<RetainedChatSubmission["message"]> {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1, __openclaw: {} };
}

type Draft = RetainedChatSubmission["message"];
function pending(sessionKey: string, draft: Draft = null, canDisplay = () => true) {
  return { creation: { sessionKey, admitted: false }, message: draft, canDisplay };
}

it.each([
  ["initial", 32],
  ["delivered", 64],
] as const)("bounds %s retention and clears on disposal", (kind, limit) => {
  const submissions = createChatSubmissions();
  const owner = {};
  const retain = (index: number, client = owner) =>
    submissions.retain({
      kind,
      deliveryKey: String(index),
      sessionKey: `agent:main:retained-${index}`,
      pendingRunId: String(index),
      message: message(String(index)),
      owner: client,
    });
  const read = (index: number, client = owner) =>
    kind === "initial"
      ? submissions.readInitial(`agent:main:retained-${index}`, client)
      : submissions.readDelivered(String(index), client);
  for (let index = 0; index <= limit; index++) {
    retain(index);
  }
  expect(read(0)).toBeFalsy();
  expect(read(1)).toMatchObject({
    message: { content: [{ type: "text", text: "1" }] },
    pendingRunId: "1",
  });
  expect(read(limit)?.pendingRunId).toBe(String(limit));
  expect(read(1, {})).toBeFalsy();
  const replacement = expectDefined(retain(1), "retained submission");
  const replacementMessage = expectDefined(replacement.message, "pending display");
  const receipt = {
    ...replacementMessage,
    __openclaw: { id: "receipt", idempotencyKey: `${replacement.pendingRunId}:user` },
  };
  const accepted = findChatSubmissionMessage([receipt], replacement.pendingRunId, true);
  expect(shouldDisplayChatSubmission(replacement, accepted)).toBe(false);
  expect(read(1)?.pending).toBe(false);
  expect(read(1, {})).toBeFalsy();
  if (kind === "delivered") {
    const otherClient = {};
    retain(1, otherClient);
    expect(read(1)?.pending).toBe(false);
    expect(read(1, otherClient)?.pending).toBe(true);
  }
  submissions.clear();
  expect(read(1)).toBeFalsy();
  expect(read(limit)).toBeFalsy();
});

it("prepares accepted prompts only with explicit run ownership", () => {
  const url = "data:image/png;base64,iVBORw0KGgo=";
  const sessionKey = "agent:main:main";
  const client = {};
  const handoff = createChatSubmissions();
  const item = {
    text: "image",
    attachments: [
      { id: "img", mimeType: "image/png", fileName: "x.png", sizeBytes: 68, dataUrl: url },
    ],
    createdAt: 123,
    sender: { id: "u1", name: "Alice" },
  };

  handoff.retain(buildInitialChatSubmission(sessionKey, item, client));
  expect(handoff.readInitial(sessionKey, client)).toBeNull();

  handoff.retain(buildInitialChatSubmission(sessionKey, item, client, "run"));

  expect(handoff.readInitial("main", client)).toEqual({
    kind: "initial",
    sessionKey,
    owner: client,
    pendingRunId: "run",
    pending: true,
    message: {
      role: "user",
      content: [
        { type: "text", text: "image" },
        { type: "image", url, fileName: "x.png", source: { type: "url", url } },
      ],
      timestamp: 123,
      __openclaw: { idempotencyKey: "run:user", senderId: "u1", senderName: "Alice" },
    },
  });
});

it("exposes pre-admission bytes only to the live owner and retains route metadata after disposal", () => {
  const submissions = createChatSubmissions();
  const key = "agent:main:dashboard:private";
  let authorized = true;
  const release = submissions.beginCreate({
    ...pending(key, message("private draft"), () => authorized),
    displayName: "Private title",
  });
  expect(submissions.readCreateMessage(key)?.content).toEqual([
    { type: "text", text: "private draft" },
  ]);
  expect(submissions.readCreateMessage("agent:main:dashboard:other")).toBeNull();
  expect(submissions.readCreate()?.displayName).toBe("Private title");
  authorized = false;
  expect(submissions.readCreate()).toBeUndefined();
  expect(submissions.readCreateMessage(key)).toBeNull();
  const routeCreation = submissions.creation;
  release();
  expect(submissions.readCreateMessage(key)).toBeNull();
  expect(submissions.creation).toBeUndefined();
  expect(submissions.readCreate()).toBeUndefined();
  expect(routeCreation?.admitted).toBe(false);
});

it.each(["resumed", "newer"])("retired attempts cannot clear %s successors", (next) => {
  const submissions = createChatSubmissions();
  const key = "agent:main:dashboard:resumed";
  const nextKey = `agent:main:dashboard:${next}`;
  const releaseOld = submissions.beginCreate(pending(key));
  const releaseCurrent = submissions.beginCreate(pending(nextKey, message("current draft")));
  releaseOld();
  expect(submissions.readCreateMessage(nextKey)).not.toBeNull();
  releaseCurrent();
  expect(submissions.readCreateMessage(nextKey)).toBeNull();
});

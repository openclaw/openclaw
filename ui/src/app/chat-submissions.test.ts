import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { findChatSubmissionMessage } from "../lib/chat/history-message-identity.ts";
import { shouldDisplayChatSubmission } from "../pages/chat/history-merge.ts";
import { buildInitialChatSubmission } from "../pages/chat/user-message-content.ts";
import { createChatSubmissions, type RetainedChatSubmission } from "./chat-submissions.ts";

function message(text: string): NonNullable<RetainedChatSubmission["message"]> {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1, __openclaw: {} };
}

describe("retained chat submissions", () => {
  it.each([
    { kind: "initial", limit: 32 },
    { kind: "delivered", limit: 64 },
  ] as const)(
    "bounds $kind display retention and clears it at application disposal",
    ({ kind, limit }) => {
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
      expect(read(1)?.message?.content).toEqual([{ type: "text", text: "1" }]);
      expect(read(1)?.pendingRunId).toBe("1");
      expect(read(limit)?.pendingRunId).toBe(String(limit));
      expect(read(1, {})).toBeFalsy();
      const replacement = expectDefined(retain(1), "retained submission");
      const replacementMessage = expectDefined(replacement.message, "pending display");
      expect(
        shouldDisplayChatSubmission(
          replacement,
          findChatSubmissionMessage(
            [
              {
                ...replacementMessage,
                __openclaw: { id: "receipt", idempotencyKey: `${replacement.pendingRunId}:user` },
              },
            ],
            replacement.pendingRunId,
            true,
          ),
        ),
      ).toBe(false);
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
    },
  );
});

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

describe("initial user message handoff", () => {
  it("prepares accepted prompts only with explicit run ownership", () => {
    const sessionKey = "agent:main:main";
    const client = {};
    const handoff = createChatSubmissions();
    const item = {
      text: "inspect this image",
      attachments: [
        {
          id: "image-1",
          mimeType: "image/png",
          fileName: "image.png",
          sizeBytes: 68,
          dataUrl: imageDataUrl,
        },
      ],
      createdAt: 123,
      sender: { id: "profile-1", name: "Alice Example" },
    };

    handoff.retain(buildInitialChatSubmission(sessionKey, item, client));
    expect(handoff.readInitial(sessionKey, client)).toBeNull();

    handoff.retain(buildInitialChatSubmission(sessionKey, item, client, "initial-image-run"));

    expect(handoff.readInitial("main", client)).toEqual({
      kind: "initial",
      sessionKey,
      owner: client,
      pendingRunId: "initial-image-run",
      pending: true,
      message: {
        role: "user",
        content: [
          { type: "text", text: "inspect this image" },
          {
            type: "image",
            url: imageDataUrl,
            fileName: "image.png",
            source: { type: "url", url: imageDataUrl },
          },
        ],
        timestamp: 123,
        __openclaw: {
          idempotencyKey: "initial-image-run:user",
          senderId: "profile-1",
          senderName: "Alice Example",
        },
      },
    });
  });
});

describe("pending create display authority", () => {
  it("exposes pre-admission bytes only to the live owner and retains route metadata after disposal", () => {
    const submissions = createChatSubmissions();
    const key = "agent:main:dashboard:private";
    let authorized = true;
    const release = submissions.beginCreate({
      creation: { sessionKey: key, admitted: false },
      message: message("private synthetic draft"),
      canDisplay: () => authorized,
    });
    expect(submissions.readCreateMessage(key)?.content).toEqual([
      { type: "text", text: "private synthetic draft" },
    ]);
    expect(submissions.readCreateMessage("agent:main:dashboard:other")).toBeNull();
    authorized = false;
    expect(submissions.readCreateMessage(key)).toBeNull();
    const routeCreation = submissions.creation;
    release();
    expect(submissions.readCreateMessage(key)).toBeNull();
    expect(submissions.creation).toBeUndefined();
    expect(routeCreation?.admitted).toBe(false);
  });

  it.each(["agent:main:dashboard:resumed", "agent:main:dashboard:newer"])(
    "a retired attempt cannot clear successor %s",
    (nextKey) => {
      const submissions = createChatSubmissions();
      const key = "agent:main:dashboard:resumed";
      const releaseOld = submissions.beginCreate({
        creation: { sessionKey: key, admitted: false },
        message: null,
        canDisplay: () => true,
      });
      const releaseCurrent = submissions.beginCreate({
        creation: { sessionKey: nextKey, admitted: false },
        message: message("current draft"),
        canDisplay: () => true,
      });
      releaseOld();
      expect(submissions.readCreateMessage(nextKey)).not.toBeNull();
      releaseCurrent();
      expect(submissions.readCreateMessage(nextKey)).toBeNull();
    },
  );
});

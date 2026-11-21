import { expect, it, vi } from "vitest";
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
  expect(read(1)?.message).toEqual(message("1"));
  expect(read(limit)?.pendingRunId).toBe(String(limit));
  expect(read(1, {})).toBeFalsy();
  if (kind === "delivered") {
    const otherClient = {};
    retain(1, otherClient);
    expect(read(1)?.owner).toBe(owner);
    expect(read(1, otherClient)?.pending).toBe(true);
  }
  submissions.clear();
  expect(read(1)).toBeFalsy();
  expect(read(limit)).toBeFalsy();
});

it("prepares accepted prompts only with explicit run ownership", () => {
  const sessionKey = "agent:main:main";
  const client = {};
  const handoff = createChatSubmissions();
  const item = { text: "prompt", createdAt: 123 };
  handoff.retain(buildInitialChatSubmission(sessionKey, item, client));
  expect(handoff.readInitial(sessionKey, client)).toBeNull();
  handoff.retain(buildInitialChatSubmission(sessionKey, item, client, "run"));
  const retained = handoff.readInitial("main", client);
  expect(retained?.pendingRunId).toBe("run");
  expect(retained?.message?.["__openclaw"].idempotencyKey).toBe("run:user");
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

it("keeps background start previews per session and only for their owner", () => {
  const submissions = createChatSubmissions();
  const listener = vi.fn();
  submissions.subscribeCreate(listener);
  let visible = true;
  const first = { sessionKey: "agent:main:dashboard:first", admitted: false };
  const second = { sessionKey: "agent:main:dashboard:second", admitted: false };
  const firstPreview = submissions.beginBackgroundCreate({
    creation: first,
    message: null,
    canDisplay: () => visible,
  });
  const secondPending = { creation: second, message: null, canDisplay: () => true };
  const secondPreview = submissions.beginBackgroundCreate(secondPending);
  expect(submissions.creating).toBe(true);
  expect(submissions.creation).toBeUndefined();
  expect(submissions.creationFor(first.sessionKey)).toBe(first);
  expect(submissions.creationFor(second.sessionKey)).toBe(second);
  expect(submissions.creationFor("agent:main:dashboard:other")).toBeUndefined();

  // Another owner's presentation never sees the preview.
  visible = false;
  expect(submissions.creationFor(first.sessionKey)).toBeUndefined();
  expect(submissions.readCreateFor(first.sessionKey)).toBeUndefined();
  visible = true;

  const retry = vi.fn();
  secondPreview.update({ ...secondPending, failure: { error: "Refused", retry } });
  expect(submissions.readCreateFor(second.sessionKey)?.failure?.error).toBe("Refused");
  // A replaced preview cannot be cleared or updated by its previous handle.
  const replacement = submissions.beginBackgroundCreate(secondPending);
  secondPreview.clear();
  secondPreview.update({ ...secondPending, failure: { error: "Stale", retry } });
  expect(submissions.readCreateFor(second.sessionKey)).toBe(secondPending);
  replacement.clear();
  firstPreview.clear();
  expect(submissions.creating).toBe(false);
  expect(submissions.creationFor(second.sessionKey)).toBeUndefined();
  expect(listener).toHaveBeenCalledTimes(6);
});

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "../chat/attachment-payload-store.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { resetWorktreeMocks } from "./draft-worktree-checks.test-support.ts";
import { completeInitialSessionTurn } from "./initial-session-turn-handoff.ts";
import { InstantThreadHandoff } from "./instant-thread-handoff.ts";
import * as rejected from "./rejected-initial-turn.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";

afterEach(resetWorktreeMocks);

function turnFixture() {
  const { context } = createDraftFixture();
  return {
    context,
    navigation: new StartedSessionNavigation(),
    client: context.gateway.snapshot.client!,
    agentId: "main",
    clearDraft: vi.fn(async () => {}),
    completeInBackground: () => false,
    finishNavigation: vi.fn(),
  };
}

function previewFixture(key: string, navigate = () => Promise.resolve()) {
  const fixture = turnFixture();
  const { context, navigation } = fixture;
  Object.defineProperty(context, "router", {
    value: { getState: () => ({ location: undefined }), subscribe: () => () => {}, navigate },
  });
  Object.defineProperty(context.gateway, "subscribe", { value: () => () => {} });
  const instant = new InstantThreadHandoff(
    context,
    key,
    "main",
    {
      data: {
        agentId: "main",
        requestedAgentId: "main",
        catalogId: "",
        catalogLabel: "",
        startTerminal: false,
      },
      page: document.createElement("div"),
      release: vi.fn(),
      synchronizeGateway: vi.fn(),
    },
    null,
  );
  onTestFinished(() => instant.dispose());
  vi.spyOn(navigation, "navigate").mockResolvedValue();
  return { ...fixture, instant, isCurrent: () => true };
}

it("retires an accepted draft before a slow preview route is ready", async () => {
  const key = "agent:main:accepted-before-preview";
  const ready = createDeferred();
  const fixture = previewFixture(key, () => ready.promise);
  const { context, client, clearDraft } = fixture;
  const completion = completeInitialSessionTurn({
    ...fixture,
    result: { key, initialRun: { status: "started", runId: "accepted-run" } },
    turn: { text: "Accepted prompt", attachments: [], createdAt: 1 },
  });
  try {
    // Acceptance, not lazy route readiness or storage completion, consumes input.
    expect(clearDraft).toHaveBeenCalledOnce();
    expect(context.chatSubmissions.readInitial(key, client)).toBeNull();
  } finally {
    ready.resolve();
    await completion;
  }
});

it.each([
  { status: "started", change: "scope" },
  { status: "rejected", change: "request" },
  { status: "started", change: "unchanged" },
  { status: "rejected", change: "unchanged" },
] as const)(
  "rechecks $change authority before publishing a $status turn",
  async ({ status, change }) => {
    const key = "agent:main:dashboard:incognito-private";
    const fixture = previewFixture(key);
    const { context, instant, clearDraft, navigation, client } = fixture;
    // Settle preview readiness, then invalidate ownership in the microtask
    // between checking readiness and publishing the first-turn result.
    await instant.waitForReady();
    expect(instant.isCurrent()).toBe(true);
    const auth = context.gateway.snapshot.hello!.auth!;
    const retainRejected = vi.spyOn(rejected, "retainRejectedInitialTurn");
    const navigate = vi.mocked(navigation.navigate);
    const text = "private incognito first turn";
    const initialRun =
      status === "started"
        ? { status, runId: "private-run" }
        : { status, error: "synthetic denial" };
    let current = true;
    const completion = completeInitialSessionTurn({
      ...fixture,
      result: { key, initialRun },
      turn: { text, attachments: [], createdAt: 1 },
      isCurrent: () => current,
    });
    queueMicrotask(() => {
      if (change === "scope") {
        auth.recoveryScope = "replacement-principal";
      } else if (change === "request") {
        current = false;
      }
    });
    await completion;
    if (change === "unchanged") {
      expect(navigate).toHaveBeenCalledOnce();
      expect(clearDraft).toHaveBeenCalledOnce();
      if (status === "started") {
        expect(context.chatSubmissions.readInitial(key, client)?.message?.content).toContainEqual({
          type: "text",
          text,
        });
      } else {
        expect(retainRejected).toHaveBeenCalledOnce();
      }
    } else {
      expect(navigate).not.toHaveBeenCalled();
      expect(context.chatSubmissions.readInitial(key, client)).toBeNull();
      expect(retainRejected).not.toHaveBeenCalled();
      expect(JSON.stringify(localStorage)).not.toContain(text);
      expect(clearDraft.mock.calls).toEqual(status === "started" ? [[true, undefined]] : []);
    }
  },
);

it.each([true, false])("publishes launcher rejection only to its owner (%s)", async (current) => {
  const fixture = turnFixture();
  const { navigation, clearDraft } = fixture;
  const attachment = current
    ? registerChatAttachmentPayload({
        attachment: { id: "launcher-image", mimeType: "image/png", fileName: "image.png" },
        dataUrl: "data:image/png;base64,aW1hZ2U=",
        file: new File(["image"], "image.png", { type: "image/png" }),
      })
    : undefined;
  const retain = vi.spyOn(rejected, "retainRejectedInitialTurn").mockReturnValue(false);
  const navigate = current ? undefined : vi.spyOn(navigation, "navigate").mockResolvedValue();
  const onRejectedPrompt = vi.fn();
  const onAccepted = vi.fn();
  onTestFinished(() => releaseChatAttachmentPayloads(attachment ? [attachment] : []));
  const error = current ? "Rejected image" : "First turn denied";
  await completeInitialSessionTurn({
    ...fixture,
    result: { key: "agent:main:dashboard:rejected", initialRun: { status: "rejected", error } },
    turn: {
      text: current ? "" : "Keep this prompt visible",
      attachments: attachment ? [attachment] : [],
      createdAt: 1,
    },
    instant: undefined,
    isCurrent: () => current,
    completeInBackground: () => true,
    onRejectedPrompt,
    onAccepted: current ? undefined : onAccepted,
  });
  expect(clearDraft).not.toHaveBeenCalled();
  if (attachment) {
    const destination = retain.mock.calls[0]![0].attachments;
    expect(destination).toHaveLength(1);
    expect(destination[0]!.id).not.toBe(attachment.id);
    expect(getChatAttachmentDataUrl(attachment)).toBe("data:image/png;base64,aW1hZ2U=");
    releaseChatAttachmentPayloads([attachment]);
    expect(getChatAttachmentDataUrl(destination[0]!)).toBe("data:image/png;base64,aW1hZ2U=");
    expect(onRejectedPrompt).toHaveBeenCalledExactlyOnceWith(error);
  } else {
    expect(navigate).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onRejectedPrompt).not.toHaveBeenCalled();
  }
});

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "../chat/attachment-payload-store.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { completeInitialSessionTurn } from "./initial-session-turn-handoff.ts";
import { InstantThreadHandoff } from "./instant-thread-handoff.ts";
import { createNewSessionRouteData } from "./location.test-support.ts";
import * as rejected from "./rejected-initial-turn.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

type Completion = Parameters<typeof completeInitialSessionTurn>[0];
function completionFixture(instantKey?: string, navigate = () => Promise.resolve()) {
  const { context } = createDraftFixture();
  if (instantKey) {
    Object.defineProperty(context, "router", {
      value: { getState: () => ({ location: undefined }), subscribe: () => () => {}, navigate },
    });
  }
  const instant = instantKey
    ? new InstantThreadHandoff(
        context,
        instantKey,
        "main",
        {
          data: createNewSessionRouteData(),
          page: document.createElement("div"),
          release: vi.fn(),
          synchronizeGateway: vi.fn(),
        },
        null,
      )
    : undefined;
  const navigation = new StartedSessionNavigation();
  const options = {
    context,
    client: context.gateway.snapshot.client!,
    agentId: "main",
    instant,
    navigation,
    isCurrent: () => true,
    clearDraft: vi.fn(async () => {}),
    completeInBackground: () => false,
    finishNavigation: vi.fn(),
  };
  return {
    ...options,
    complete: (
      turn: Completion["turn"],
      result: Completion["result"],
      overrides: Partial<Completion> = {},
    ) => completeInitialSessionTurn({ ...options, turn, result, ...overrides }),
  };
}

describe("first-turn publication", () => {
  it("retires an accepted draft before a slow preview route is ready", async () => {
    let ready!: () => void;
    const key = "agent:main:accepted-before-preview";
    const { context, client, clearDraft, navigation, complete, instant } = completionFixture(
      key,
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    vi.spyOn(navigation, "navigate").mockResolvedValue();
    const completion = complete(
      { text: "Accepted prompt", attachments: [], createdAt: 1 },
      { key, initialRun: { status: "started", runId: "accepted-run" } },
    );
    try {
      // Acceptance, not lazy route readiness or storage completion, consumes input.
      expect(clearDraft).toHaveBeenCalledOnce();
      expect(context.chatSubmissions.readInitial(key, client)).toBeNull();
    } finally {
      ready();
      await completion;
      instant!.dispose();
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
      const { context, instant, client, clearDraft, navigation, complete } = completionFixture(key);
      try {
        // Settle preview readiness, then invalidate ownership in the microtask
        // between checking readiness and publishing the first-turn result.
        await instant!.waitForReady();
        expect(instant!.isCurrent()).toBe(true);
        const auth = context.gateway.snapshot.hello?.auth;
        if (!client || !auth) {
          throw new Error("fixture requires authenticated client");
        }
        const retainRejected = vi.spyOn(rejected, "retainRejectedInitialTurn");
        const navigate = vi.spyOn(navigation, "navigate").mockResolvedValue();
        let current = true;
        const completion = complete(
          { text: "private incognito first turn", attachments: [], createdAt: 1 },
          {
            key,
            initialRun:
              status === "started"
                ? { status, runId: "private-run" }
                : { status, error: "synthetic denial" },
          },
          { isCurrent: () => current },
        );
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
            expect(
              context.chatSubmissions.readInitial(key, client)?.message?.content,
            ).toContainEqual({
              type: "text",
              text: "private incognito first turn",
            });
          } else {
            expect(retainRejected).toHaveBeenCalledOnce();
          }
        } else {
          expect(navigate).not.toHaveBeenCalled();
          expect(context.chatSubmissions.readInitial(key, client)).toBeNull();
          expect(retainRejected).not.toHaveBeenCalled();
          expect(JSON.stringify(localStorage)).not.toContain("private incognito first turn");
          if (status === "started") {
            expect(clearDraft).toHaveBeenCalledWith(true, undefined);
          } else {
            expect(clearDraft).not.toHaveBeenCalled();
          }
        }
      } finally {
        instant!.dispose();
      }
    },
  );
});

describe("retained launcher rejection", () => {
  it.each([true, false])(
    "publishes launcher rejection only for its current owner (%s)",
    async (current) => {
      const { navigation, clearDraft, complete } = completionFixture();
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
      await complete(
        {
          text: current ? "" : "Keep this prompt visible",
          attachments: attachment ? [attachment] : [],
          createdAt: 1,
        },
        { key: "agent:main:dashboard:rejected", initialRun: { status: "rejected", error } },
        {
          isCurrent: () => current,
          completeInBackground: () => true,
          onRejectedPrompt,
          onAccepted: current ? undefined : onAccepted,
        },
      );
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
    },
  );
});

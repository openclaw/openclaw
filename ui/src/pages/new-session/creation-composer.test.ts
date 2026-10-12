import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "../chat/attachment-payload-store.ts";
import {
  CreationComposer,
  retainCreatedComposer,
  takeCreatedComposer,
} from "./creation-composer.ts";
import { createDraftFixture, registerTextPayload } from "./draft-submission-flow.test-support.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";

function fixture(incognito = false) {
  const { context, request } = createDraftFixture();
  const composer = new CreationComposer(context, "main", incognito, vi.fn());
  onTestFinished(() => {
    context.chatSubmissions.clear();
    composer.dispose();
  });
  return { context, request, composer };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("creation-owned follow-up input", () => {
  it("stages ordered messages and files without a destination, persistence, or RPC", () => {
    const { composer, request } = fixture(true);
    const file = registerTextPayload("private-follow-up");
    composer.setMessage("  first  ");
    composer.attachmentDraft.replace([file]);
    const previousRequests = request.mock.calls.length;
    const storedBefore = JSON.stringify({ localStorage, sessionStorage });
    expect(composer.enqueue()).toBe(true);
    composer.setMessage("second");
    expect(composer.enqueue()).toBe(true);
    composer.setMessage("unfinished follow-up");
    expect(composer.inputs.map((input) => input.text)).toEqual(["first", "second"]);
    expect(new Set(composer.inputs.map((input) => input.id)).size).toBe(2);
    expect(composer.inputs[0]).not.toHaveProperty("sessionKey");
    expect(composer.inputs[0]).not.toHaveProperty("sendRunId");
    expect(getChatAttachmentDataUrl(composer.inputs[0]!.attachments[0]!)).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(previousRequests);
    expect(JSON.stringify({ localStorage, sessionStorage })).toBe(storedBefore);
    expect(composer.message).toBe("unfinished follow-up");
    expect(canReloadControlUiDocument()).toBe(false);
  });

  it("keeps the original prompt, staged followers and unfinished draft through rejection and retry", async () => {
    const { context, flow } = createDraftFixture({
      retainForHandoff: () => undefined,
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    onTestFinished(() => {
      context.chatSubmissions.clear();
      flow.disconnect();
    });
    vi.spyOn(StartedSessionNavigation.prototype, "navigate").mockResolvedValue();
    const create = createDeferred<SessionCreateOutcome | null>();
    vi.mocked(context.sessions.createResult).mockReturnValue(create.promise);
    flow.setMessage("original prompt");
    const first = flow.submit();
    const composer = flow.creationComposer!;
    composer.setMessage("queued follower");
    composer.enqueue();
    const id = composer.inputs[0]!.id;
    composer.setMessage("unfinished follower");
    create.resolve(null);
    await first;
    expect(flow.message).toBe("original prompt");
    expect(composer.inputs[0]!.id).toBe(id);
    expect(composer.message).toBe("unfinished follower");
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:canonical",
      initialRun: { status: "idle" },
    });
    flow.setVisibility("incognito");
    await flow.submit();
    expect(flow.message).toBe("");
    const transfer = takeCreatedComposer(
      context,
      "agent:main:canonical",
      context.gateway.snapshot.client,
    );
    expect(transfer?.inputs[0]?.id).toBe(id);
    expect(transfer?.draft).toBe("unfinished follower");
    expect(transfer?.incognito).toBe(true);
    expect(transfer?.claimDraft()).toBe(true);
    expect(transfer?.claimDraft()).toBe(false);
    expect(canReloadControlUiDocument()).toBe(false);
    const unloading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    expect(
      takeCreatedComposer(context, "agent:main:canonical", context.gateway.snapshot.client),
    ).toBe(transfer);
    transfer?.complete();
    const released = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
    expect(
      takeCreatedComposer(context, "agent:main:canonical", context.gateway.snapshot.client),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "hands local input to the current client before recovery readiness (replacement: %s)",
    (replacement) => {
      const { context, composer, request } = fixture(true);
      composer.setMessage("accepted private draft");
      composer.accept({ key: "agent:main:canonical", initialRun: { status: "idle" } });
      retainCreatedComposer(context, "agent:main:canonical", composer);
      const original = context.gateway.snapshot.client!;
      if (replacement) {
        const next = createTestGatewayClient(request);
        vi.spyOn(next, "recoveryScope", "get").mockReturnValue(original.recoveryScope);
        context.gateway.snapshot.client = next;
      }
      Object.defineProperty(context.gateway.snapshot.client!, "recoveryScopeReady", {
        value: false,
        configurable: true,
      });
      const transferred = takeCreatedComposer(
        context,
        "agent:main:canonical",
        context.gateway.snapshot.client,
      );
      expect(transferred?.draft).toBe("accepted private draft");
      expect(transferred?.isCurrent()).toBe(true);
      expect(
        takeCreatedComposer(context, "agent:main:canonical", context.gateway.snapshot.client),
      ).toBe(transferred);
      transferred?.complete();
      expect(
        takeCreatedComposer(context, "agent:main:canonical", context.gateway.snapshot.client),
      ).toBeUndefined();
    },
  );

  it("preserves queued input across reconnect but never reveals it to another owner", () => {
    const { context, composer } = fixture(true);
    composer.setMessage("private queued");
    composer.enqueue();
    composer.setMessage("private draft");
    context.gateway.snapshot.phase = "reconnecting";
    expect(composer.canDisplay()).toBe(true);
    context.gateway.snapshot.phase = "connected";
    expect(composer.canDisplay()).toBe(true);
    context.gateway.snapshot.hello!.auth!.recoveryScope = "other-principal";
    expect(composer.canDisplay()).toBe(false);
    expect(composer.enqueue()).toBe(false);
    composer.accept({ key: "agent:main:canonical", initialRun: { status: "idle" } });
    expect(composer.take()).toBeUndefined();
  });

  it("hands unfinished file reads to the accepted owner without aborting them", () => {
    const { composer } = fixture(true);
    const reads = composer.attachmentDraft.reads;
    const destination = {
      getAttachments: () => composer.attachmentDraft.attachments,
      onAttachmentsChange: (files: typeof composer.attachmentDraft.attachments) => {
        if (composer.canDisplay()) {
          composer.attachmentDraft.replace(files);
        }
      },
    };
    const [entry] = reads.begin([new File(["late"], "late.txt")], [], destination);
    reads.updatePending(reads.readSignal, 1);
    composer.setMessage("draft with a pending file");
    composer.accept({ key: "agent:main:canonical", initialRun: { status: "idle" } });
    const transfer = composer.take()!;
    let attachments = transfer.attachments;
    transfer.reads.retarget(
      {
        getAttachments: () => attachments,
        onAttachmentsChange: (next) => {
          attachments = next;
        },
        onPendingReadsChange: (delta) =>
          transfer.reads.updatePending(transfer.reads.readSignal, delta),
      },
      vi.fn(),
    );
    composer.dispose();
    const file = registerTextPayload("completed-after-handoff");
    onTestFinished(() => releaseChatAttachmentPayloads([file]));
    entry!.destination!.onAttachmentsChange([file]);
    entry!.destination!.onPendingReadsChange?.(-1);
    expect(attachments).toEqual([file]);
    expect(transfer.reads.readSignal.aborted).toBe(false);
    expect(transfer.reads.pendingReads).toBe(0);
    expect(transfer.incognito).toBe(true);
  });

  it("retains refused commands and pending file input rather than clearing them", () => {
    const { composer } = fixture();
    composer.setMessage("/new");
    expect(composer.enqueue()).toBe(false);
    expect(composer.message).toBe("/new");
    expect(composer.error).toContain("Commands");
    composer.setMessage("wait for my file");
    composer.attachmentDraft.reads.updatePending(composer.attachmentDraft.reads.readSignal, 1);
    expect(composer.enqueue()).toBe(false);
    expect(composer.inputs).toEqual([]);
    expect(composer.message).toBe("wait for my file");
  });
});

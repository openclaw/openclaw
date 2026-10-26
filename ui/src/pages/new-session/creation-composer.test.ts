import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import { SessionBackgroundLayoutScope } from "../../components/session-background-layout-context.tsx";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "../chat/attachment-payload-store.ts";
import { retainCreatedComposer, takeCreatedComposer } from "./creation-composer-registry.ts";
import { CreationComposer as CreationComposerView } from "./creation-composer-render.tsx";
import { CreationComposer } from "./creation-composer.ts";
import { createDraftFixture, registerTextPayload } from "./draft-submission-flow.test-support.ts";

const sessionKey = "agent:main:canonical";
const accepted = { key: sessionKey, initialRun: { status: "idle" as const } };
const take = (context: Parameters<typeof takeCreatedComposer>[0]) =>
  takeCreatedComposer(context, sessionKey, context.gateway.snapshot.client);

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
  it("replaces the input owner without editing the previous draft", async () => {
    const { context, composer } = fixture();
    const next = new CreationComposer(context, "main", false, vi.fn());
    onTestFinished(() => next.dispose());
    composer.setMessage("first creation");
    next.setMessage("next creation");
    const [current, setCurrent] = createSignal<CreationComposer | undefined>(composer);
    const { container } = mountSolid(
      () =>
        createComponent(SessionBackgroundLayoutScope, {
          get children() {
            return createComponent(CreationComposerView, {
              get composer() {
                return current();
              },
              onOpenImage: vi.fn(),
            });
          },
        }),
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    const firstInput = container.querySelector("textarea");
    expect(firstInput?.value).toBe("first creation");
    setCurrent(next);
    flush();
    const nextInput = expectDefined(container.querySelector("textarea"), "next creation input");
    expect(nextInput).not.toBe(firstInput);
    expect(nextInput.value).toBe("next creation");
    nextInput.value = "edited next creation";
    next.flushInput?.();
    expect(next.message).toBe("edited next creation");
    expect(composer.message).toBe("first creation");
    setCurrent(undefined);
    flush();
    await waitForSolid(() => expect(container.querySelector("textarea")).toBeNull());
  });

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
    expect(getChatAttachmentDataUrl(composer.inputs[0]!.attachments[0]!)).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(previousRequests);
    expect(JSON.stringify({ localStorage, sessionStorage })).toBe(storedBefore);
    expect(composer.message).toBe("unfinished follow-up");
    expect(canReloadControlUiDocument()).toBe(false);
  });

  it("hands local input to the replacement client before recovery readiness", () => {
    const { context, composer, request } = fixture(true);
    composer.setMessage("accepted private draft");
    composer.accept(accepted);
    retainCreatedComposer(context, sessionKey, composer);
    const original = context.gateway.snapshot.client!;
    const next = createTestGatewayClient(request);
    vi.spyOn(next, "recoveryScope", "get").mockReturnValue(original.recoveryScope);
    context.gateway.snapshot.client = next;
    Object.defineProperty(next, "recoveryScopeReady", {
      value: false,
      configurable: true,
    });
    const transferred = take(context);
    expect(transferred?.draft).toBe("accepted private draft");
    expect(transferred?.isCurrent()).toBe(true);
    expect(transferred?.claimDraft()).toBe(true);
    expect(transferred?.claimDraft()).toBe(false);
    expect(take(context)).toBe(transferred);
    const unloading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    transferred?.complete();
    const released = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
    expect(take(context)).toBeUndefined();
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
    composer.accept(accepted);
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
    expect(transfer.reads).toMatchObject({ readSignal: { aborted: false }, pendingReads: 0 });
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

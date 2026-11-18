import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, createSignal, flush, useContext } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import { loadSettings } from "../../app/settings.ts";
import {
  SessionBackgroundLayoutContext,
  SessionBackgroundLayoutScope,
} from "../../components/session-background-layout-context.tsx";
import { SessionBackgroundView } from "../../components/session-background-view.tsx";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
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
import { StartedSessionNavigation } from "./started-session-navigation.ts";

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
  it("replaces the input owner and keeps its background fade through replacement and removal", async () => {
    const { context, composer } = fixture();
    const theme = createApplicationTheme(
      {
        ...loadSettings(),
        background: {
          source: { kind: "theme" },
          presentation: "faded",
          visibility: 0.5,
          showOnNewSession: true,
          showInSessions: true,
        },
      },
      context.gateway,
    );
    Object.assign(context, { theme });
    onTestFinished(() => theme.dispose());
    const next = new CreationComposer(context, "main", false, vi.fn());
    onTestFinished(() => next.dispose());
    composer.setMessage("first creation");
    next.setMessage("next creation");
    const [current, setCurrent] = createSignal<CreationComposer | undefined>(composer);
    let inputTop = 200;
    let registeredCount = () => 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("agent-chat__input")
        ? DOMRect.fromRect({ y: inputTop, height: 100 })
        : DOMRect.fromRect({ height: 1000 });
    });
    function Layout() {
      const scope = useContext(SessionBackgroundLayoutContext)!;
      registeredCount = () => scope.targets().length;
      return createComponent(SessionBackgroundView, { surface: "new-session", context });
    }
    const { container } = mountSolid(
      () =>
        createComponent(SessionBackgroundLayoutScope, {
          get children() {
            return [
              createComponent(Layout, {}),
              createComponent(CreationComposerView, {
                get composer() {
                  return current();
                },
                onOpenImage: vi.fn(),
              }),
            ];
          },
        }),
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    const background = expectDefined(
      container.querySelector<HTMLElement>("openclaw-session-background"),
      "creation background",
    );
    const firstInput = container.querySelector("textarea");
    expect(firstInput?.value).toBe("first creation");
    await waitForSolid(() =>
      expect(background.style.getPropertyValue("--session-background-fade-end")).toBe("250px"),
    );
    expect(registeredCount()).toBe(1);
    inputTop = 400;
    setCurrent(next);
    flush();
    const nextInput = expectDefined(container.querySelector("textarea"), "next creation input");
    expect(nextInput).not.toBe(firstInput);
    expect(nextInput.value).toBe("next creation");
    nextInput.value = "edited next creation";
    next.flushInput?.();
    expect(next.message).toBe("edited next creation");
    expect(composer.message).toBe("first creation");
    await waitForSolid(() =>
      expect(background.style.getPropertyValue("--session-background-fade-end")).toBe("450px"),
    );
    expect(registeredCount()).toBe(1);
    setCurrent(undefined);
    flush();
    await waitForSolid(() =>
      expect(background.style.getPropertyValue("--session-background-fade-end")).toBe("550px"),
    );
    expect(registeredCount()).toBe(0);
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
    expect(composer).toMatchObject({ inputs: [{ id }], message: "unfinished follower" });
    vi.mocked(context.sessions.createResult).mockResolvedValue(accepted);
    flow.setVisibility("incognito");
    await flow.submit();
    expect(flow.message).toBe("");
    const transfer = take(context);
    expect(transfer).toMatchObject({
      inputs: [{ id }],
      draft: "unfinished follower",
      incognito: true,
    });
    expect(transfer?.claimDraft()).toBe(true);
    expect(transfer?.claimDraft()).toBe(false);
    expect(canReloadControlUiDocument()).toBe(false);
    const unloading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    expect(take(context)).toBe(transfer);
    transfer?.complete();
    const released = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
    expect(take(context)).toBeUndefined();
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
    expect(take(context)).toBe(transferred);
    transferred?.complete();
    expect(take(context)).toBeUndefined();
  });

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
    composer.accept(accepted);
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

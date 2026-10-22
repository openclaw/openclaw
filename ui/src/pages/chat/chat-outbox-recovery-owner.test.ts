// @vitest-environment jsdom
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { readChatOutboxRecovery } from "../../lib/chat/outbox-recovery.ts";
import {
  readStoredOutboxStore,
  storageTargetForComposer,
  storageTargetForGateway,
} from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { PaneOutboxRecovery } from "./chat-outbox-recovery.tsx";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import type { ChatComposerPersistenceState } from "./composer-persistence-state.ts";
import { ChatComposerPersistence } from "./composer-persistence.ts";

const recoveryIo = vi.hoisted(() => ({
  confirm: vi.fn<(typeof import("../../components/confirm-dialog.ts"))["showConfirmDialog"]>(),
  prepare:
    vi.fn<
      (typeof import("../../lib/chat/composer-draft-store.runtime.ts"))["prepareDurableComposerRecovery"]
    >(),
  readDraft:
    vi.fn<
      (typeof import("../../lib/chat/composer-draft-store.runtime.ts"))["readDurableComposerDraft"]
    >(),
}));

// mock-isolation: Defer confirmation to test retirement while keeping recovery storage real.
vi.mock("../../components/confirm-dialog.ts", () => ({
  showConfirmDialog: recoveryIo.confirm,
}));
// mock-isolation: Keep durable I/O separate from real session-storage recovery and retirement.
vi.mock("../../lib/chat/composer-draft-store.runtime.ts", () => ({
  prepareDurableComposerRecovery: recoveryIo.prepare,
  readDurableComposerDraft: recoveryIo.readDraft,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
  recoveryIo.prepare.mockResolvedValue({ status: "ready", entries: [] });
  recoveryIo.readDraft.mockResolvedValue({ status: "not-found", revision: 0 });
});

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  flush();
  vi.unstubAllGlobals();
});

async function mountRecovery(kind: "draft" | "queue" = "draft") {
  const request = vi.fn(async () => ({}));
  const host: Parameters<typeof PaneOutboxRecovery>[0]["state"] & ChatComposerPersistenceState = {
    settings: { gatewayUrl: "ws://recovery-owner.test" },
    connected: true,
    client: createTestGatewayClient(request),
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    sessionKey: "agent:main:main",
    currentSessionId: "current-session",
    connectionEpoch: 1,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatMessages: [],
  };
  const preview = kind === "draft" ? "Saved input for explicit review" : "Saved queued input";
  const target = storageTargetForGateway(host.settings.gatewayUrl);
  sessionStorage.setItem(
    kind === "draft" ? target.previousKey : target.key,
    JSON.stringify({
      version: kind === "draft" ? 2 : 4,
      gatewayOwner: host.settings.gatewayUrl,
      recovery: {},
      sessions: {
        [kind === "draft" ? "global\u0000agent:main" : "agent:main:main\u0000agent:main"]: {
          ...(kind === "draft"
            ? { draft: preview }
            : {
                queue: [
                  {
                    id: "queued-input",
                    text: preview,
                    createdAt: 1,
                    sendRunId: "pending-delivery",
                    sessionId: host.currentSessionId,
                  },
                ],
              }),
          draftRevision: 1,
          updatedAt: 1,
        },
      },
    }),
  );
  const restored = vi.fn();
  const props = { state: host, identity: "current-owner", onRestored: restored };
  let view = mountSolid(PaneOutboxRecovery, props);
  document.body.append(view.container);
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-outbox-recovery__preview")?.textContent).toBe(
      preview,
    ),
  );
  const button = (action: "restore" | "discard") => {
    const label = t(
      action === "restore" ? "chat.outboxRecoveryRestore" : "chat.outboxRecoveryDelete",
    );
    const found = [...view.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) {
      throw new Error(`Missing recovery action: ${action}`);
    }
    return found;
  };
  return {
    host,
    button,
    restored,
    request,
    get element() {
      return view.container;
    },
    remount() {
      view.dispose();
      view = mountSolid(PaneOutboxRecovery, props);
      document.body.append(view.container);
    },
  };
}

it("retires durable delivery receipts from the run owner without bridge prop refreshes", async () => {
  const { host, element } = await mountRecovery("queue");
  const owner = chatRunPresentation(host);
  const initialReads = recoveryIo.prepare.mock.calls.length;
  owner.publish();
  await Promise.resolve();
  flush();
  expect(recoveryIo.prepare).toHaveBeenCalledTimes(initialReads);

  host.chatMessages = [
    { role: "user", __openclaw: { id: null, seq: null, idempotencyKey: "pending-delivery" } },
  ];
  await waitForSolid(() => expect(recoveryIo.prepare).toHaveBeenCalledTimes(initialReads + 1));
  expect(readChatOutboxRecovery(host).entries).toHaveLength(1);

  host.chatMessages = [
    { role: "user", __openclaw: { id: "delivered", idempotencyKey: "pending-delivery" } },
  ];
  await waitForSolid(() => expect(element.querySelector(".chat-outbox-recovery-row")).toBeNull());
  expect(readChatOutboxRecovery(host).entries).toEqual([]);
});

it("clears a failed restore on retry and admits one review before Solid flushes", async () => {
  const dialogs = createModalDialogTestFixture();
  const cancellation = new AbortController();
  onTestFinished(async () => {
    cancellation.abort();
    await dialogs.cleanup();
  });
  const { showConfirmDialog } = await vi.importActual<
    typeof import("../../components/confirm-dialog.ts")
  >("../../components/confirm-dialog.ts");
  // Exercise the already-loaded modal path that otherwise inherits the action transaction.
  await import("../../components/modal-dialog.tsx");
  recoveryIo.confirm.mockImplementation((options) =>
    dialogs.track(showConfirmDialog({ ...options, signal: cancellation.signal })),
  );
  const fixture = await mountRecovery();
  const host = Object.assign(fixture.host, { selectedChatSessionIncognito: false });
  const draftSource = createComposerDraftSource(() => ({
    draft: host.chatMessage,
    mentions: [],
    attachments: host.chatAttachments,
    pendingAttachmentReads: 0,
  }));
  const persistence = new ChatComposerPersistence(() => host, draftSource.publish);
  fixture.restored.mockImplementation(() => {
    persistence.restore();
    persistence.persistChangedState();
  });
  const composer = createComposerContainer();
  document.body.append(composer);
  renderComposerInto(
    composer,
    createComposerProps({
      sessionKey: host.sessionKey,
      getDraft: () => host.chatMessage,
      draftSource,
    }),
  );
  await waitForSolid(() => expect(composer.querySelector("textarea")?.value).toBe(""));
  recoveryIo.readDraft.mockResolvedValueOnce({ status: "storage-failed" });
  fixture.button("restore").click();
  await waitForSolid(() => {
    expect(fixture.element.querySelector(".chat-outbox-recovery__error")?.textContent).toBe(
      t("chat.outboxRecoveryStorageFailed"),
    );
    expect(fixture.button("restore").disabled).toBe(false);
  });
  fixture.button("restore").click();
  fixture.button("restore").click();
  await waitForSolid(() => {
    expect(recoveryIo.confirm).toHaveBeenCalledOnce();
    expect(fixture.button("restore").disabled).toBe(true);
    expect(fixture.button("discard").disabled).toBe(true);
    expect(fixture.element.querySelector(".chat-outbox-recovery__error")).toBeNull();
  });
  expect(readChatOutboxRecovery(fixture.host).entries).toHaveLength(1);
  const confirmation = await waitForConfirmDialogActions();

  const refresh = createDeferred<Awaited<ReturnType<typeof recoveryIo.prepare>>>();
  recoveryIo.prepare.mockReturnValue(refresh.promise);
  try {
    answerConfirmDialog(confirmation, "confirm");
    await waitForSolid(() => expect(fixture.restored).toHaveBeenCalledOnce());
    expect(host.chatMessage, "restored owner draft").toBe("Saved input for explicit review");
    await waitForSolid(() =>
      expect(composer.querySelector("textarea")?.value, "visible restored draft").toBe(
        "Saved input for explicit review",
      ),
    );
  } finally {
    refresh.resolve({ status: "ready", entries: [] });
  }
  await waitForSolid(() => {
    expect(fixture.restored).toHaveBeenCalledOnce();
    expect(fixture.element.querySelector(".chat-outbox-recovery-row")).toBeNull();
  });
  const stored = readStoredOutboxStore(sessionStorage, storageTargetForComposer(fixture.host));
  expect(stored.sessions["agent:main:main\u0000agent:main"]?.draft).toBe(
    "Saved input for explicit review",
  );
  expect(readChatOutboxRecovery(fixture.host).entries).toEqual([]);
  expect(fixture.request).not.toHaveBeenCalled();
});

it.each(["restore", "discard"] as const)(
  "retires a pending %s review when its Solid owner remounts",
  async (action) => {
    const confirmation = createDeferred<boolean>();
    recoveryIo.confirm.mockReturnValue(confirmation.promise);
    const fixture = await mountRecovery();
    fixture.button(action).click();
    await waitForSolid(() => expect(recoveryIo.confirm).toHaveBeenCalledOnce());

    fixture.remount();
    await waitForSolid(() => expect(fixture.button(action).disabled).toBe(false));
    confirmation.resolve(true);
    await confirmation.promise;
    await Promise.resolve();
    flush();

    expect(readChatOutboxRecovery(fixture.host).entries).toHaveLength(1);
    expect(
      readStoredOutboxStore(sessionStorage, storageTargetForComposer(fixture.host)).sessions,
    ).toEqual({});
    expect(fixture.element.querySelector(".chat-outbox-recovery__preview")?.textContent).toBe(
      "Saved input for explicit review",
    );
    expect(fixture.restored).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
  },
);

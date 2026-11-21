// @vitest-environment jsdom
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import {
  notifyStoredChatOutboxChanges,
  storageTargetForGateway,
} from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock("../../lib/chat/composer-draft-store.runtime.ts");
  vi.doUnmock("./chat-outbox-recovery.runtime.tsx");
  vi.unstubAllGlobals();
});

it("loads recovery storage only for an admitted owner and ignores retired import failures", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const { createPageState } = await import("./chat-state-page.ts");
  // The plain state factory's composer store is separate from recovery's failed import.
  await import("../../lib/chat/composer-draft-store.runtime.ts");
  const loading = createDeferred();
  const release = createDeferred();
  const initializeRuntime = vi.fn();
  // mock-isolation: Hold recovery's failed import independently of the initialized state owner.
  vi.doMock("../../lib/chat/composer-draft-store.runtime.ts", async () => {
    initializeRuntime();
    loading.resolve();
    await release.promise;
    throw new Error("Synthetic recovery module unavailable");
  });
  const { createInitializationContext } =
    await import("./chat-application-context.test-support.ts");
  const loadView = vi.fn();
  // mock-isolation: Reject the cold view once; its ordinary Retry must load it again.
  vi.doMock("./chat-outbox-recovery.runtime.tsx", async (original) => {
    loadView();
    if (loadView.mock.calls.length === 1) {
      throw new Error("Recovery view unavailable");
    }
    return original<typeof import("./chat-outbox-recovery.runtime.tsx")>();
  });
  const { PaneOutboxRecovery } = await import("./chat-outbox-recovery.tsx");
  const host = createPageState(
    createInitializationContext(),
    { afterCommit: () => () => {} },
    { dispatchEvent: () => true },
  );
  host.connected = true;
  host.client = createTestGatewayClient(async () => ({}));
  host.settings = { ...host.settings, gatewayUrl: "ws://recovery.test" };
  const createRecovery = (state: typeof host = host) => {
    const view = mountSolid(PaneOutboxRecovery, {
      state,
      identity: "connected-owner",
      onRestored: () => {},
    });
    document.body.append(view.container);
    return view;
  };
  try {
    const unadmitted = createRecovery({ ...host, connected: false, client: null });
    // Let module-import launch work run; an idle recovery has no storage operation to prepare.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(initializeRuntime).not.toHaveBeenCalled();
    expect(loadView).not.toHaveBeenCalled();
    expect(unadmitted.container.querySelector(".chat-outbox-recovery")).toBeNull();
    unadmitted.dispose();

    const current = createRecovery();
    const superseded = createRecovery();
    await loading.promise;
    const disconnectedClient = createTestGatewayClient(async () => ({}));
    disconnectedClient.retireOfflineRecoveryScope();
    superseded.update({
      state: { ...host, connected: false, client: disconnectedClient },
      identity: "disconnected-owner",
      onRestored: () => {},
    });
    const failedImport = import("../../lib/chat/composer-draft-store.runtime.ts").catch(
      () => undefined,
    );
    release.resolve();
    await failedImport;
    flush();
    expect(current.container.querySelector('[role="alert"]')?.textContent).toBe(
      t("chat.outboxRecoveryStorageFailed"),
    );
    expect(superseded.container.querySelector('[role="alert"]')).toBeNull();
    expect(loadView).not.toHaveBeenCalled();

    const target = storageTargetForGateway(host.settings.gatewayUrl);
    sessionStorage.setItem(
      target.previousKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: host.settings.gatewayUrl,
        recovery: {},
        sessions: {
          "global\u0000agent:main": { draft: "Saved recovery", draftRevision: 1, updatedAt: 1 },
        },
      }),
    );
    notifyStoredChatOutboxChanges();
    await waitForSolid(() =>
      expect(current.container.querySelector(".lazy-view-error")?.textContent).toContain(
        "Recovery view unavailable",
      ),
    );
    expect(current.container.querySelector(".chat-outbox-recovery__error")?.textContent).toBe(
      t("chat.outboxRecoveryStorageFailed"),
    );
    (current.container.querySelector(".lazy-view-error__action") as HTMLButtonElement).click();
    await waitForSolid(() =>
      expect(current.container.querySelector(".chat-outbox-recovery__preview")?.textContent).toBe(
        "Saved recovery",
      ),
    );
    expect(loadView).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
  }
});

// @vitest-environment jsdom
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createStorageMock } from "../../test-helpers/storage.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock("../../lib/chat/composer-draft-store.runtime.ts");
  vi.unstubAllGlobals();
});

it("shows a failed recovery module only for the owner still awaiting it", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const { createPageState } = await import("./chat-state-page.ts");
  // The plain state factory's composer store is separate from recovery's failed import.
  await import("../../lib/chat/composer-draft-store.runtime.ts");
  const loading = createDeferred();
  const release = createDeferred();
  vi.doMock("../../lib/chat/composer-draft-store.runtime.ts", async () => {
    loading.resolve();
    await release.promise;
    throw new Error("Synthetic recovery module unavailable");
  });
  const { createInitializationContext } = await import("./chat-pane.test-support.ts");
  const { PaneOutboxRecovery } = await import("./chat-outbox-recovery.tsx");
  const host = createPageState(
    createInitializationContext(),
    { afterCommit: () => () => {} },
    { dispatchEvent: () => true },
  );
  host.connected = true;
  host.client = createTestGatewayClient(async () => ({}));
  host.settings = { ...host.settings, gatewayUrl: "ws://recovery.test" };
  const createRecovery = () => {
    const view = mountSolid(PaneOutboxRecovery, {
      state: host,
      identity: "connected-owner",
      onRestored: () => {},
    });
    document.body.append(view.container);
    return view;
  };
  const current = createRecovery();
  const superseded = createRecovery();
  try {
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
  } finally {
    release.resolve();
  }
});

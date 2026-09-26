// @vitest-environment jsdom
import type { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock("../../lib/chat/composer-draft-store.runtime.ts");
  vi.unstubAllGlobals();
});

it("shows a failed recovery module only for the owner still awaiting it", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const loading = createDeferred();
  const release = createDeferred();
  vi.doMock("../../lib/chat/composer-draft-store.runtime.ts", async () => {
    loading.resolve();
    await release.promise;
    throw new Error("Synthetic recovery module unavailable");
  });
  await import("./chat-outbox-recovery.ts");
  const host = {
    connected: true,
    client: createTestGatewayClient(async () => ({})),
    settings: { gatewayUrl: "ws://recovery.test" },
  };
  const createRecovery = () =>
    Object.assign(document.createElement("openclaw-chat-outbox-recovery") as LitElement, {
      host,
      identity: "connected-owner",
    });
  const current = createRecovery();
  const superseded = createRecovery();
  document.body.append(current, superseded);
  try {
    await Promise.all([current.updateComplete, superseded.updateComplete, loading.promise]);
    superseded.host = { ...host, connected: false };
    superseded.identity = "disconnected-owner";
    await superseded.updateComplete;
    const failedImport = import("../../lib/chat/composer-draft-store.runtime.ts").catch(
      () => undefined,
    );
    release.resolve();
    await failedImport;
    await Promise.all([current.updateComplete, superseded.updateComplete]);
    expect(current.querySelector('[role="alert"]')?.textContent).toBe(
      t("chat.outboxRecoveryStorageFailed"),
    );
    expect(superseded.querySelector('[role="alert"]')).toBeNull();
  } finally {
    release.resolve();
  }
});

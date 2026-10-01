/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import { createStoredChatOutboxReader } from "../lib/chat/outbox-store-projection.ts";
import {
  storageTargetForComposer,
  storedChatOutboxScopeKey,
  writeStoredOutboxStore,
} from "../lib/chat/outbox-store.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import type { StoredOutboxScopeHost } from "./app-shell-gateway.ts";
import type { ApplicationContext } from "./context.ts";
import "./app-host.ts";

afterEach(resetAppHostTestGlobals);

it("projects only the ready recovery owner's attachment failures through the shell scope", () => {
  const storage = createStorageMock();
  vi.stubGlobal("sessionStorage", storage);
  const { gateway } = createApplicationGateway();
  const owner = {
    recoveryScope: "current-principal",
    recoveryScopeReady: false,
  };
  gateway.snapshot.client = owner as GatewayBrowserClient;
  gateway.snapshot.phase = "connected";
  const context = {
    gateway,
    agents: { state: { agentsList: null } },
  } as unknown as ApplicationContext;
  const shell = document.createElement("openclaw-app-shell") as HTMLElement & {
    storedOutboxScopeHost(context: ApplicationContext): StoredOutboxScopeHost;
  };
  const ownSessionKey = "agent:main:own-attachment";
  const otherSessionKey = "agent:main:other-attachment";
  const admittedHost = {
    settings: { gatewayUrl: gateway.connection.gatewayUrl },
    connected: true,
    client: { ...owner, recoveryScopeReady: true },
  };
  const target = storageTargetForComposer(admittedHost);
  writeStoredOutboxStore(storage, target, {
    version: 4,
    gatewayOwner: target.gatewayOwner,
    recovery: {},
    sessions: Object.fromEntries(
      (
        [
          [ownSessionKey, owner.recoveryScope],
          [otherSessionKey, "another-principal"],
        ] as const
      ).map(([sessionKey, recoveryScope]) => [
        storedChatOutboxScopeKey({ sessionKey }),
        {
          updatedAt: 1,
          queue: [
            {
              id: sessionKey,
              text: "attachment failed",
              createdAt: 1,
              sendState: "failed",
              storageScope: outboxStorageScope({
                ...admittedHost,
                client: { recoveryScope, recoveryScopeReady: true },
              }),
              attachmentPayload: { key: sessionKey, recoveryScope, tabId: "tab" },
            },
          ],
        },
      ]),
    ),
  });
  const reader = createStoredChatOutboxReader();

  expect(reader.read(shell.storedOutboxScopeHost(context)).total).toBe(0);
  owner.recoveryScopeReady = true;
  const summary = reader.read(shell.storedOutboxScopeHost(context));
  expect(summary.total).toBe(1);
  expect(summary.attentionCountForSession(ownSessionKey)).toBe(1);
  expect(summary.attentionCountForSession(otherSessionKey)).toBe(0);
});

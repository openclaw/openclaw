import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { catalogProvider as provider } from "./session-catalog.fixtures.test-support.js";
import {
  call,
  hoisted,
  resetSessionCatalogTestState,
  startCall,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

describe("session catalog progress ownership", () => {
  beforeEach(resetSessionCatalogTestState);

  it.each([false, true])(
    "streams hosts only to the requester and honors final withdrawal (withdrawn=%s)",
    async (withdrawn) => {
      const broadcastToConnIds = vi.fn();
      const host = {
        hostId: "node:fast",
        label: "Fast node",
        kind: "node" as const,
        connected: true,
        nodeId: "fast",
        sessions: [],
      };
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("codex", {
            list: vi.fn(async ({ onHost }) => {
              onHost?.(host);
              return withdrawn ? [] : [host];
            }),
          }),
        },
      ];

      const respond = await call(
        "sessions.catalog.list",
        { progressId: "progress-1", ...(withdrawn ? { allowPartialResults: true } : {}) },
        {},
        { connId: "requester", connect: gatewayConnect([]) },
        { broadcastToConnIds },
      );

      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.catalog.host",
        {
          progressId: "progress-1",
          agentId: "main",
          catalog: expect.objectContaining({ id: "codex", hosts: [host] }),
        },
        new Set(["requester"]),
        { dropIfSlow: true },
      );
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[1]?.catalogs[0]?.error).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ id: "codex", hosts: withdrawn ? [] : [host] })],
      });
    },
  );

  it.each([false, true])(
    "keeps newer host publications in the aggregate while another provider waits (cold=%s)",
    async (cold) => {
      const sibling = createDeferredCore();
      const publish = createDeferredCore();
      const local = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [],
      };
      const cached = {
        hostId: "node:slow",
        label: "Cached",
        kind: "node" as const,
        connected: true,
        sessions: [],
      };
      const fresh = { ...cached, label: "Fresh" };
      let publication: Promise<void> | undefined;
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list: async ({ onHost, waitUntil }) => {
              publication = publish.promise.then(() => onHost?.(fresh));
              waitUntil?.(publication);
              return cold ? [local, { ...cached, pending: true }] : [local, cached];
            },
          }),
        },
        {
          provider: provider("sibling", {
            list: async () => {
              await sibling.promise;
              return [];
            },
          }),
        },
      ];
      const broadcastToConnIds = vi.fn();
      const pending = startCall(
        "sessions.catalog.list",
        { allowPartialResults: true, progressId: "live" },
        {},
        { connId: "requester", connect: gatewayConnect([]) },
        { broadcastToConnIds },
      );
      try {
        await vi.waitFor(() => expect(publication).toBeDefined());
        publish.resolve();
        await publication;
        expect(broadcastToConnIds).toHaveBeenCalledOnce();
        expect(pending.respond).not.toHaveBeenCalled();
        sibling.resolve();
        await pending.completion;
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [
            expect.objectContaining({ id: "fixture", hosts: [local, fresh] }),
            expect.objectContaining({ id: "sibling", hosts: [] }),
          ],
        });
      } finally {
        publish.resolve();
        sibling.resolve();
        await Promise.allSettled([pending.completion, publication]);
      }
    },
  );

  it.each(["settled", "in-flight"] as const)(
    "refreshes %s lists immediately after archiving a session",
    async (listingState) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const gate = createDeferredCore();
      const started = createDeferredCore();
      const late = createDeferredCore();
      const publications: Promise<void>[] = [];
      const broadcastToConnIds = vi.fn();
      const session = {
        threadId: "deleted-thread",
        status: "stored",
        archived: false,
        canContinue: false,
        canArchive: true,
      };
      const host = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [session],
      };
      let archived = false;
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
        const resultHost = { ...host, sessions: archived ? [] : [session] };
        const publication = late.promise.then(() => onHost?.(resultHost));
        publications.push(publication);
        waitUntil?.(publication);
        started.resolve();
        await gate.promise;
        return [resultHost];
      });
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list,
            archive: async () => {
              archived = true;
              return { ok: true };
            },
          }),
        },
      ];
      const config = {};
      const client = { connId: "requester", connect: gatewayConnect([]) };
      const original = startCall(
        "sessions.catalog.list",
        { progressId: "before-delete" },
        config,
        client,
        { broadcastToConnIds },
      );
      try {
        await started.promise;
        if (listingState === "settled") {
          gate.resolve();
          await original.completion;
        }
        const deletion = await call(
          "sessions.catalog.archive",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: session.threadId,
            confirmNoOtherRunner: true,
          },
          config,
          client,
        );
        expect(deletion).toHaveBeenCalledWith(true, { ok: true });
        late.resolve();
        await publications[0];
        gate.resolve();
        await original.completion;
        expect(original.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [host] })],
        });

        const refreshed = await call(
          "sessions.catalog.list",
          { progressId: "after-delete" },
          config,
          client,
          { broadcastToConnIds: vi.fn() },
        );
        expect(refreshed).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [{ ...host, sessions: [] }] })],
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        late.resolve();
        await original.completion;
        await Promise.allSettled(publications);
        now.mockRestore();
      }
    },
  );

  it.each(["gateway-close", "disconnect", "projection-failure"] as const)(
    "fences old publications after %s while a replacement request can publish",
    async (retirement) => {
      const releases = [createDeferredCore(), createDeferredCore()];
      const publications: Promise<void>[] = [];
      const connection = new AbortController();
      const gateway = new AbortController();
      const broadcastToConnIds = vi.fn();
      const replacementBroadcast = vi.fn();
      let producerSignal: AbortSignal | undefined;
      const list = vi.fn<SessionCatalogProvider["list"]>(async (params) => {
        producerSignal = params.signal;
        const publication = releases[publications.length]!.promise.then(() =>
          params.onHost?.({
            hostId: "node:late",
            label: "Late",
            kind: "node",
            connected: true,
            sessions: [],
          }),
        );
        publications.push(publication);
        params.waitUntil?.(publication);
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const config = {};
      try {
        const getRuntimeConfig = vi
          .fn()
          .mockReturnValueOnce(config)
          .mockImplementation(() => {
            throw new Error("current config unavailable");
          });
        const original = call(
          "sessions.catalog.list",
          { progressId: "original" },
          config,
          { connId: "old", connect: gatewayConnect([]), connectionSignal: connection.signal },
          {
            broadcastToConnIds,
            requestEntryLifetime: { signal: gateway.signal },
            ...(retirement === "projection-failure" ? { getRuntimeConfig } : {}),
          },
        );
        if (retirement === "projection-failure") {
          await expect(original).rejects.toThrow("current config unavailable");
        } else {
          await original;
        }
        if (retirement === "gateway-close") {
          gateway.abort();
        } else if (retirement === "disconnect") {
          connection.abort();
        }
        expect(producerSignal?.aborted).toBe(retirement !== "disconnect");
        await call(
          "sessions.catalog.list",
          { progressId: "replacement" },
          config,
          { connId: "new", connect: gatewayConnect([]) },
          { broadcastToConnIds: replacementBroadcast },
        );
        releases[0]!.resolve();
        await publications[0];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledTimes(2);
        releases[1]!.resolve();
        await publications[1];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).toHaveBeenCalledOnce();
        expect(replacementBroadcast.mock.calls[0]?.[1]?.progressId).toBe("replacement");
      } finally {
        for (const release of releases) {
          release.resolve();
        }
        await Promise.allSettled(publications);
      }
    },
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { resolveArtifactDownloadSource } from "../../api/artifact-download.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { applySelectedSessionProjection, SessionParticipationTracker } from "./chat-pane-state.ts";

function projectionState(): Parameters<typeof applySelectedSessionProjection>[0] {
  return {
    chatEffectiveQueueMode: "interrupt",
    chatQueueModeOverride: "interrupt",
    selectedChatSessionArchived: true,
    selectedChatSessionIncognito: true,
  };
}

describe("applySelectedSessionProjection", () => {
  it.each([
    undefined,
    {
      archived: false,
      effectiveQueueMode: "followup",
      key: "agent:main:main",
      kind: "direct",
      queueMode: "followup",
      updatedAt: 1,
    },
  ] as const)("projects selected metadata only when its row is present: %j", (row) => {
    const state = projectionState();
    expect(applySelectedSessionProjection(state, row)).toBe(row !== undefined);
    expect(state).toEqual(
      row
        ? {
            chatEffectiveQueueMode: "followup",
            chatQueueModeOverride: "followup",
            selectedChatSessionArchived: false,
            selectedChatSessionIncognito: false,
          }
        : {
            chatEffectiveQueueMode: "interrupt",
            chatQueueModeOverride: "interrupt",
            selectedChatSessionArchived: true,
            selectedChatSessionIncognito: true,
          },
    );
  });

  it("adopts an archived routed row published after the active list omitted it", () => {
    const routedKey = "agent:main:dashboard:cold-archive";
    const activeResult: SessionsListResult = {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 2 }],
      ts: 2,
    };
    const published = reconcileSessionHistory(
      activeResult,
      {
        archived: true,
        key: routedKey,
        kind: "direct",
        label: "Archived planning",
        updatedAt: 1,
      },
      undefined,
      { archivedFilter: "all" },
    );
    const state = { ...projectionState(), selectedChatSessionArchived: false };
    const selected = published?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, routedKey),
    );

    expect(applySelectedSessionProjection(state, selected)).toBe(true);
    expect(state.selectedChatSessionArchived).toBe(true);

    const afterNavigation = reconcileSessionHistory(published, selected, undefined, {
      archivedFilter: "active",
    });
    expect(afterNavigation?.sessions.map((row) => row.key)).toEqual(["agent:main:main"]);
  });
});

describe("resolveArtifactDownloadSource", () => {
  afterEach(() => vi.unstubAllGlobals());

  const artifact = {
    id: "artifact-1",
    type: "image",
    title: "image",
    mimeType: "image/png",
    download: { mode: "bytes" },
  };
  const inline = { artifact, encoding: "base64", data: "cG5n" };
  const ticket = "/api/artifacts/download/connection/ticket";

  it.each([
    { page: "https://control.test", gateway: "wss://control.test", http: true, variant: undefined },
    {
      page: "https://control.test",
      gateway: "wss://control.test",
      http: true,
      variant: "thumbnail",
    },
    { page: "https://control.test", gateway: "wss://control.test", http: true, variant: "full" },
    {
      page: "https://control.test",
      gateway: "wss://remote.test",
      http: false,
      variant: "thumbnail",
    },
    {
      page: "http://control.test",
      gateway: "ws://control.test",
      http: false,
      variant: "thumbnail",
    },
  ] as const)(
    "uses raw HTTP bytes only for $page with $gateway ($variant)",
    async ({ page, gateway, http, variant }) => {
      vi.stubGlobal("location", new URL(page));
      const blob = new Blob(["png"], { type: "image/png" });
      const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "Content-Disposition": ' AtTaChMeNt ; filename="image.png" ' }),
        blob: async () => blob,
      }));
      vi.stubGlobal("fetch", fetchMock);
      const request = vi.fn().mockResolvedValue(
        http
          ? {
              artifact:
                variant === "thumbnail" ? { ...artifact, mimeType: "image/jpeg" } : artifact,
              url: ticket,
            }
          : inline,
      );
      const result = await resolveArtifactDownloadSource(
        {
          connected: true,
          resourceBasePath: "/mount",
          client: { gatewayUrl: gateway, request } as never,
        },
        { sessionKey: "agent:main:main", artifactId: artifact.id, variant },
      );
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "artifacts.download",
        {
          sessionKey: "agent:main:main",
          artifactId: artifact.id,
          ...(http ? { transport: "http" } : {}),
        },
        { timeoutMs: 30_000 },
      );
      if (http) {
        const url = `/mount${ticket}${variant === "thumbnail" ? "?variant=thumbnail" : ""}`;
        expect(result).toEqual({ url, blob });
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      } else {
        expect(result).toEqual({ url: "data:image/png;base64,cG5n" });
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { failure: "network", mimeType: "image/png", type: "image", reject: false },
    { failure: "missing route", mimeType: "image/png", type: "image", reject: false },
    { failure: "SPA fallback", mimeType: "image/png", type: "image", reject: false },
    { failure: "wrong content type", mimeType: "image/png", type: "image", reject: false },
    { failure: "unsafe SVG", mimeType: "image/svg+xml", type: "image", reject: true },
    { failure: "unsafe HTML", mimeType: "text/html", type: "image", reject: true },
    { failure: "non-image artifact", mimeType: "image/png", type: "file", reject: true },
  ])(
    "reauthorizes failed transfers but rejects unsafe blobs: $failure",
    async ({ failure, mimeType, type, reject }) => {
      vi.stubGlobal("location", new URL("https://control.test"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "network") {
            throw new TypeError("Failed to fetch");
          }
          return {
            ok: failure !== "missing route",
            status: failure === "missing route" ? 404 : 200,
            headers: new Headers(
              reject || failure === "wrong content type"
                ? { "Content-Disposition": 'attachment; filename="artifact"' }
                : {},
            ),
            blob: async () => new Blob(["untrusted"], { type: reject ? mimeType : "text/html" }),
          };
        }),
      );
      const download = { artifact: { ...artifact, mimeType, type }, url: ticket };
      const request = vi
        .fn()
        .mockResolvedValueOnce(download)
        .mockResolvedValue(reject ? download : inline);
      const result = await resolveArtifactDownloadSource(
        { connected: true, client: { gatewayUrl: "wss://control.test", request } as never },
        { sessionKey: "agent:main:main", artifactId: artifact.id },
      );
      if (reject) {
        expect(result).toBeNull();
        expect(request).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual({ url: "data:image/png;base64,cG5n" });
        expect(request.mock.calls.map(([, params]) => params)).toEqual([
          { sessionKey: "agent:main:main", artifactId: artifact.id, transport: "http" },
          { sessionKey: "agent:main:main", artifactId: artifact.id },
        ]);
      }
    },
  );

  it("discards a failed transfer after reconnect without requesting inline bytes", async () => {
    vi.stubGlobal("location", new URL("https://control.test"));
    const transfer = createDeferred<Response>();
    const started = createDeferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        started.resolve();
        return transfer.promise;
      }),
    );
    const request = vi.fn().mockResolvedValue({ artifact, url: ticket });
    const state = {
      connected: true,
      connectionEpoch: 1,
      client: { gatewayUrl: "wss://control.test", request } as never,
    };
    const pending = resolveArtifactDownloadSource(state, {
      sessionKey: "main",
      artifactId: artifact.id,
    });
    await started.promise;
    state.connectionEpoch += 1;
    transfer.reject(new TypeError("Connection changed"));
    expect(await pending).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("returns a trimmed ticket without exposing a gateway bearer credential", async () => {
    const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
    const result = await resolveArtifactDownloadSource(
      {
        connected: true,
        client: {
          request: async (method: string, params: unknown, options: unknown) => {
            requests.push({ method, params, options });
            return {
              artifact: {
                id: "artifact-1",
                type: "image",
                title: "image",
                download: { mode: "url" },
              },
              url: " /api/chat/media/outgoing/main/image/full?mediaTicket=ticket ",
              expiresAt: " 2026-07-28T00:00:00.000Z ",
            };
          },
        } as never,
      },
      { sessionKey: "agent:main:main", artifactId: "artifact-1" },
    );

    expect(requests).toEqual([
      {
        method: "artifacts.download",
        params: { sessionKey: "agent:main:main", artifactId: "artifact-1" },
        options: { timeoutMs: 30_000 },
      },
    ]);
    expect(result).toEqual({
      url: "/api/chat/media/outgoing/main/image/full?mediaTicket=ticket",
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
  });
});

describe("SessionParticipationTracker", () => {
  const resolve = (
    tracker: SessionParticipationTracker,
    patch: Partial<Parameters<SessionParticipationTracker["resolve"]>[0]> = {},
  ) =>
    tracker.resolve({
      catalog: false,
      listLoading: false,
      sessionKey: "agent:main:tracked",
      session: undefined,
      ...patch,
    });

  it.each([
    { visibility: "draft", sharingRole: "member", blocked: true },
    { visibility: "read-only", sharingRole: "viewer", blocked: true },
    { visibility: "shared", sharingRole: "member", blocked: false },
  ] as const)(
    "holds only observed restrictions while refreshing: $visibility",
    ({ visibility, sharingRole, blocked }) => {
      const tracker = new SessionParticipationTracker();
      expect(resolve(tracker, { session: { visibility, sharingRole } })).toBe(blocked);
      expect(resolve(tracker, { listLoading: true })).toBe(blocked);
      // Completed absence is not a revocation (filtering, pagination, and deletion).
      expect(resolve(tracker)).toBe(false);
      expect(resolve(tracker, { session: { visibility: "shared", sharingRole: "member" } })).toBe(
        false,
      );
      expect(resolve(tracker, { listLoading: true })).toBe(false);
    },
  );

  it.each(["connection", "agent"] as const)("scopes held restrictions to the %s", (change) => {
    const tracker = new SessionParticipationTracker();
    const sessionKey = "main\0global";
    expect(
      resolve(tracker, { sessionKey, session: { visibility: "draft", sharingRole: "member" } }),
    ).toBe(true);
    expect(resolve(tracker, { sessionKey, listLoading: true })).toBe(true);
    if (change === "connection") {
      tracker.reset();
      expect(resolve(tracker, { sessionKey, listLoading: true })).toBe(false);
    } else {
      expect(resolve(tracker, { sessionKey: "work\0global", listLoading: true })).toBe(false);
      expect(resolve(tracker, { sessionKey, listLoading: true })).toBe(true);
    }
  });
});

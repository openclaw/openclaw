import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatImageRenditionWidth } from "../../../../src/shared/chat-image-renditions.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-application-context.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestPageState } from "./chat-page-state.test-support.ts";
import { createChatPaneResourceProps } from "./chat-pane-resource-presentation.ts";
import {
  applySelectedSessionProjection,
  SessionParticipationTracker,
  createChatPaneRunRecoveryActions,
} from "./chat-pane-state.ts";
import { createFailedMessageEdit } from "./failed-message-edit.ts";

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

describe("pane artifact downloads", () => {
  afterEach(() => vi.unstubAllGlobals());

  const artifact = {
    id: "artifact-1",
    type: "image",
    title: "image",
    mimeType: "image/png",
    download: { mode: "bytes" },
  };
  const inline = { artifact, encoding: "base64", data: "cG5n" };
  const preview = {
    artifact: { ...artifact, mimeType: "image/webp" },
    encoding: "base64",
    data: "cHJldmlldw==",
  };
  const ticket = "/api/artifacts/download/connection/ticket";
  const legacy = {
    url: "/api/chat/media/outgoing/main/image/full?mediaTicket=ticket",
    expiresAt: "2026-07-28T00:00:00.000Z",
  };

  function setup(request: GatewayRequestHandler, gatewayUrl = "wss://control.test") {
    const client = createGatewayBrowserClientFixture({ gatewayUrl, request });
    const state = createTestPageState(
      makeChatHost({ client, connected: true, connectionEpoch: 1 }),
    );
    const context = createInitializationContext(client);
    const props = createChatPaneResourceProps();
    const resolve = props(state, context).resolveArtifactDownload;
    expect(props(state, context).resolveArtifactDownload).toBe(resolve);
    return { state, resolve };
  }

  it.each<{
    page?: string;
    gateway?: string;
    http: boolean;
    variant?: "full" | "thumbnail";
    previewWidth?: ChatImageRenditionWidth;
    legacyUrl?: boolean;
  }>([
    { http: true },
    { http: true, variant: "thumbnail" },
    { http: true, variant: "full" },
    { gateway: "wss://remote.test", http: false },
    { gateway: "wss://remote.test", http: false, variant: "thumbnail" },
    { page: "http://control.test", gateway: "ws://control.test", http: true, variant: "thumbnail" },
    { gateway: "wss://remote.test", http: false, legacyUrl: true },
    ...([480, 1920] as const).map((previewWidth) => ({
      gateway: "wss://remote.test",
      http: false,
      variant: "thumbnail" as const,
      previewWidth,
    })),
  ] as const)(
    "selects transport for $page -> $gateway (variant=$variant, width=$previewWidth, legacy=$legacyUrl)",
    async ({
      page = "https://control.test",
      gateway = "wss://control.test",
      http,
      variant,
      previewWidth,
      legacyUrl,
    }) => {
      vi.stubGlobal("location", new URL(page));
      const blob = new Blob(["preview"], {
        type: variant === "thumbnail" ? "image/webp" : "image/png",
      });
      const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "Content-Disposition": ' AtTaChMeNt ; filename="image.png" ' }),
        blob: async () => blob,
      }));
      vi.stubGlobal("fetch", fetchMock);
      const request = vi.fn().mockResolvedValue(
        legacyUrl
          ? {
              artifact: { ...artifact, download: { mode: "url" } },
              url: ` ${legacy.url} `,
              expiresAt: ` ${legacy.expiresAt} `,
            }
          : http
            ? {
                artifact:
                  variant === "thumbnail" ? { ...artifact, mimeType: "image/jpeg" } : artifact,
                url: ticket,
              }
            : variant === "thumbnail"
              ? preview
              : inline,
      );
      const { state, resolve } = setup(request, gateway);
      state.resourceBasePath = "/mount";
      const params = {
        sessionKey: previewWidth ? "main" : "agent:main:main",
        artifactId: artifact.id,
      };
      const result = await resolve({ ...params, variant, previewWidth });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "artifacts.download",
        {
          ...params,
          ...(variant === "thumbnail" ? { previewWidth: previewWidth ?? 960 } : {}),
          ...(http ? { transport: "http" } : {}),
        },
        { timeoutMs: 30_000 },
      );
      if (http) {
        const url = `/mount${ticket}${variant === "thumbnail" ? "?variant=thumbnail&width=960" : ""}`;
        expect(result).toEqual({ url, blob });
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      } else {
        expect(result).toEqual(
          legacyUrl
            ? legacy
            : {
                url:
                  variant === "thumbnail"
                    ? "data:image/webp;base64,cHJldmlldw=="
                    : "data:image/png;base64,cG5n",
              },
        );
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each<{
    failure: string;
    mimeType: string;
    type: string;
    reject: boolean;
    variant?: "thumbnail";
    previewWidth?: ChatImageRenditionWidth;
  }>([
    {
      failure: "preview unavailable",
      mimeType: "image/png",
      type: "image",
      reject: false,
      variant: "thumbnail",
      previewWidth: 480,
    },
    { failure: "network", mimeType: "image/png", type: "image", reject: false, variant: undefined },
    {
      failure: "network",
      mimeType: "image/png",
      type: "image",
      reject: true,
      variant: "thumbnail" as const,
    },
    {
      failure: "missing route",
      mimeType: "image/png",
      type: "image",
      reject: true,
      variant: "thumbnail" as const,
    },
    { failure: "missing route", mimeType: "image/png", type: "image", reject: false },
    { failure: "SPA fallback", mimeType: "image/png", type: "image", reject: false },
    { failure: "wrong content type", mimeType: "image/png", type: "image", reject: false },
    { failure: "unsafe SVG", mimeType: "image/svg+xml", type: "image", reject: true },
    { failure: "unsafe HTML", mimeType: "text/html", type: "image", reject: true },
    { failure: "non-image artifact", mimeType: "image/png", type: "file", reject: true },
  ])(
    "reauthorizes failed transfers but rejects unsafe blobs: $failure",
    async ({ failure, mimeType, type, reject, variant, previewWidth }) => {
      vi.stubGlobal("location", new URL("https://control.test"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "network" || previewWidth) {
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
        .mockResolvedValue(
          previewWidth ? null : variant === "thumbnail" ? preview : reject ? download : inline,
        );
      const { resolve } = setup(request);
      const params = {
        sessionKey: previewWidth ? "main" : "agent:main:main",
        artifactId: artifact.id,
        ...(previewWidth ? { previewWidth } : {}),
      };
      const result = await resolve({ ...params, variant });
      if (variant === "thumbnail" && !previewWidth) {
        expect(result).toEqual({ url: "data:image/webp;base64,cHJldmlldw==" });
        expect(request.mock.calls.map(([, requestParams]) => requestParams)).toEqual([
          {
            sessionKey: "agent:main:main",
            artifactId: artifact.id,
            previewWidth: 960,
            transport: "http",
          },
          { sessionKey: "agent:main:main", artifactId: artifact.id, previewWidth: 960 },
        ]);
      } else if (reject) {
        expect(result).toBeNull();
        expect(request).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual(previewWidth ? null : { url: "data:image/png;base64,cG5n" });
        expect(request.mock.calls.map(([, requestParams]) => requestParams)).toEqual([
          { ...params, transport: "http" },
          params,
        ]);
      }
    },
  );

  it.each([
    ["epoch", "transfer", undefined],
    ["epoch", "transfer", "thumbnail"],
    ...(["client", "epoch", "abort", "disconnect", "reconnect"] as const).map(
      (change) => [change, "import", undefined] as const,
    ),
  ] as const)("discards downloads on %s during %s (%s)", async (change, during, variant) => {
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
    const { state, resolve } = setup(request);
    const controller = new AbortController();
    if (change === "reconnect") {
      state.connected = false;
    }
    const pending = resolve(
      { sessionKey: "main", artifactId: artifact.id, variant },
      controller.signal,
    );
    if (during === "transfer") {
      await started.promise;
    }
    if (change === "client") {
      state.client = createGatewayBrowserClientFixture({ request });
    } else if (change === "epoch") {
      state.connectionEpoch += 1;
    } else if (change === "abort") {
      controller.abort();
    } else {
      state.connected = change === "reconnect";
    }
    if (during === "transfer") {
      transfer.reject(new TypeError("Connection changed"));
    }
    await expect(pending).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(during === "transfer" ? 1 : 0);
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

describe("failed run recovery actions", () => {
  const emptyComposer = () => ({
    chatMessages: [],
    chatMessage: "",
    chatAttachments: [],
    chatMentions: [],
    chatReplyTarget: null,
    chatGoalDraftMode: null,
  });
  const failedInputState = (): Parameters<typeof createChatPaneRunRecoveryActions>[0] => ({
    ...emptyComposer(),
    sessionKey: "session-a",
    connected: true,
    chatRunId: null,
    chatSending: false,
    handleSendChat: vi.fn(),
    chatMessages: [
      { role: "user", content: [], __openclaw: { id: "user-a", seq: 1, runId: "run-a" } },
    ],
  });
  it("rewinds only the current failed input and never submits an unchanged retry", async () => {
    const state = failedInputState();
    const rewind = vi.fn(async () => true);
    let failedRunId = "run-a";
    const actions = createChatPaneRunRecoveryActions(state, {
      canSend: true,
      isCurrent: () => true,
      latestFailedRunId: () => failedRunId,
      onRewindMessage: rewind,
    });
    const edit = createFailedMessageEdit(actions.failedMessageEditSource);
    failedRunId = "run-b";
    expect(await edit?.run()).toBe(false);
    failedRunId = "run-a";
    expect(await edit?.run()).toBe(true);
    expect(rewind).toHaveBeenCalledExactlyOnceWith("user-a");
    expect(state.handleSendChat).not.toHaveBeenCalled();
    state.chatMessages.push({ role: "user", __openclaw: { id: "user-b", seq: 2, runId: "run-b" } });
    expect(await edit?.run()).toBe(false);
    expect(rewind).toHaveBeenCalledOnce();
  });

  it("preserves a pre-existing or newly typed draft without mutating history", async () => {
    const state = failedInputState();
    const rewind = vi.fn(async () => true);
    const options = {
      canSend: true,
      isCurrent: () => true,
      latestFailedRunId: () => "run-a",
      onRewindMessage: rewind,
    };
    const actions = createChatPaneRunRecoveryActions(state, options);
    const edit = createFailedMessageEdit(actions.failedMessageEditSource);
    state.chatMessage = "Keep this unsent draft";
    state.chatAttachments = [
      { id: "draft-image", mimeType: "image/png", dataUrl: "data:image/png;base64,YQ==" },
    ];
    expect(
      createFailedMessageEdit(
        createChatPaneRunRecoveryActions(state, options).failedMessageEditSource,
      )?.disabled,
    ).toBe(true);
    expect(await edit?.run()).toBe(false);
    expect(state.chatMessage).toBe("Keep this unsent draft");
    expect(state.chatAttachments.map((image) => image.id)).toEqual(["draft-image"]);
    expect(rewind).not.toHaveBeenCalled();
  });
  it("continues once from the current failed run without replaying the original prompt", () => {
    const state = {
      ...emptyComposer(),
      sessionKey: "session-a",
      connected: true,
      chatRunId: null as string | null,
      chatSending: false,
      handleSendChat: vi.fn(async () => {
        state.chatSending = true;
      }),
    };
    let current = true;
    const actions = createChatPaneRunRecoveryActions(state, {
      canSend: true,
      isCurrent: () => current,
      latestFailedRunId: () => "run-a",
    });
    actions.onRetryRun?.("old-run");
    expect(state.handleSendChat).not.toHaveBeenCalled();
    actions.onRetryRun?.("run-a");
    actions.onRetryRun?.("run-a");
    expect(state.handleSendChat).toHaveBeenCalledOnce();
    state.chatSending = false;
    current = false;
    actions.onRetryRun?.("run-a");
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  });
  it("does not expose actions without their capabilities", () => {
    const state = {
      ...emptyComposer(),
      sessionKey: "session-a",
      connected: true,
      chatRunId: null,
      chatSending: false,
      handleSendChat: vi.fn(async () => {}),
    };
    expect(
      createChatPaneRunRecoveryActions(state, {
        canSend: false,
        isCurrent: () => true,
        latestFailedRunId: () => "run-a",
      }),
    ).toEqual({ onRetryRun: undefined });
  });
});

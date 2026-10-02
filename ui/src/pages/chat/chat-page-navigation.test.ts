/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-navigation.test/"} */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { navigateChatPage, ownedChatPaneSessionKey } from "./chat-page-navigation.ts";
import {
  createChatPageNavigationContext,
  getRouteDraftForActivePane,
  setNavigationContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext,
  createSessionRouteRow,
  sessionRouteListResult,
} from "./route-resolution.test-support.ts";

type DraftRecipient = HTMLElement & {
  active: boolean;
  draft?: string;
  onOpenSplitView?: () => void;
  updateComplete: Promise<unknown>;
};

describe("chat page navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  it.each([
    { scope: "global", key: "global", agentId: "research", expected: "agent:research:main" },
    { scope: "per-sender", key: "global", agentId: "research", expected: "global" },
    {
      scope: "global",
      key: "agent:research:global",
      agentId: "main",
      expected: "agent:research:global",
    },
    { scope: "global", key: "global", agentId: undefined, expected: "global" },
  ] as const)(
    "preserves the $scope meaning of $key with captured owner $agentId",
    ({ scope, key, agentId, expected }) => {
      const { context } = createChatPageNavigationContext();
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope,
        agents: [{ id: "main" }, { id: "research" }],
      };
      expect(ownedChatPaneSessionKey(context, key, agentId)).toBe(expected);
    },
  );
  it.each([
    { agentId: "main", face: "chat" },
    { agentId: "research", face: "dashboard" },
  ] as const)(
    "keeps $agentId $face navigation stable when its pane adopts global",
    async ({ agentId, face }) => {
      for (const pendingDraft of [false, true]) {
        const search = "?draft=What+can+you+do%3F&__openclawComposerFocus=1&panel=details";
        window.history.replaceState(
          {},
          "",
          `/${face}/${agentId}${pendingDraft ? `${search}#pane` : ""}`,
        );
        const navigation = createChatPageNavigationContext();
        navigation.context.agents.state.agentsList = {
          defaultId: "main",
          mainKey: "main",
          scope: "global",
          agents: [{ id: "main" }, { id: "research" }],
        };
        navigation.context.gateway.snapshot.hello = {
          ...gatewayHelloForMethods([]),
          snapshot: {
            sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: "global" },
          },
        };
        navigation.context.agentSelection.set(agentId);
        navigateChatPage(
          navigation.context,
          {
            sessionKey: `agent:${agentId}:main`,
            face,
            ...(pendingDraft ? { draft: "What can you do?", focusComposer: true } : {}),
          },
          "global",
          true,
        );
        expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(face, {
          pathname: `/${face}/${agentId}`,
          ...(pendingDraft ? { search, hash: "#pane" } : {}),
        });
      }
    },
  );
  it.each([
    "route URL",
    "route data",
    "selected pane",
    "hidden page",
    "hidden native window",
    "disconnected page",
    "rejected recipient update",
  ])("keeps the route draft unconsumed after a %s", async (change) => {
    const previousHref = window.location.href;
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;
    const panes = () => [...page.querySelectorAll<DraftRecipient>("openclaw-chat-pane")];
    expectDefined(panes()[0], "classic pane").onOpenSplitView?.();
    await page.updateComplete;
    const recipient = expectDefined(
      panes().find((pane) => pane.active),
      "draft recipient",
    );
    const otherPane = expectDefined(
      panes().find((pane) => pane !== recipient),
      "other pane",
    );
    const accepted = createDeferred();
    const nextAccepted = createDeferred();
    recipient.updateComplete = accepted.promise;
    otherPane.updateComplete = nextAccepted.promise;
    const data = { sessionKey: "main", draft: "pending draft" };
    window.history.replaceState({}, "", "/chat/main?draft=pending+draft&panel=details");
    const updateError = new Error("recipient update failed");
    const errorLog =
      change === "rejected recipient update"
        ? vi.spyOn(console, "error").mockImplementation(() => {})
        : undefined;
    try {
      page.data = data;
      await page.updateComplete;
      expect(recipient.draft).toBe("pending draft");
      expect(navigation.replace).not.toHaveBeenCalled();

      if (change === "route URL") {
        window.history.replaceState({}, "", "/chat/main?draft=newer+draft&panel=next");
      } else if (change === "route data") {
        recipient.updateComplete = nextAccepted.promise;
        page.data = { sessionKey: "main", draft: "newer draft" };
      } else if (change === "selected pane") {
        expectDefined(
          otherPane.closest(".chat-split-view__cell"),
          "other split cell",
        ).dispatchEvent(new Event("pointerdown"));
      } else if (change === "hidden page") {
        page.presented = false;
      } else if (change === "hidden native window") {
        Object.assign(navigation.context, {
          nativeConversation: {
            presentation: { visible: false, active: true },
            subscribe: () => () => {},
          },
        });
        page.requestUpdate();
      } else if (change === "disconnected page") {
        page.remove();
      }
      await page.updateComplete;
      const replacements = navigation.replace.mock.calls.length;
      const currentHref = window.location.href;
      if (change === "selected pane") {
        expect(recipient.active).toBe(false);
        expect(otherPane.active).toBe(true);
      }

      if (change === "rejected recipient update") {
        accepted.reject(updateError);
        await expect(accepted.promise).rejects.toBe(updateError);
      } else {
        accepted.resolve();
        await accepted.promise;
      }
      await page.updateComplete;

      expect(navigation.replace).toHaveBeenCalledTimes(replacements);
      expect(window.location.href).toBe(currentHref);
      expect(getRouteDraftForActivePane(page)).toBe(
        change === "route data" ? "newer draft" : "pending draft",
      );
      if (errorLog) {
        expect(errorLog).toHaveBeenCalledExactlyOnceWith(
          "[openclaw] Route draft recipient update failed",
          updateError,
        );
      }
    } finally {
      page.remove();
      accepted.resolve();
      nextAccepted.resolve();
      await Promise.allSettled([accepted.promise, nextAccepted.promise]);
      errorLog?.mockRestore();
      window.history.replaceState(null, "", previousHref);
    }
  });

  it.each(
    (["cached short without row", "resolved row canonicalization"] as const).flatMap((source) =>
      (["unchanged", "client", "hello"] as const).map((connection) => ({ source, connection })),
    ),
  )(
    "keeps acknowledged $source cleanup bound to its $connection connection",
    async ({ source, connection }) => {
      const previousHref = window.location.href;
      const oldRow = createSessionRouteRow({
        key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
        displayName: "Deploy monitor",
      });
      const currentRow = createSessionRouteRow({
        key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
        displayName: "Deploy monitor",
      });
      const resolver = createSessionRouteContext(
        { ok: true, ...oldRow, agentId: "roboclaw" },
        source === "resolved row canonicalization" ? [oldRow] : [],
      );
      const page = new ChatPage();
      const navigation = setNavigationContext(page);
      Object.assign(navigation.context, {
        gateway: resolver.context.gateway,
        sessions: resolver.context.sessions,
        lifecycleAbortSignal: resolver.context.lifecycleAbortSignal,
      });
      Object.assign(navigation.context.gateway, { setSessionKey: vi.fn() });
      navigation.context.gateway.snapshot.hello = gatewayHelloForMethods([]);
      navigation.context.agentSelection.set("roboclaw");
      const location = {
        pathname:
          source === "cached short without row"
            ? "/chat/roboclaw/deploy-monitor-12345678"
            : "/chat/roboclaw/old-name-12345678",
        search: "?__openclawComposerFocus=1&panel=details",
        hash: "#pane",
      };
      window.history.replaceState({}, "", `${location.pathname}${location.search}${location.hash}`);
      page.data = { sessionKey: oldRow.key };
      document.body.append(page);
      await page.updateComplete;
      const recipient = expectDefined(
        page.querySelector<DraftRecipient>("openclaw-chat-pane"),
        "acknowledging pane",
      );
      const accepted = createDeferred();
      recipient.updateComplete = accepted.promise;
      try {
        if (source === "cached short without row") {
          prepareSessionNavigationHandoff(
            navigation.context.gateway,
            location.pathname,
            oldRow.key,
          );
        }
        let loaded = await loadChatRoute(
          navigation.context,
          location,
          "chat",
          new AbortController().signal,
        );
        if (!("kind" in loaded) || loaded.kind !== "session") {
          throw new Error("Expected the confirmed session route");
        }
        page.data = loaded;
        await page.updateComplete;
        if (source === "resolved row canonicalization") {
          const canonical = expectDefined(loaded.canonicalLocation, "resolved canonical location");
          expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("chat", canonical);
          window.history.replaceState(
            {},
            "",
            `${canonical.pathname}${canonical.search}${canonical.hash}`,
          );
          // The router consumes the initial handoff and installs fresh loader data.
          // Cleanup must prepare its own handoff after the pane acknowledges it.
          loaded = await loadChatRoute(
            navigation.context,
            canonical,
            "chat",
            new AbortController().signal,
          );
          if (!("kind" in loaded) || loaded.kind !== "session") {
            throw new Error("Expected the canonical session route");
          }
          page.data = loaded;
          await page.updateComplete;
          navigation.replace.mockClear();
        }
        expect(loaded).toMatchObject({ sessionKey: oldRow.key, focusComposer: true });
        expect(page.querySelector("openclaw-chat-pane")).toBe(recipient);
        const resolutionCalls = () =>
          resolver.request.mock.calls.filter(([method]) => method === "sessions.resolve");
        const callsBeforeCleanup = resolutionCalls().length;
        resolver.request.mockImplementation(async (method) => {
          if (method === "sessions.resolve") {
            return { ok: true, ...currentRow, agentId: "roboclaw" };
          }
          if (method === "sessions.subscribe") {
            return { subscribed: true };
          }
          if (method === "sessions.list") {
            return sessionRouteListResult([currentRow]);
          }
          throw new Error(`Unexpected gateway request: ${method}`);
        });
        if (connection === "client") {
          resolver.publishGateway({
            client: createTestGatewayClient(resolver.request),
          });
        } else if (connection === "hello") {
          resolver.publishGateway({ hello: gatewayHelloForMethods([]) });
        }
        page.requestUpdate();
        await page.updateComplete;
        page.presented = false;
        await page.updateComplete;
        page.presented = true;
        await page.updateComplete;
        expect(page.data).toBe(loaded);
        expect(navigation.replace).not.toHaveBeenCalled();
        accepted.resolve();
        await accepted.promise;
        await page.updateComplete;
        const cleaned = {
          pathname: window.location.pathname,
          search: "?panel=details",
          hash: "#pane",
        };
        expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("chat", cleaned);
        await expect(
          loadChatRoute(navigation.context, cleaned, "chat", new AbortController().signal),
        ).resolves.toMatchObject({
          kind: "session",
          sessionKey: connection === "unchanged" ? oldRow.key : currentRow.key,
        });
        expect(resolutionCalls()).toHaveLength(
          callsBeforeCleanup + (connection === "unchanged" ? 0 : 1),
        );
      } finally {
        page.remove();
        accepted.resolve();
        await accepted.promise;
        window.history.replaceState(null, "", previousHref);
      }
    },
  );
});

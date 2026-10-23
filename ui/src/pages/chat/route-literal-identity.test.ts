// @vitest-environment node
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import { describe, expect, it, vi } from "vitest";
import { normalizeInitialApplicationLocation } from "../../app/bootstrap-location.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
import { navigateChatPage } from "./chat-page-navigation.ts";
import { loadChatRoute } from "./route-loader.ts";
import { createSessionRouteContext as contextFor } from "./route-resolution.test-support.ts";

const signal = () => new AbortController().signal;
describe("literal session permalink identity", () => {
  it.each(["chat", "dashboard"] as const)(
    "keeps explicit main pinned through %s canonicalization and reload",
    async (namespace) => {
      const { context, request } = contextFor();
      context.basePath = "/control";
      const pathname = buildControlUiSessionPath({
        namespace,
        sessionKey: "agent:research:main",
        basePath: context.basePath,
        exactKey: true,
        literalMainKey: true,
      })!;
      const original = { pathname, search: "?draft=hello", hash: "#message" };
      const first = await loadChatRoute(context, original, namespace, signal());
      expect(first).toMatchObject({ kind: "session", sessionKey: "agent:research:main" });
      if (!("kind" in first) || first.kind !== "session") {
        throw new Error("Expected session");
      }
      const shown = first.canonicalLocation ?? original;
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "workspace",
        scope: "per-sender",
        agents: [],
      };
      await expect(loadChatRoute(context, shown, namespace, signal())).resolves.toMatchObject({
        kind: "session",
        sessionKey: "agent:research:main",
      });
      expect(shown).toEqual(original);
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each(["main", "workspace"])(
    "preserves ordinary exactKey home behavior for %s",
    async (mainKey) => {
      const { context } = contextFor();
      const pathname = buildControlUiSessionPath({
        namespace: "chat",
        sessionKey: `agent:research:${mainKey}`,
        mainKey,
        exactKey: true,
      })!;
      expect(pathname).toBe("/chat/research");
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "new-home",
        scope: "per-sender",
        agents: [],
      };
      await expect(
        loadChatRoute(context, { pathname, search: "", hash: "" }, "chat", signal()),
      ).resolves.toMatchObject({ sessionKey: "agent:research:new-home" });
    },
  );
  it.each(["/~key/main", "/main"])(
    "resolves deferred canonicalization intent for %s",
    async (suffix) => {
      const { context, publishGateway } = contextFor();
      const client = context.gateway.snapshot.client;
      context.agents.state.agentsList = null;
      context.gateway.snapshot.phase = "connecting";
      context.gateway.snapshot.client = null;
      const original = { pathname: `/chat/research${suffix}`, search: "", hash: "" };
      const first = await loadChatRoute(context, original, "chat", signal());
      if (!("kind" in first) || first.kind !== "session") {
        throw new Error("Expected session");
      }
      publishGateway({
        phase: "connected",
        client,
        hello: { snapshot: { sessionDefaults: { mainKey: "main" } } } as NonNullable<
          typeof context.gateway.snapshot.hello
        >,
      });
      const canonical = await first.canonicalLocationReady;
      expect(canonical?.pathname ?? original.pathname).toBe(
        suffix === "/main" ? "/chat/research" : original.pathname,
      );
    },
  );
  it("retains forced literal identity during preference-derived face navigation", async () => {
    const { context, request } = contextFor({
      ok: true,
      key: "agent:research:main",
      agentId: "research",
      boardFace: "dashboard",
    });
    context.basePath = "/control";
    const original = {
      pathname: "/control/chat/research/~key/main",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
      hash: "",
    };
    const first = await loadChatRoute(context, original, "chat", signal());
    expect(first).toMatchObject({
      sessionKey: "agent:research:main",
      face: "dashboard",
      canonicalLocation: { pathname: "/control/dashboard/research/~key/main", search: "" },
    });
    expect(request).toHaveBeenCalledOnce();
  });
  it("retains an explicit configurable-home marker across home changes and face navigation", async () => {
    const { context } = contextFor();
    const original = { pathname: "/chat/research/~key/workspace", search: "", hash: "" };
    const first = await loadChatRoute(context, original, "chat", signal());
    if (!("kind" in first) || first.kind !== "session") {
      throw new Error("Expected session");
    }
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "project",
      scope: "per-sender",
      agents: [],
    };
    const navigate = vi.fn<typeof context.navigate>();
    navigateChatPage({ ...context, navigate }, first, first.sessionKey, false, "dashboard");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("dashboard", {
      pathname: "/dashboard/research/~key/workspace",
    });
    const pathname = navigate.mock.calls[0]![1]!.pathname!;
    for (const mainKey of ["workspace", "project"]) {
      context.agents.state.agentsList.mainKey = mainKey;
      const reloaded = await loadChatRoute(
        context,
        { pathname, search: "", hash: "" },
        "dashboard",
        signal(),
      );
      expect(reloaded).toMatchObject({ sessionKey: "agent:research:workspace" });
      expect(reloaded).not.toHaveProperty("canonicalLocation");
    }
  });

  it("retains the raw-global source agent during preference-derived face navigation", async () => {
    const { context } = contextFor({
      ok: true,
      key: "global",
      agentId: "research",
      boardFace: "dashboard",
    });
    context.basePath = "/control";
    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/control/chat/research/~global",
        search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
        hash: "",
      },
      "chat",
      signal(),
    );
    expect(loaded).toMatchObject({
      sessionKey: "global",
      agentId: "research",
      canonicalLocation: {
        pathname: "/control/dashboard/research/~global",
        search: "",
      },
    });
  });
});

describe("public exact transcript links", () => {
  it.each([
    ["agent:research:main", "main"],
    ["agent:research:workspace", "workspace"],
    ["agent:research:project", "project"],
    ["agent:research:global", "global"],
    ["agent:research:release.js:~key:a/b", "workspace"],
    ["global", "workspace"],
  ])(
    "pins %s across home=%s, startup, canonicalization, face and reload",
    async (sessionKey, mainKey) => {
      const { context, request } = contextFor({ ok: false });
      context.basePath = "/control";
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey,
        scope: "per-sender",
        agents: [],
      };
      const original = {
        pathname: buildControlUiSessionPath({
          namespace: "chat",
          sessionKey,
          fallbackAgentId: "research",
          basePath: context.basePath,
          exactKey: true,
          literalKey: true,
        })!,
        search: "?draft=hello",
        hash: "#message",
      };
      expect(
        normalizeInitialApplicationLocation(
          original,
          context.basePath,
          "agent:other:main",
          "other",
          mainKey,
        ),
      ).toEqual(original);
      const first = await loadChatRoute(context, original, "chat", signal());
      expect(first).toMatchObject({ kind: "session", sessionKey });
      if (!("kind" in first) || first.kind !== "session") {
        throw new Error("Expected session");
      }
      const shown = first.canonicalLocation ?? original;
      context.agents.state.agentsList.mainKey = "changed-home";
      const reload = await loadChatRoute(context, shown, "chat", signal());
      expect(reload).toMatchObject({ kind: "session", sessionKey });
      const navigate = vi.fn<typeof context.navigate>();
      navigateChatPage({ ...context, navigate }, first, sessionKey, false, "dashboard", "research");
      const pathname = navigate.mock.calls[0]![1]!.pathname!;
      await expect(
        loadChatRoute(context, { pathname, search: "", hash: "" }, "dashboard", signal()),
      ).resolves.toMatchObject({ sessionKey });
      expect(request).not.toHaveBeenCalled();
    },
  );
});

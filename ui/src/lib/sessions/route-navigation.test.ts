import { expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey } from "./catalog-key.ts";
import {
  resolveSessionPreferredFaceForKey,
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "./route-navigation.ts";

const catalog = (threadId = "thread-1") => ({
  catalogId: "claude",
  hostId: "gateway:local",
  threadId,
});

it("keeps different catalog threads on different destinations", () => {
  const target = (threadId: string) =>
    sessionNavigationTarget({
      face: "chat",
      fallbackAgentId: "main",
      sessionKey: buildCatalogSessionKey(catalog(threadId)),
      mainKey: "main",
    });
  const first = target("thread-1");
  const second = target("thread-2");

  expect(first.href).toBe("/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-1");
  expect(second.href).toBe("/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-2");
  expect(first.options).not.toEqual(second.options);
});

it("requires the destination face while preserving catalog identity", () => {
  const catalogKey = catalog();
  const target = sessionNavigationTarget({
    face: "dashboard",
    fallbackAgentId: "main",
    sessionKey: buildCatalogSessionKey(catalogKey, "research"),
    basePath: "/admin/openclaw/",
    mainKey: "workspace",
  });

  expect(target).toEqual({
    href: "/admin/openclaw/dashboard/research?catalog=claude&host=gateway%3Alocal&thread=thread-1",
    options: {
      pathname: "/admin/openclaw/dashboard/research",
      search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
    },
  });
});

it("keeps ordinary literal session paths unchanged", () => {
  expect(
    sessionNavigationTarget({
      face: "chat",
      sessionKey: "telegram:12345",
      fallbackAgentId: "research",
    }),
  ).toEqual({
    href: "/chat/research/telegram/12345",
    options: { pathname: "/chat/research/telegram/12345" },
  });
});

it("leaves a cached row unmarked because its stored face is already authoritative", () => {
  const row = {
    key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
    displayName: "Release Notes",
  };
  const target = sessionNavigationTarget({
    face: "chat",
    fallbackAgentId: "main",
    sessionKey: row.key,
    row,
    preferenceDerivedFace: true,
  });

  expect(target).toEqual({
    href: "/chat/main/release-notes-1234567890abcdef1234567890abcdef",
    options: {
      pathname: "/chat/main/release-notes-1234567890abcdef1234567890abcdef",
      search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(row.key)}`,
    },
  });
});

it("treats another agent's cached global row as uncached", () => {
  const context = {
    basePath: "",
    gateway: { snapshot: { hello: null } },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    agentSelection: { state: { selectedId: "research" } },
    sessions: {
      state: {
        agentId: "main",
        result: {
          sessions: [{ key: "global", boardFace: "dashboard" }],
        },
      },
    },
  } as unknown as ApplicationContext;

  const face = resolveSessionPreferredFaceForKey(context, "global");
  const target = sessionNavigationTarget({
    context,
    face,
    sessionKey: "global",
    agentId: "research",
    preferenceDerivedFace: true,
  });

  expect(face).toBe("chat");
  expect(target.options).toEqual({
    pathname: "/chat/research",
    search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
  });
});

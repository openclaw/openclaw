import { describe, expect, it } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
  normalizeCatalogProjectGrouping,
} from "./catalog-project-grouping.ts";

describe("normalizeCatalogProjectGrouping", () => {
  it.each([
    ["person", "person"],
    [undefined, "project"],
  ] as const)("normalizes %s to %s", (raw, expected) => {
    expect(normalizeCatalogProjectGrouping(raw)).toBe(expected);
  });
});

describe("groupCatalogSessionsByProject", () => {
  it("uses a custom group before the session project", () => {
    const result = groupCatalogSessionsByProject([
      session("project", "/work/openclaw"),
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
    ]);

    expect(result.groups).toMatchObject([
      {
        key: "custom:Release",
        legacySectionKey: "custom:Release",
        label: "Release",
        sessions: [{ threadId: "grouped" }],
      },
      {
        key: "project:/work/openclaw",
        legacySectionKey: "/work/openclaw",
        label: "openclaw",
        sessions: [{ threadId: "project" }],
      },
    ]);
  });

  it.each([["C:\\Users\\dev\\openclaw\\.claude\\worktrees\\fix-1", "C:\\Users\\dev\\openclaw"]])(
    "folds worktree cwd %s into %s",
    (worktreeCwd, expectedProject) => {
      const result = groupCatalogSessionsByProject([
        session("direct", expectedProject),
        session("worktree", worktreeCwd),
      ]);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]?.key).toBe(`project:${expectedProject}`);
      expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual([
        "direct",
        "worktree",
      ]);
    },
  );

  it("leaves missing and blank cwd values ungrouped", () => {
    const result = groupCatalogSessionsByProject([
      session("missing"),
      session("blank", "  "),
      session("grouped", "/work/project"),
    ]);

    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["missing", "blank"]);
  });
});

describe("groupCatalogSessionsByPerson", () => {
  it("keeps creator namespaces separate and combines canonical profile aliases", () => {
    const result = groupCatalogSessionsByPerson([
      {
        ...session("channel"),
        createdActor: {
          type: "human",
          id: "current",
          label: "Channel",
          identity: { type: "legacy", actorType: "human", source: null, id: "current" },
        },
      },
      {
        ...session("agent"),
        createdActor: {
          type: "agent",
          id: "current",
          label: "Agent",
          identity: { type: "agent", id: "current" },
        },
      },
      {
        ...session("old-profile"),
        createdActor: {
          type: "human",
          id: "former",
          label: "Person",
          identity: { type: "profile", id: "current" },
        },
      },
      {
        ...session("profile"),
        createdActor: {
          type: "human",
          id: "current",
          label: "Person",
          identity: { type: "profile", id: "current" },
        },
      },
    ]);
    expect(result.groups.map((group) => group.sessions.map((item) => item.threadId))).toEqual([
      ["agent"],
      ["channel"],
      ["old-profile", "profile"],
    ]);
  });

  it.each([
    ["profile", "gateway-owner", "Shared owner"],
    ["agent", "gateway-owner", "gateway-owner"],
  ] as const)("labels a blank %s actor %s", (type, id, expected) => {
    const result = groupCatalogSessionsByPerson([
      {
        ...session("one"),
        createdActor: {
          type: "human",
          id,
          identity: { type, id },
          label: "  ",
        },
      },
    ]);

    expect(result.groups[0]).toMatchObject({
      key: `person:${type}:${id}`,
      legacySectionKey: `person:${id}`,
      label: expected,
    });
  });

  it("leaves unattributed sessions in the flat ungrouped tail", () => {
    const result = groupCatalogSessionsByPerson([
      session("native"),
      {
        ...session("adopted"),
        createdActor: {
          type: "human",
          id: "profile-ada",
          identity: { type: "profile", id: "profile-ada" },
          label: "Ada",
        },
      },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["native"]);
  });
});

function session(threadId: string, cwd?: string): SessionCatalogSession {
  return {
    threadId,
    cwd,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
  };
}

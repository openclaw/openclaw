import { describe, expect, it } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
  normalizeCatalogProjectGrouping,
} from "./catalog-project-grouping.ts";

type Actor = NonNullable<SessionCatalogSession["createdActor"]>;
function attributed(
  threadId: string,
  id: string,
  identity: Actor["identity"],
  label: string,
  type: Actor["type"] = "human",
) {
  return { ...session(threadId), createdActor: { type, id, identity, label } };
}

it.each([
  ["person", "person"],
  [undefined, "project"],
] as const)("normalizes %s to %s", (raw, expected) => {
  expect(normalizeCatalogProjectGrouping(raw)).toBe(expected);
});

describe("groupCatalogSessionsByProject", () => {
  it("uses a custom group before the session project", () => {
    const result = groupCatalogSessionsByProject([
      session("project", "/work/openclaw"),
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
    ]);

    expect(
      result.groups.map(({ key, legacySectionKey, label, sessions }) => [
        key,
        legacySectionKey,
        label,
        sessions.map((item) => item.threadId),
      ]),
    ).toEqual([
      ["custom:Release", "custom:Release", "Release", ["grouped"]],
      ["project:/work/openclaw", "/work/openclaw", "openclaw", ["project"]],
    ]);
  });

  it("folds Windows worktree checkouts into the project", () => {
    const expectedProject = "C:\\Users\\dev\\openclaw";
    const result = groupCatalogSessionsByProject([
      session("direct", expectedProject),
      session("worktree", `${expectedProject}\\.claude\\worktrees\\fix-1`),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key).toBe(`project:${expectedProject}`);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["direct", "worktree"]);
  });

  it("leaves missing and blank cwd values ungrouped", () => {
    const result = groupCatalogSessionsByProject([session("missing"), session("blank", "  ")]);

    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["missing", "blank"]);
  });
});

describe("groupCatalogSessionsByPerson", () => {
  it("keeps creator namespaces separate and combines canonical profile aliases", () => {
    const result = groupCatalogSessionsByPerson([
      attributed(
        "channel",
        "current",
        { type: "legacy", actorType: "human", source: null, id: "current" },
        "Channel",
      ),
      attributed("agent", "current", { type: "agent", id: "current" }, "Agent", "agent"),
      attributed("old-profile", "former", { type: "profile", id: "current" }, "Person"),
      attributed("profile", "current", { type: "profile", id: "current" }, "Person"),
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
    const result = groupCatalogSessionsByPerson([attributed("one", id, { type, id }, "  ")]);

    expect(result.groups[0]).toMatchObject({
      key: `person:${type}:${id}`,
      legacySectionKey: `person:${id}`,
      label: expected,
    });
  });

  it("leaves unattributed sessions in the flat ungrouped tail", () => {
    const result = groupCatalogSessionsByPerson([
      session("native"),
      attributed("adopted", "profile-ada", { type: "profile", id: "profile-ada" }, "Ada"),
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

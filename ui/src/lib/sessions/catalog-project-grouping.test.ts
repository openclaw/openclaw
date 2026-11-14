import { expect, it } from "vitest";
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
  ["/work/openclaw", "/work/openclaw/.claude/worktrees/fix-1"],
  ["C:\\Users\\dev\\openclaw", "C:\\Users\\dev\\openclaw\\.claude\\worktrees\\fix-1"],
])(
  "groups %s checkouts behind custom groups and leaves missing paths ungrouped",
  (cwd, worktree) => {
    expect(normalizeCatalogProjectGrouping(undefined)).toBe("project");
    const result = groupCatalogSessionsByProject([
      session("project", cwd),
      session("worktree", worktree),
      { ...session("grouped", cwd), customGroup: "Release" },
      session("missing"),
      session("blank", "  "),
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
      [`project:${cwd}`, cwd, "openclaw", ["project", "worktree"]],
    ]);
    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["missing", "blank"]);
  },
);

it("keeps creator namespaces separate, combines profile aliases, and leaves native rows ungrouped", () => {
  expect(normalizeCatalogProjectGrouping("person")).toBe("person");
  const result = groupCatalogSessionsByPerson([
    session("native"),
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
  expect(result.ungrouped.map((item) => item.threadId)).toEqual(["native"]);
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

function session(threadId: string, cwd?: string): SessionCatalogSession {
  return { threadId, cwd, status: "idle", archived: false, canContinue: true, canArchive: true };
}

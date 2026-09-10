import { describe, expect, it } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
  normalizeCatalogProjectGrouping,
} from "./catalog-project-grouping.ts";

describe("normalizeCatalogProjectGrouping", () => {
  it.each([
    ["project", "project"],
    ["person", "person"],
    ["none", "none"],
    [undefined, "project"],
    [null, "project"],
    ["garbage", "project"],
  ] as const)("normalizes %s to %s", (raw, expected) => {
    expect(normalizeCatalogProjectGrouping(raw)).toBe(expected);
  });
});

describe("groupCatalogSessionsByProject", () => {
  it("groups distinct cwd values and preserves first-occurrence and session order", () => {
    const result = groupCatalogSessionsByProject([
      session("b-1", "/work/bravo"),
      session("a-1", "/work/alpha"),
      session("b-2", "/work/bravo"),
    ]);

    expect(result.groups.map((group) => group.key)).toEqual([
      "project:/work/bravo",
      "project:/work/alpha",
    ]);
    expect(result.groups.map((group) => group.label)).toEqual(["bravo", "alpha"]);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["b-1", "b-2"]);
  });

  it("uses a custom group before the session project", () => {
    const result = groupCatalogSessionsByProject([
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
      session("project", "/work/openclaw"),
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

  it("sorts custom groups ahead of project groups regardless of session order", () => {
    const result = groupCatalogSessionsByProject([
      session("project", "/work/openclaw"),
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
    ]);

    expect(result.groups.map((group) => group.key)).toEqual([
      "custom:Release",
      "project:/work/openclaw",
    ]);
  });

  it("keeps custom groups separate from project paths with the same key text", () => {
    const result = groupCatalogSessionsByProject([
      { ...session("grouped"), customGroup: "repo" },
      session("project", "custom:repo"),
    ]);

    expect(result.groups).toMatchObject([
      { key: "custom:repo", sessions: [{ threadId: "grouped" }] },
      {
        key: "project:custom:repo",
        legacySectionKey: "custom:repo",
        sessions: [{ threadId: "project" }],
      },
    ]);
  });

  it.each([
    ["/Users/dev/openclaw/.claude/worktrees/fix-1", "/Users/dev/openclaw"],
    ["/Users/dev/openclaw/.claude/worktrees/fix-1/ui/src", "/Users/dev/openclaw"],
    ["C:\\Users\\dev\\openclaw\\.claude\\worktrees\\fix-1", "C:\\Users\\dev\\openclaw"],
    ["C:\\Users\\dev\\openclaw\\.claude\\worktrees\\fix-1\\ui\\src", "C:\\Users\\dev\\openclaw"],
  ])("folds worktree cwd %s into %s", (worktreeCwd, expectedProject) => {
    const result = groupCatalogSessionsByProject([
      session("direct", expectedProject),
      session("worktree", worktreeCwd),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key).toBe(`project:${expectedProject}`);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["direct", "worktree"]);
  });

  it("leaves missing and blank cwd values ungrouped", () => {
    const result = groupCatalogSessionsByProject([
      session("missing"),
      session("blank", "  "),
      session("grouped", "/work/project"),
    ]);

    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["missing", "blank"]);
  });

  it.each([
    ["/home/dev/.codex/worktrees/a123/repo", "/work/repo", "repo"],
    ["/home/dev/.codex/worktrees/a123/repo/ui/src", "/work/repo", "repo"],
    ["C:\\Users\\dev\\.codex\\worktrees\\a123\\repo", "E:\\work\\repo", "repo"],
    ["C:\\Users\\dev\\.codex\\worktrees\\a123\\repo\\ui\\src", "E:\\work\\repo", "repo"],
    ["C:\\Users\\dev\\.codex\\worktrees\\a123\\REPO\\ui", "E:\\work\\Repo", "Repo"],
    ["C:/Users/dev/.codex/worktrees/a123/Repo/ui", "E:/work/repo", "repo"],
    ["\\\\host\\home\\.codex\\worktrees\\a123\\REPO", "\\\\host\\work\\Repo", "Repo"],
  ])("folds Codex cwd %s only with a unique origin", (cwd, origin, label) => {
    const worktree = Object.freeze(session("worktree", cwd));
    const direct = Object.freeze(session("direct", origin));
    const result = groupCatalogSessionsByProject([
      worktree,
      direct,
      session("claude", `${origin}/.claude/worktrees/fix/ui`),
      session("duplicate", origin),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      key: `project:${origin}`,
      legacySectionKey: origin,
      label,
      title: origin,
      sessions: [
        { threadId: "worktree" },
        { threadId: "direct" },
        { threadId: "claude" },
        { threadId: "duplicate" },
      ],
    });
    expect(result.groups[0]?.sessions[0]).toBe(worktree);
    expect(worktree.cwd).toBe(cwd);
  });

  it.each([
    { origins: [] },
    { origins: ["/one/repo", "/two/repo"] },
    { origins: ["C:\\one\\repo", "D:\\two\\repo"] },
    { origins: ["/home/dev/.codex/worktrees/repo"] },
    { origins: ["repo"] },
    { origins: ["/work/../repo"] },
    { origins: ["/work/Repo"] },
  ])(
    "uses a synthetic Codex group without a trustworthy unique origin: $origins",
    ({ origins }) => {
      const cwd = "/home/dev/.codex/worktrees/a123/repo/ui";
      const result = groupCatalogSessionsByProject([
        session("worktree", cwd),
        ...origins.map((origin, index) => session(`origin-${index}`, origin)),
      ]);
      expect(result.groups[0]).toMatchObject({
        key: 'codex-worktree:["/home/dev/.codex","repo"]',
        title: "/home/dev/.codex/worktrees/repo",
        sessions: [{ threadId: "worktree" }],
      });
      expect(result.groups[0]?.sessions).toHaveLength(1);
    },
  );

  it.each([
    { origins: ["C:\\one\\repo", "D:\\two\\REPO"] },
    { origins: ["C:\\work\\repo", "C:\\work\\REPO"] },
    { origins: ["C:\\work\\repo", "C:/work/repo"] },
  ])("uses a synthetic Windows group when distinct origin keys match: $origins", ({ origins }) => {
    const cwd = "C:\\Users\\dev\\.codex\\worktrees\\a123\\repo\\ui";
    const paths = [cwd, ...origins];
    const result = groupCatalogSessionsByProject(paths.map((path, i) => session(String(i), path)));
    expect(result.groups.map((group) => group.key)).toEqual([
      'codex-worktree:["c:/users/dev/.codex","repo"]',
      ...origins.map((path) => `project:${path}`),
    ]);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["0"]);
  });

  it.each([
    ["/home/dev/.codex", "/home/dev/.codex", "repo", "repo"],
    ["C:\\Users\\Dev\\.codex", "c:/users/dev/.CODEX", "Repo", "repo"],
    ["\\\\HOST\\Home\\.codex", "//host/home/.codex", "REPO", "repo"],
  ])(
    "groups sibling worktrees under %s with stable keys and original rows",
    (owner, alias, repo, otherRepo) => {
      const first = Object.freeze(session("first", `${owner}/worktrees/a123/${repo}/ui`));
      const second = Object.freeze(session("second", `${alias}/worktrees/b456/${otherRepo}/src/`));
      const custom = Object.freeze({ ...session("custom", first.cwd), customGroup: "Release" });
      const ordinary = Object.freeze(session("ordinary", "/work/other"));
      const missing = Object.freeze(session("missing"));
      const rows = Object.freeze([first, ordinary, custom, second, missing]);
      const result = groupCatalogSessionsByProject(rows);
      expect(result.groups.map((group) => group.sessions.map((row) => row.threadId))).toEqual([
        ["custom"],
        ["first", "second"],
        ["ordinary"],
      ]);
      expect(result.groups[0]?.sessions[0]).toBe(custom);
      expect(result.groups[1]?.sessions[0]).toBe(first);
      expect(result.groups[1]?.sessions[1]).toBe(second);
      expect(result.groups[2]?.sessions[0]).toBe(ordinary);
      expect(result.ungrouped[0]).toBe(missing);
      const key = result.groups[1]?.key;
      expect(result.groups[1]?.label).toBe(otherRepo);
      expect(groupCatalogSessionsByProject([second, first]).groups[0]?.key).toBe(key);
      expect(groupCatalogSessionsByProject([second]).groups[0]?.key).toBe(key);
    },
  );

  it.each([false, true])(
    "isolates same-name repositories across Codex owners (direct origin: %s)",
    (withOrigin) => {
      const rows = [
        session("alice", "/home/alice/.codex/worktrees/a/repo/ui"),
        session("bob", "/home/bob/.codex/worktrees/b/repo/src"),
        session("alice-again", "/home/alice/.codex/worktrees/c/repo"),
        ...(withOrigin ? [session("direct", "/work/repo")] : []),
      ];
      const result = groupCatalogSessionsByProject(rows);
      expect(result.groups.map((group) => group.sessions.map((row) => row.threadId))).toEqual([
        ["alice", "alice-again"],
        ["bob"],
        ...(withOrigin ? [["direct"]] : []),
      ]);
      expect(new Set(result.groups.map((group) => group.key)).size).toBe(result.groups.length);
    },
  );

  it("disambiguates Windows labels without changing case, keys, or POSIX semantics", () => {
    const paths = [
      "C:/one/SRC/Repo",
      "D:/two/src/repo",
      "/three/Repo",
      "/unix/Alpha",
      "/unix/alpha",
    ];
    const result = groupCatalogSessionsByProject(paths.map((path, i) => session(String(i), path)));
    expect(result.groups.map((group) => group.label)).toEqual([
      "one/SRC/Repo",
      "two/src/repo",
      "three/Repo",
      "Alpha",
      "alpha",
    ]);
    expect(result.groups.map((group) => group.key)).toEqual(paths.map((path) => `project:${path}`));
  });

  it("uses shortest unique path suffixes without changing project keys", () => {
    const paths = [
      "C:\\one\\src\\repo",
      "D:\\one\\src\\repo",
      "/two/src/repo",
      "/other/repo",
      "/work/unique",
    ];
    const result = groupCatalogSessionsByProject(paths.map((path, i) => session(String(i), path)));
    expect(result.groups.map((group) => group.label)).toEqual([
      "C:/one/src/repo",
      "D:/one/src/repo",
      "two/src/repo",
      "other/repo",
      "unique",
    ]);
    expect(result.groups.map((group) => group.key)).toEqual(paths.map((path) => `project:${path}`));
    expect(result.groups.map((group) => group.title)).toEqual(paths);
  });

  it.each([
    "/tmp",
    "/var/tmp",
    "/private/tmp",
    "/private/var/tmp",
    "/var/folders/ab/user-cache/T",
    "/private/var/folders/ab/user-cache/T",
    "C:\\Users\\dev\\AppData\\Local\\Temp",
    "C:\\Windows\\Temp",
    "C:/Temp",
  ])("collects only generated projects immediately under %s", (root) => {
    const separator = root.includes("\\") ? "\\" : "/";
    const prefixes = ["zhc-", "dual-agent-", "dad-", "claude-bridge-", "openclaw-usage-probe"];
    const generated = prefixes.map((prefix, i) =>
      session(`generated-${i}`, `${root}${separator}${prefix}123${separator}src`),
    );
    const ordinary = `${root}${separator}my-project`;
    const nested = `${ordinary}${separator}zhc-user-project`;
    const result = groupCatalogSessionsByProject([
      ...generated,
      session("ordinary", ordinary),
      session("nested", nested),
      { ...session("custom", `${root}${separator}zhc-custom`), customGroup: "Release" },
    ]);
    expect(result.groups.map((group) => group.label)).toEqual([
      "Release",
      "Tests/Temporary",
      "my-project",
      "zhc-user-project",
    ]);
    expect(result.groups[1]).toMatchObject({ kind: "project", key: "temporary:tests" });
    expect(result.groups[1]?.sessions).toEqual(generated);
    expect(result.groups.slice(2).map((group) => group.key)).toEqual([
      `project:${ordinary}`,
      `project:${nested}`,
    ]);
  });

  it("combines generated projects across temp roots and excludes them as Codex origins", () => {
    const cwd = "/home/dev/.codex/worktrees/a123/zhc-probe/src";
    const result = groupCatalogSessionsByProject([
      session("windows", "C:\\Users\\dev\\AppData\\Local\\Temp\\zhc-probe"),
      session("posix", "/tmp/dad-probe"),
      session("codex", cwd),
    ]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["windows", "posix"]);
    expect(result.groups[1]?.key).toBe('codex-worktree:["/home/dev/.codex","zhc-probe"]');
  });

  it.each([
    "/work/zhc-project",
    "/work/Temp/dual-agent-project",
    "/home/dev/tmp/dad-project",
    "E:\\projects\\Temp\\claude-bridge-project",
    "/var/folders/ab/user-cache/T/ordinary/dad-project",
    "C:\\Users\\dev\\AppData\\Local\\Temp\\ordinary\\zhc-project",
    "C:/Temporary/zhc-project",
    "/tmp/ordinary",
    "/TMP/zhc-user-project",
    "/tmp/zhc-probe/../ordinary",
    "/work/.codex/worktrees",
    "/work/.codex/worktrees/id",
    "/work/.claude/worktrees",
    "/work/repo/src",
    "relative/repo",
    "relative/.codex/worktrees/id/repo",
    "/home/dev/.codex/worktrees/id/../repo",
    "/home/../dev/.codex/worktrees/id/repo",
  ])("preserves ordinary project identity %s", (cwd) => {
    const result = groupCatalogSessionsByProject([session("ordinary", cwd)]);
    expect(result.groups[0]).toMatchObject({
      key: `project:${cwd}`,
      legacySectionKey: cwd,
      title: cwd,
    });
    expect(result.groups[0]?.label).not.toBe("Tests/Temporary");
  });

  it.each([
    [" /Users/dev/openclaw/// ", "/Users/dev/openclaw", "openclaw"],
    ["C:\\Users\\dev\\openclaw\\", "C:\\Users\\dev\\openclaw", "openclaw"],
  ])("normalizes %s to project %s with label %s", (cwd, expectedPath, expectedLabel) => {
    const result = groupCatalogSessionsByProject([session("one", cwd)]);

    expect(result.groups[0]).toMatchObject({
      key: `project:${expectedPath}`,
      legacySectionKey: expectedPath,
      label: expectedLabel,
      title: expectedPath,
    });
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

  it("groups attributed sessions by creator, sorted by label, and keeps session order", () => {
    const result = groupCatalogSessionsByPerson([
      {
        ...session("z-1"),
        createdActor: {
          type: "human",
          id: "profile-zoe",
          identity: { type: "profile", id: "profile-zoe" },
          label: "Zoe",
        },
      },
      {
        ...session("a-1"),
        createdActor: {
          type: "human",
          id: "profile-ada",
          identity: { type: "profile", id: "profile-ada" },
          label: "Ada",
        },
      },
      {
        ...session("z-2"),
        createdActor: {
          type: "human",
          id: "profile-zoe",
          identity: { type: "profile", id: "profile-zoe" },
          label: "Zoe",
        },
      },
    ]);

    expect(result.groups.map((group) => group.key)).toEqual([
      "person:profile:profile-ada",
      "person:profile:profile-zoe",
    ]);
    expect(result.groups.map((group) => group.label)).toEqual(["Ada", "Zoe"]);
    expect(result.groups[1]?.sessions.map((item) => item.threadId)).toEqual(["z-1", "z-2"]);
    expect(result.groups[0]?.title).toBe("Created by Ada");
  });

  it.each([
    ["profile", "profile-ada", "profile-ada"],
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

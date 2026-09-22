import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

const homeKey = "agent:main:main";
const conversationKey = "agent:main:dashboard:conversation";
const workerKey = "agent:main:subagent:review";

// Only presentation fields consumed by the tree matter to these placement assertions.
function present(row: GatewaySessionRow, isChild = false): SidebarRecentSession {
  return {
    key: row.key,
    label: row.label ?? row.key,
    isChild,
    attention: { kind: "none" },
    hasActiveRun: row.hasActiveRun,
    runningChildCount: 0,
    failedChildCount: 0,
  } as SidebarRecentSession;
}

describe("Home-linked conversation placement", () => {
  it.each(["running", "done"] as const)(
    "keeps independent conversations outside Home with a %s worker",
    (status) => {
      const home: GatewaySessionRow = {
        key: homeKey,
        kind: "direct",
        childSessions: [conversationKey, workerKey],
      };
      const conversation: GatewaySessionRow = {
        key: conversationKey,
        kind: "direct",
        createdVia: "operator",
        spawnDepth: 0,
        parentSessionKey: homeKey,
      };
      const worker: GatewaySessionRow = {
        key: workerKey,
        kind: "direct",
        parentSessionKey: homeKey,
        spawnedBy: homeKey,
        spawnDepth: 1,
        status,
      };
      const rows = [home, conversation, worker];
      const options = {
        roots: rows,
        rowsByKey: new Map(rows.map((row) => [row.key, row])),
        mainSessionKeys: new Set([homeKey]),
        loadingChildKeys: new Set<string>(),
        knownSessionAttention: [],
        toSidebarSession: present,
      };
      const tree = projectSessionTree(options);

      expect(tree.map((row) => row.key)).toEqual([homeKey, conversationKey]);
      expect(tree[0]?.children.map((row) => row.key)).toEqual([workerKey]);
      expect(tree[1]?.isChild).toBe(false);
      expect(conversation.parentSessionKey).toBe(homeKey);
    },
  );

  it.each([
    ["explicit suggested task", { parentSessionId: "home-generation" }],
    ["visible delegated session", { spawnDepth: 1 }],
    ["fork", { forkSource: { sessionKey: homeKey, sessionId: "home-generation" } }],
    ["retained fork marker", { forkedFromParent: true }],
    ["runtime-owned child", { spawnedBy: homeKey }],
    ["older ambiguous session", { createdVia: undefined, spawnDepth: undefined }],
  ] as const)("preserves the parent of an %s", (_name, metadata) => {
    const child = {
      key: conversationKey,
      kind: "direct",
      createdVia: "operator",
      spawnDepth: 0,
      parentSessionKey: homeKey,
      ...metadata,
    } satisfies GatewaySessionRow & { parentSessionId?: string };
    const home: GatewaySessionRow = {
      key: homeKey,
      kind: "direct",
      childSessions: [child.key],
    };
    const options = {
      roots: [home, child],
      rowsByKey: new Map<string, GatewaySessionRow>([
        [home.key, home],
        [child.key, child],
      ]),
      mainSessionKeys: new Set([homeKey]),
      loadingChildKeys: new Set<string>(),
      knownSessionAttention: [],
      toSidebarSession: present,
    };
    const tree = projectSessionTree(options);
    expect(tree.map((row) => row.key)).toEqual([homeKey]);
    expect(tree[0]?.children.map((row) => row.key)).toEqual([child.key]);
  });
});

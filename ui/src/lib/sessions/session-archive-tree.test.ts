import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import { collectSessionArchiveTree } from "./session-archive-tree.ts";

const row = (key: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  sessionId: `${key}-id`,
  kind: "direct",
  updatedAt: 1,
  ...extra,
});

describe("session archive tree", () => {
  it("includes unexpanded persistent descendants through workers but excludes independent branches", async () => {
    const root = row("agent:main:parent");
    const worker = row("agent:main:subagent:worker");
    const child = row("agent:main:child");
    const grandchild = row("agent:main:grandchild");
    const children = new Map([
      [
        root.key,
        [
          worker,
          row("promoted", { sidebarRoot: true }),
          row("grouped", { category: "Work" }),
          row("archived", { archived: true }),
        ],
      ],
      [worker.key, [child]],
      [child.key, [grandchild]],
      [grandchild.key, [root]],
    ]);
    const readChildren = vi.fn(async (key: string) => children.get(key) ?? []);
    const tree = await collectSessionArchiveTree({ root, readChildren, isCurrent: () => true });
    expect(tree?.rows).toEqual([root, child, grandchild]);
    expect(tree?.ancestorsByKey.get(root.key)).toEqual([]);
    expect(tree?.ancestorsByKey.get(child.key)).toEqual([root]);
    expect(tree?.ancestorsByKey.get(grandchild.key)).toEqual([child, root]);
    expect(readChildren.mock.calls.map(([key]) => key)).toEqual([
      root.key,
      worker.key,
      child.key,
      grandchild.key,
    ]);
  });

  it("does not return a partial tree when a child read fails or the connection changes", async () => {
    const root = row("root");
    await expect(
      collectSessionArchiveTree({
        root,
        readChildren: async () => {
          throw new Error("unavailable");
        },
        isCurrent: () => true,
      }),
    ).rejects.toThrow("unavailable");
    expect(
      await collectSessionArchiveTree({
        root,
        readChildren: async () => [],
        isCurrent: () => false,
      }),
    ).toBeNull();
    expect(
      await collectSessionArchiveTree({
        root,
        readChildren: async () => null,
        isCurrent: () => true,
      }),
    ).toBeNull();
  });
});

describe("archive-tree menu availability", () => {
  it("discovers persistent descendants behind workers and preserves unloaded discovery", () => {
    const child = row("agent:main:child");
    const worker = row("agent:main:subagent:worker", { childSessions: [child.key] });
    const root = row("agent:main:parent", { childSessions: [worker.key] });
    expect(hasSessionArchiveDescendants(root, [root, worker, child])).toBe(true);
    expect(hasSessionArchiveDescendants(worker, [root, worker, child])).toBe(false);
    expect(hasSessionArchiveDescendants(root, [root])).toBe(true);
    expect(hasSessionArchiveDescendants(root, [root, { ...worker, childSessions: [] }])).toBe(
      false,
    );
    expect(
      hasSessionArchiveDescendants(root, [root, worker, { ...child, sidebarRoot: true }]),
    ).toBe(false);
    expect(
      hasSessionArchiveDescendants(root, [root, worker, { ...child, category: "Separate" }]),
    ).toBe(false);
    expect(hasSessionArchiveDescendants(root, [root, { ...worker, archived: true }, child])).toBe(
      false,
    );
    expect(
      hasSessionArchiveDescendants(root, [root, { ...worker, childSessions: [root.key] }]),
    ).toBe(false);
  });
});

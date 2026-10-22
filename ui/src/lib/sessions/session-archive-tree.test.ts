import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import { collectSessionArchiveTree } from "./session-archive-tree.ts";
import { sessionRow as row } from "./session-fixtures.test-support.ts";

const collect = (
  root: GatewaySessionRow,
  readChildren: Parameters<typeof collectSessionArchiveTree>[0]["readChildren"],
  current = true,
) => collectSessionArchiveTree({ root, readChildren, isCurrent: () => current });

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
  const tree = await collect(root, readChildren);
  expect(tree?.rows).toEqual([root, child, grandchild]);
  expect([...tree!.ancestorsByKey]).toEqual([
    [root.key, []],
    [child.key, [root]],
    [grandchild.key, [child, root]],
  ]);
  expect(readChildren.mock.calls.flat()).toEqual([root.key, worker.key, child.key, grandchild.key]);
});

it("does not return a partial tree when a child read fails or the connection changes", async () => {
  const root = row("root");
  await expect(
    collect(root, async () => {
      throw new Error("unavailable");
    }),
  ).rejects.toThrow("unavailable");
  expect(await collect(root, async () => [], false)).toBeNull();
  expect(await collect(root, async () => null)).toBeNull();
});

it("discovers persistent descendants behind workers and preserves unloaded discovery", () => {
  const child = row("agent:main:child");
  const worker = row("agent:main:subagent:worker", { childSessions: [child.key] });
  const root = row("agent:main:parent", { childSessions: [worker.key] });
  const hint = (rows: GatewaySessionRow[]) => hasSessionArchiveDescendants(root, rows);
  expect(hint([root, worker, child])).toBe(true);
  expect(hasSessionArchiveDescendants(worker, [root, worker, child])).toBe(false);
  expect(hint([root])).toBe(true);
  expect(hint([root, { ...worker, childSessions: [] }])).toBe(false);
  expect(hint([root, worker, { ...child, sidebarRoot: true }])).toBe(false);
  expect(hint([root, worker, { ...child, category: "Separate" }])).toBe(false);
  expect(hint([root, { ...worker, archived: true }, child])).toBe(false);
  expect(hint([root, { ...worker, childSessions: [root.key] }])).toBe(false);
});

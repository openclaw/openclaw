import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import { sessionRow as row } from "./session-fixtures.test-support.ts";

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

// Hook policy tests cover allow/deny decisions from hook configuration.
import { describe, expect, it } from "vitest";
import { resolveHookEntries } from "./policy.js";
import type { HookEntry, HookSource } from "./types.js";

function makeHookEntry(name: string, source: HookSource): HookEntry {
  return {
    hook: {
      name,
      description: `${name} description`,
      source,
      filePath: `/tmp/${source}/${name}/HOOK.md`,
      baseDir: `/tmp/${source}/${name}`,
      handlerPath: `/tmp/${source}/${name}/handler.js`,
    },
    frontmatter: {
      name,
    },
    metadata: {
      events: ["command:new"],
    },
    invocation: {
      enabled: true,
    },
  };
}

describe("hook policy", () => {
  describe("resolveHookEntries", () => {
    it("lets managed hooks override bundled and plugin hooks", () => {
      const bundled = makeHookEntry("shared", "openclaw-bundled");
      const plugin = makeHookEntry("shared", "openclaw-plugin");
      const managed = makeHookEntry("shared", "openclaw-managed");

      const resolved = resolveHookEntries([bundled, plugin, managed]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.hook.source).toBe("openclaw-managed");
    });

    it("prevents workspace hooks from overriding non-workspace hooks", () => {
      const managed = makeHookEntry("shared", "openclaw-managed");
      const workspace = makeHookEntry("shared", "openclaw-workspace");

      const resolved = resolveHookEntries([managed, workspace]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.hook.source).toBe("openclaw-managed");
    });

    it.each([
      ["session-memory", "openclaw-bundled", undefined],
      ["session-memory", "openclaw-managed", undefined],
      ["memory-config", "openclaw-bundled", "memory-config"],
    ] as const)(
      "prevents workspace hooks from claiming the %s key of a %s hook",
      (key, source, keptHookKey) => {
        const kept = makeHookEntry("session-memory", source);
        if (keptHookKey) {
          kept.metadata = { events: ["command:new"], hookKey: keptHookKey };
        }
        const workspace = makeHookEntry("repo-hook", "openclaw-workspace");
        workspace.metadata = { events: ["command:new"], hookKey: key };
        const collisions: unknown[] = [];

        const resolved = resolveHookEntries([kept, workspace], {
          onCollisionIgnored: (collision) => collisions.push(collision),
        });
        expect(resolved).toEqual([kept]);
        expect(collisions).toEqual([{ name: "repo-hook", kept, ignored: workspace }]);
      },
    );

    it("keeps workspace hooks whose key is not claimed by another source", () => {
      const bundled = makeHookEntry("session-memory", "openclaw-bundled");
      const workspace = makeHookEntry("repo-hook", "openclaw-workspace");
      workspace.metadata = { events: ["command:new"], hookKey: "repo-key" };

      expect(resolveHookEntries([bundled, workspace])).toEqual([bundled, workspace]);
    });

    it.each([
      ["openclaw-bundled", 0],
      ["openclaw-plugin", 0],
      ["openclaw-managed", 1],
      ["openclaw-workspace", 1],
    ] as const)("preserves the duplicate winner for %s", (source, winner) => {
      const first = makeHookEntry("shared", source);
      const second = makeHookEntry("shared", source);
      second.hook.handlerPath = `/tmp/${source}/shared/handler-2.js`;

      const resolved = resolveHookEntries([first, second]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toBe([first, second][winner]);
    });
  });
});

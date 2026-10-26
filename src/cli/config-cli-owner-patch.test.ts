import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { buildConfigOwnerPatch } from "./config-cli-owner-patch.js";

describe("buildConfigOwnerPatch", () => {
  it("sends only the change, with array replacement and deletion as explicit intent", () => {
    const previous: OpenClawConfig = {
      gateway: { reload: { mode: "hybrid" }, nodes: { commands: { allow: ["a", "b"] } } },
      agents: { entries: { main: { skills: ["notes"] } } },
      tools: { toolSearch: { include: [{ source: "mcp" }] } },
    };
    const next: OpenClawConfig = {
      gateway: { reload: { mode: "off" }, nodes: { commands: { allow: ["b"] } } },
      agents: { entries: {} },
      tools: { toolSearch: false },
    };
    const request = buildConfigOwnerPatch({ previous, next }, "base-hash");
    // v2026.10.7 Gateways accept routed writes but close config.patch over these fields.
    const stableConfigPatchFields = new Set([
      "raw",
      "baseHash",
      "sessionKey",
      "deliveryContext",
      "note",
      "restartDelayMs",
      "replacePaths",
    ]);
    expect(Object.keys(request).filter((key) => !stableConfigPatchFields.has(key))).toEqual([]);
    expect(request.baseHash).toBe("base-hash");
    expect(JSON.parse(request.raw)).toEqual({
      gateway: { reload: { mode: "off" }, nodes: { commands: { allow: ["b"] } } },
      agents: { entries: { main: null } },
      tools: { toolSearch: false },
    });
    expect(request.replacePaths).toEqual([
      "gateway.nodes.commands.allow",
      "agents.entries.main.skills",
      "tools.toolSearch.include",
    ]);
  });

  it("refuses a change the Gateway's merge patch cannot reproduce", () => {
    expect(() =>
      buildConfigOwnerPatch(
        {
          previous: {},
          // An authored null is not a value a merge patch can carry; null means delete.
          next: JSON.parse('{"gateway":{"remote":{"url":null}}}'),
        },
        undefined,
      ),
    ).toThrow("cannot be expressed as a Gateway config patch");
  });
});

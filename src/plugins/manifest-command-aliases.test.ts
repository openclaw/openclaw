// Verifies command alias metadata declared by plugin manifests.
import { describe, expect, it } from "vitest";
import {
  normalizeManifestCommandAliases,
  resolveManifestCommandAliasOwnerInRegistry,
  resolveManifestToolOwnerInRegistry,
} from "./manifest-command-aliases.js";

describe("manifest command aliases", () => {
  it("normalizes string and object entries", () => {
    expect(
      normalizeManifestCommandAliases([
        "memory",
        { name: "reindex", kind: "runtime-slash", cliCommand: "memory" },
        { name: "" },
        { name: "bad-kind", kind: "unknown" },
      ]),
    ).toEqual([
      { name: "memory" },
      { name: "reindex", kind: "runtime-slash", cliCommand: "memory" },
      { name: "bad-kind" },
    ]);
  });

  it("resolves explicit same-id aliases without treating other plugin ids as aliases", () => {
    const registry = {
      plugins: [
        {
          id: "memory-core",
          commandAliases: [{ name: "memory", kind: "runtime-slash" as const }],
        },
        {
          id: "memory",
          enabledByDefault: true,
          commandAliases: [{ name: "legacy-memory" }],
        },
        {
          id: "matrix",
          commandAliases: [{ name: "matrix" }],
        },
      ],
    };

    expect(resolveManifestCommandAliasOwnerInRegistry({ command: "memory", registry })).toBe(
      undefined,
    );
    expect(
      resolveManifestCommandAliasOwnerInRegistry({ command: "legacy-memory", registry }),
    ).toEqual({
      name: "legacy-memory",
      pluginId: "memory",
      enabledByDefault: true,
    });
    expect(resolveManifestCommandAliasOwnerInRegistry({ command: "matrix", registry })).toEqual({
      name: "matrix",
      pluginId: "matrix",
    });
  });

  it("keeps healthy command aliases after unreadable plugin metadata", () => {
    const registry = {
      plugins: [
        {
          get id() {
            throw new Error("command alias plugin id getter exploded");
          },
          commandAliases: [{ name: "broken" }],
        },
        {
          id: "healthy",
          commandAliases: [{ name: "healthy-command" }],
        },
      ],
    } as never;

    expect(
      resolveManifestCommandAliasOwnerInRegistry({ command: "healthy-command", registry }),
    ).toEqual({
      name: "healthy-command",
      pluginId: "healthy",
    });
  });

  it("does not drop command aliases when unrelated tool metadata is unreadable", () => {
    const registry = {
      plugins: [
        {
          id: "healthy",
          commandAliases: [{ name: "healthy-command" }],
          get contracts() {
            throw new Error("unrelated command alias contracts getter exploded");
          },
        },
      ],
    } as never;

    expect(
      resolveManifestCommandAliasOwnerInRegistry({ command: "healthy-command", registry }),
    ).toEqual({
      name: "healthy-command",
      pluginId: "healthy",
    });
  });

  it("does not let aliases shadow readable plugin ids with unreadable alias metadata", () => {
    const registry = {
      plugins: [
        {
          id: "memory",
          get commandAliases() {
            throw new Error("same id plugin command aliases getter exploded");
          },
        },
        {
          id: "memory-core",
          commandAliases: [{ name: "memory" }],
        },
      ],
    } as never;

    expect(resolveManifestCommandAliasOwnerInRegistry({ command: "memory", registry })).toBe(
      undefined,
    );
  });

  it("resolves agent tool owners from contracts.tools", () => {
    const registry = {
      plugins: [
        {
          id: "lossless-claw",
          contracts: { tools: ["lcm_recent", "lcm_search"] },
        },
        {
          id: "other-plugin",
          contracts: { tools: ["unrelated_tool"] },
        },
      ],
    };

    expect(resolveManifestToolOwnerInRegistry({ toolName: "lcm_recent", registry })).toEqual({
      toolName: "lcm_recent",
      pluginId: "lossless-claw",
    });
    expect(resolveManifestToolOwnerInRegistry({ toolName: "LCM_Recent", registry })).toEqual({
      toolName: "lcm_recent",
      pluginId: "lossless-claw",
    });
    expect(
      resolveManifestToolOwnerInRegistry({ toolName: "missing_tool", registry }),
    ).toBeUndefined();
    expect(resolveManifestToolOwnerInRegistry({ toolName: "", registry })).toBeUndefined();
  });

  it("keeps healthy tool owners after unreadable plugin metadata", () => {
    const registry = {
      plugins: [
        {
          id: "broken",
          get contracts() {
            throw new Error("tool owner plugin contracts getter exploded");
          },
        },
        {
          id: "healthy",
          contracts: { tools: ["healthy_tool"] },
        },
      ],
    } as never;

    expect(resolveManifestToolOwnerInRegistry({ toolName: "healthy_tool", registry })).toEqual({
      toolName: "healthy_tool",
      pluginId: "healthy",
    });
  });

  it("does not drop tool owners when unrelated command alias metadata is unreadable", () => {
    const registry = {
      plugins: [
        {
          id: "healthy",
          contracts: { tools: ["healthy_tool"] },
          get commandAliases() {
            throw new Error("unrelated tool owner command aliases getter exploded");
          },
        },
      ],
    } as never;

    expect(resolveManifestToolOwnerInRegistry({ toolName: "healthy_tool", registry })).toEqual({
      toolName: "healthy_tool",
      pluginId: "healthy",
    });
  });
});

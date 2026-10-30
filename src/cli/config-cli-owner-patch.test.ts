import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { bindConfigOwner } from "./config-cli-owner-patch.js";

// Commits one change through a synthetic owner and returns the config.patch request it sent.
async function commitThroughOwner(
  change: { previous: OpenClawConfig; next: OpenClawConfig },
  hash?: string,
) {
  const env = { OPENCLAW_CONFIG_PATH: path.resolve("synthetic-owner", "openclaw.json") };
  const sent: Record<string, unknown>[] = [];
  const requestOwner = async <R>(method: string, params: Record<string, unknown>): Promise<R> => {
    if (method !== "config.get") {
      sent.push(params);
    }
    // SAFETY: both synthetic responses match the fields the binder reads.
    return (method === "config.get" ? { path: resolveConfigPath(env), hash } : {}) as R;
  };
  const commit = await withDatabaseEngineSelection(
    { effectiveEngines: resolveDatabaseFamilyEngines({}) },
    () => bindConfigOwner(requestOwner, env),
  );
  await commit(change);
  return sent[0] as { raw: string; baseHash?: string; replacePaths?: string[] };
}

describe("bindConfigOwner", () => {
  it("sends only the change, with array replacement and deletion as explicit intent", async () => {
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
    const request = await commitThroughOwner({ previous, next }, "base-hash");
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

  it("refuses a change the Gateway's merge patch cannot reproduce", async () => {
    await expect(
      commitThroughOwner({
        previous: {},
        // An authored null is not a value a merge patch can carry; null means delete.
        next: JSON.parse('{"gateway":{"remote":{"url":null}}}'),
      }),
    ).rejects.toThrow("cannot be expressed as a Gateway config patch");
  });
});

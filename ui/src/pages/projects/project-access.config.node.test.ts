// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { normalizeConfigPatchReplacePaths } from "../../../../src/config/patch-replace-paths.js";
import { validateConfigObject } from "../../../../src/config/validation-core.js";
import { roleProjectsPatch } from "./project-access.ts";

const base = {
  gateway: {
    roles: {
      default: "contractor",
      definitions: {
        admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
        contractor: {
          sessions: { others: "none" },
          agents: "*",
          scopes: ["operator.sessions.write"],
        },
      },
    },
  },
};

function apply(config: Record<string, unknown>, projectId: string, enabled: boolean) {
  const built = roleProjectsPatch(config, "contractor", projectId, enabled);
  if ("error" in built) {
    throw new Error(built.error);
  }
  const { raw, replacePaths } = built.options;
  // config.patch applies RFC 7396 merge patches (null deletes) with array replacement intent.
  const merged = applyMergePatch(config, raw, {
    mergeObjectArraysById: true,
    replaceArrayPaths: normalizeConfigPatchReplacePaths(replacePaths),
  }) as Record<string, unknown>;
  const validated = validateConfigObject(merged);
  expect(validated.ok ? [] : validated.issues).toEqual([]);
  return merged;
}

function contractorProjects(config: Record<string, unknown>) {
  const gateway = config.gateway as typeof base.gateway;
  return (gateway.roles.definitions.contractor as Record<string, unknown>).projects;
}

describe("role project share patches against the Gateway config schema", () => {
  it("shares projects, then deletes the emptied projects field", () => {
    const shared = apply(apply(base, "site", true), "docs", true);
    expect(contractorProjects(shared)).toEqual(["site", "docs"]);
    const narrowed = apply(shared, "site", false);
    expect(contractorProjects(narrowed)).toEqual(["docs"]);
    const cleared = apply(narrowed, "docs", false);
    expect(Object.hasOwn(cleared.gateway as object, "roles")).toBe(true);
    expect(
      Object.hasOwn(
        (cleared.gateway as typeof base.gateway).roles.definitions.contractor,
        "projects",
      ),
    ).toBe(false);
  });
});

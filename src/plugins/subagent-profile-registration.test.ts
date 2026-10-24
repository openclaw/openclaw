import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createRuntimeBase } from "./runtime/runtime-base.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { PluginSubagentProfile } from "./subagent-profile.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const instructions = "Review without editing files. Report actionable findings.\n";
function fixture(declared = true) {
  const dir = tempDirs.make("subagent-profiles-");
  const root = path.join(dir, "plugin");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "reviewer.md"), instructions);
  const builder = createTestPluginRegistry(createRuntimeBase() as PluginRuntime);
  const record = createOwnershipRecord("review", {
    rootDir: root,
    contracts: declared ? { subagentProfiles: ["reviewer"] } : undefined,
  });
  const api = builder.createApi(record, { config: {} });
  const register = (input: Partial<PluginSubagentProfile> = {}) => {
    if (!api.agent.registerSubagentProfile) {
      throw new Error("profile registration unavailable");
    }
    api.agent.registerSubagentProfile({
      id: "reviewer",
      description: "Read-only review",
      instructionsFile: "reviewer.md",
      ...input,
    });
  };
  return { dir, root, api, builder, record, register };
}

describe("plugin subagent profile registration", () => {
  it("pins package bytes and immutable restrictions, with ordinary registry projection and rollback", () => {
    const { root, builder, record, register } = fixture();
    const deny = ["write", "exec"];
    const schema = { type: "object", required: ["findings"] };
    register({ tools: { deny }, outputSchema: schema });
    deny.length = 0;
    schema.required.length = 0;
    fs.writeFileSync(path.join(root, "reviewer.md"), "replacement instructions");
    expect(builder.registry.subagentProfiles).toEqual([
      {
        pluginId: "review",
        id: "reviewer",
        description: "Read-only review",
        instructionsFile: "reviewer.md",
        instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
        instructions,
        deny: ["write", "exec"],
        outputSchema: { type: "object", required: ["findings"] },
      },
    ]);
    const projected = createEmptyPluginRegistry();
    projectPluginContributions(builder.registry, record, projected);
    expect(projected.subagentProfiles).toEqual(builder.registry.subagentProfiles);
    expect(() => register()).toThrow("already registered");
    builder.rollbackPluginGlobalSideEffects(record.id, record);
    expect(builder.registry.subagentProfiles).toEqual([]);
  });

  it("does not expose registration or the capability to undeclared plugins", () => {
    const { api } = fixture(false);
    expect(api.agent.registerSubagentProfile).toBeUndefined();
    expect(api.runtime.capabilities).not.toContain("native-subagent-profiles-v1");
    expect(fixture().api.runtime.capabilities).toContain("native-subagent-profiles-v1");
  });

  it.each([
    "missing.md",
    "../outside.md",
    "/outside.md",
    "C:\\outside.md",
    "escape.md",
    "linked/brief.md",
  ])("refuses missing or escaping instruction file %s", (instructionsFile) => {
    const { dir, root, builder, register } = fixture();
    fs.writeFileSync(path.join(dir, "outside.md"), "outside");
    fs.mkdirSync(path.join(dir, "outside"));
    fs.writeFileSync(path.join(dir, "outside", "brief.md"), "outside");
    fs.symlinkSync(path.join(dir, "outside.md"), path.join(root, "escape.md"));
    fs.symlinkSync(path.join(dir, "outside"), path.join(root, "linked"), "dir");
    expect(() => register({ instructionsFile })).toThrow();
    expect(builder.registry.subagentProfiles).toEqual([]);
  });

  it.each([
    { model: "other/provider" },
    { sandbox: "off" },
    { identity: "admin" },
    { tools: { allow: ["exec"] } },
    { tools: { deny: ["read"], alsoAllow: ["exec"] } },
    { tools: { deny: [""] } },
    { outputSchema: { type: "object", properties: "invalid" } },
    { id: "foreign/reviewer" },
    { id: "undeclared" },
  ])("rejects widening and malformed profile input %j", (input) => {
    const { builder, register } = fixture();
    // Exercise JavaScript callers, not only the compile-time SDK contract.
    expect(() => Reflect.apply(register, undefined, [input])).toThrow();
    expect(builder.registry.subagentProfiles).toEqual([]);
  });
});

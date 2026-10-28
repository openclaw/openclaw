import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import { materializeClawToolProfile } from "./tool-profile-consent.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const materialize = (
  tools: Parameters<typeof materializeClawToolProfile>[0]["tools"],
  options?: Parameters<typeof materializeClawToolProfile>[1],
) => materializeClawToolProfile({ tools }, options).tools;

describe("Claw tool profile consent", () => {
  it("materializes a built-in profile into the consented agent config", async () => {
    const minimal = resolveToolProfilePolicy("minimal");
    assert(minimal?.allow, "expected minimal profile allowlist");
    const packageRoot = tempDirs.make("openclaw-claw-tool-profile-");
    await mkdir(packageRoot, { recursive: true });
    const parsed = parseClawManifest({ schemaVersion: 1, agent: { id: "profile-worker" } });
    assert(parsed.ok, JSON.stringify(parsed.diagnostics));
    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      openClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: {
            profile: "minimal",
            alsoAllow: ["tts"],
            deny: ["exec"],
            fs: { workspaceOnly: true },
          },
        },
      },
      source: {
        kind: "package",
        name: "@acme/profile-worker",
        version: "1.0.0",
        packageRoot,
        manifestPath: join(packageRoot, "openclaw.claw.json"),
        integrityKind: "development-snapshot",
        integrity: "sha256:test",
        byteLength: 0,
      },
      context: { workspace: join(packageRoot, "workspace") },
    });
    expect(plan.agent.config.tools).toEqual({
      profile: "full",
      allow: [...minimal.allow, "tts"],
      deny: ["exec"],
      fs: { workspaceOnly: true },
    });
    expect(plan.capabilityChanges.find(({ path }) => path === "agent")).toMatchObject({
      effect: { tools: { profile: "minimal", alsoAllow: ["tts"] } },
    });
  });

  it.each([
    { deny: undefined, explicitReader: false, readable: true },
    { deny: ["read"], explicitReader: false, readable: false },
    { deny: ["skills_read"], explicitReader: false, readable: false },
    { deny: ["read"], explicitReader: true, readable: true },
  ])(
    "freezes profile grants without changing skill-read access: %j",
    ({ deny, explicitReader, readable }) => {
      const allow = ["read", "write", "github__list_issues"];
      if (explicitReader) {
        allow.push("skills_read");
      }
      const tools = materialize({ profile: "coding", allow, deny });
      expect(isToolAllowedByPolicyName("skills_read", tools)).toBe(readable);
      expect(tools).toEqual({
        profile: "full",
        allow: [
          ...(deny?.includes("read") ? [] : ["read"]),
          "write",
          "apply_patch",
          ...(readable ? ["skills_read"] : []),
          "github__list_issues",
        ],
        ...(deny ? { deny } : {}),
      });
    },
  );

  it("freezes a standalone allowlist against inherited host profiles", () => {
    expect(materialize({ allow: ["read", "write", "cron"], deny: ["exec"] })).toEqual({
      profile: "full",
      allow: ["read", "write", "automations"],
      deny: ["exec"],
    });
  });

  it("freezes the bounded portion of a legacy dynamic profile for update", () => {
    const tools = materialize(
      { profile: "coding", deny: ["exec"] },
      { allowLegacyDynamicProfile: true },
    );
    expect(tools).toMatchObject({
      profile: "full",
      allow: expect.arrayContaining(["read", "write", "apply_patch"]),
      deny: ["exec"],
    });
    expect(tools?.allow).not.toContain("bundle-mcp");
  });
  it("fails closed for an empty explicit profile intersection", () => {
    expect(() => materialize({ profile: "coding", allow: ["tts"] })).toThrow("does not overlap");
  });

  it("rejects an unresolved Bundle MCP selector in a frozen profile", () => {
    expect(() => materialize({ profile: "coding" })).toThrow("bundle-mcp");
  });
});

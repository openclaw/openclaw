import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { emptyPluginCapabilityEvidence } from "./packages.test-support.js";
import { parseTemplateManifest } from "./schema.js";
import type { TemplatePackagePreflightResult } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const extension = { ref: "@acme/market-data", version: "2.0.1" } as const;

async function planApplication(
  manifest: Record<string, unknown>,
  packagePreflight?: () => Promise<TemplatePackagePreflightResult>,
) {
  const root = tempDirs.make("openclaw-template-application-plan-");
  await mkdir(join(root, "workspace", "schemas"), { recursive: true });
  await writeFile(join(root, "workspace", "schemas", "market.json"), "{}\n", "utf8");
  const parsed = parseTemplateManifest({ schemaVersion: 1, agent: { id: "analyst" }, ...manifest });
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  return buildTemplateAddPlan({
    manifest: parsed.manifest,
    source: {
      kind: "package",
      name: "@acme/market-analyst",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "CLAW.md"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    },
    context: {
      workspace: join(await realpath(root), "new-workspace"),
      ...(packagePreflight ? { packagePreflight } : {}),
    },
  });
}

function extensionPreflight(
  overrides: Partial<TemplatePackagePreflightResult> = {},
): TemplatePackagePreflightResult {
  return {
    ok: true,
    action: "install",
    integrity: `sha256:${"b".repeat(64)}`,
    installId: "market-data",
    detectedFormat: "claude",
    mapped: ["skills"],
    unavailable: [],
    adapterIdentity: "openclaw/test",
    declaredCapabilities: emptyPluginCapabilityEvidence.declared,
    capabilityGrants: emptyPluginCapabilityEvidence.grants,
    capabilityGrantsByPluginId: {
      "market-data": emptyPluginCapabilityEvidence.grants,
    },
    ...overrides,
  };
}

describe("Template application schema v1", () => {
  it("accepts inline native settings and exact ClawHub requirements without a schema bump", () => {
    expect(
      parseTemplateManifest({
        schemaVersion: 1,
        agent: { id: "analyst", tools: { profile: "coding", allow: ["read"] } },
        plugins: [extension],
      }),
    ).toMatchObject({
      ok: true,
      manifest: { schemaVersion: 1, plugins: [{ ref: "@acme/market-data", version: "2.0.1" }] },
    });
  });
  it("rejects duplicate plugin requirements", () => {
    expect(
      parseTemplateManifest({
        schemaVersion: 1,
        agent: { id: "analyst" },
        plugins: [extension, { ...extension }],
      }).ok,
    ).toBe(false);
  });
});

describe("Template application planning v1", () => {
  it("allows ordinary sessions_spawn authority without model or named delegates", async () => {
    const plan = await planApplication({
      agent: { id: "analyst", tools: { allow: ["sessions_spawn"] } },
    });
    expect(plan.agent.config).not.toHaveProperty("model");
    expect(plan.agent.config).not.toHaveProperty("subagents");
    expect(plan.capabilityChanges).toContainEqual(
      expect.objectContaining({ kind: "agent", effect: { tools: { allow: ["sessions_spawn"] } } }),
    );
    expect(plan.blockers).toEqual([]);
  });
  it("plans an inspected plugin and an ordinary managed schema asset", async () => {
    const plan = await planApplication(
      {
        plugins: [extension],
        workspace: {
          files: [{ source: "workspace/schemas/market.json", path: "schemas/market.json" }],
        },
      },
      async () => extensionPreflight({ mapped: ["commands", "skills"], unavailable: ["agents"] }),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "package",
        id: "plugin:@acme/market-data",
        blocked: false,
        details: expect.objectContaining({
          extension: expect.objectContaining({
            id: "market-data",
            detectedFormat: "claude",
            mapped: ["commands", "skills"],
            adapterIdentity: "openclaw/test",
          }),
        }),
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "schemas/market.json" }),
    );
  });
  it("reports a reused plugin with remaining local setup as setup-required", async () => {
    const prerequisite = {
      kind: "plugin-setup" as const,
      plugin: "market-data",
      provider: "market-data",
      envVars: ["MARKET_DATA_TOKEN"],
      authMethods: [],
    };
    const plan = await planApplication({ plugins: [extension] }, async () =>
      extensionPreflight({ action: "reuse", requirements: [prerequisite] }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "package",
        action: "reuse",
        details: expect.objectContaining({ requirementState: "setup-required" }),
      }),
    );
    expect(plan.readiness).toEqual({ ready: false, requirements: [prerequisite] });
  });
  it("blocks incomplete plugin adapter provenance", async () => {
    const plan = await planApplication({ plugins: [extension] }, async () =>
      extensionPreflight({ adapterIdentity: undefined }),
    );
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "plugin_capability_provenance_incomplete" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "plugin:@acme/market-data", blocked: true }),
    );
  });
});

describe("inline agent policy", () => {
  it.each([
    { model: { primary: "acme/model" } },
    { provider: "acme" },
    { subagents: { allowAgents: ["researcher"] } },
    { subagents: { delegationMode: "prefer" } },
    { model: {} },
    { model: "acme/model" },
    { subagents: {} },
    { tools: { fs: { workspaceOnly: false } } },
    { tools: { allow: ["*"] } },
    { tools: { profile: "full" } },
    { heartbeat: { target: "last" } },
    { memory: { search: { sources: ["sessions"] } } },
  ])("rejects host-owned settings or unbounded authority: %j", (agent) => {
    expect(parseTemplateManifest({ schemaVersion: 1, agent: { id: "analyst", ...agent } }).ok).toBe(
      false,
    );
  });
});

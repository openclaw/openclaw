import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { emptyPluginPlanEvidence } from "./packages.test-support.js";
import { readTemplateManifestFile } from "./reader.js";
import { parseTemplateManifest, parseTemplateOpenClawProfile } from "./schema.js";
import type { TemplateManifest, TemplateOpenClawProfile, TemplateSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const minimalManifest = { schemaVersion: 1, agent: { id: "triage" } };
const emptyGroups = "workspace: {}\npackages: []\nmcpServers: {}\ncronJobs: []";
const markdown = (agent = "agent: { id: triage }", body = "", groups = emptyGroups) =>
  `---\nschemaVersion: 1\n${agent}\n${groups}\n---${body}`;
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), "utf8");

async function writePackage(root: string, template = "CLAW.md") {
  await writeJson(join(root, "package.json"), {
    name: "@acme/github-triage",
    version: "3.2.1",
    openclaw: { template },
  });
}

async function readFixture(content: string | Buffer, filename = "CLAW.md") {
  const root = tempDirs.make("openclaw-template-reader-");
  const path = join(root, filename);
  await writeFile(path, content, "utf8");
  return { root, path, result: await readTemplateManifestFile(path) };
}

function expectDiagnostic(
  result: Awaited<ReturnType<typeof readTemplateManifestFile>>,
  code: string,
) {
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
}

const baseManifest = {
  schemaVersion: 1,
  agent: {
    id: "github-triage",
    name: "GitHub Triage",
    description: "Reviews incoming issues.",
    identity: { name: "Triage", emoji: "search" },
  },
  metadata: { "openclaw.config": "profiles/openclaw.yml" },
  workspace: {
    bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
    files: [{ source: "workspace/reference/policy.md", path: "reference/policy.md" }],
  },
  packages: [
    {
      kind: "skill",
      source: "clawhub",
      ref: "@acme/triage",
      version: "1.2.0",
    },
    {
      kind: "plugin",
      source: "clawhub",
      ref: "@acme/github",
      version: "2.0.1",
    },
  ],
  mcpServers: {
    github: {
      command: "npx",
      args: ["--yes", "@acme/github-mcp@3.4.1"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      toolFilter: { include: ["issues_list"], exclude: ["repository_delete"] },
      timeout: 30,
    },
  },
  cronJobs: [
    {
      id: "weekday-triage",
      name: "Weekday triage",
      schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" },
      session: "isolated",
      message: "Review new issues.",
      delivery: { mode: "announce", channel: "last" },
    },
  ],
} as const;

const baseOpenClawProfile: TemplateOpenClawProfile = {
  schemaVersion: 1,
  agent: {
    groupChat: { mentionPatterns: ["@triage"] },
    sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
    tools: { allow: ["read", "write"], deny: ["exec"] },
    heartbeat: { every: "30m", lightContext: true },
    humanDelay: { mode: "natural" },
  },
};

function requireManifest(value: unknown = baseManifest): TemplateManifest {
  const result = parseTemplateManifest(value);
  assert(result.ok, JSON.stringify(result.diagnostics));
  return result.manifest;
}

async function createPlanSource(): Promise<{ source: TemplateSourceIdentity; workspace: string }> {
  const root = tempDirs.make("openclaw-template-plan-");
  await mkdir(join(root, "workspace", "reference"), { recursive: true });
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Agent\n", "utf8");
  await writeFile(join(root, "workspace", "reference", "policy.md"), "Policy\n", "utf8");
  return {
    source: {
      kind: "package",
      name: "@acme/github-triage",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.template.json"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    },
    workspace: join(root, "new-workspace"),
  };
}

describe("parseTemplateManifest", () => {
  it("defaults optional ownership groups without inventing agent settings", () => {
    const manifest = requireManifest({ schemaVersion: 1, agent: { id: "minimal-agent" } });

    expect(manifest).toEqual({
      schemaVersion: 1,
      agent: { id: "minimal-agent" },
      metadata: {},
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    });
  });

  it.each(["model", "provider", "skills", "runtime", "bindings", "auth"])(
    "rejects operator-controlled agent field %s",
    (field) => {
      const result = parseTemplateManifest({
        schemaVersion: 1,
        agent: { id: "unsafe-agent", [field]: field === "skills" ? ["demo"] : "value" },
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid_manifest", path: "$.agent" }),
      );
    },
  );

  it.each(["subagents", "groupChat", "sandbox", "tools", "memory", "heartbeat", "humanDelay"])(
    "keeps harness-specific %s out of the portable agent object",
    (field) => {
      expect(
        parseTemplateManifest({
          schemaVersion: 1,
          agent: { id: "worker", [field]: {} },
        }).ok,
      ).toBe(false);
    },
  );

  it("rejects non-v1 package fields and connector packages", () => {
    function rejectPackage(pkg: unknown, path = "$.packages[0]") {
      const result = parseTemplateManifest({ ...baseManifest, packages: [pkg] });
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.path).toBe(path);
    }
    rejectPackage(
      { kind: "connector", source: "clawhub", ref: "@acme/chat", version: "1.0.0" },
      "$.packages[0].kind",
    );
    rejectPackage({ ...baseManifest.packages[0], required: false });
    rejectPackage({ ...baseManifest.packages[0], integrity: `sha256:${"a".repeat(64)}` });
  });

  it("rejects resolved MCP secrets", () => {
    const result = parseTemplateManifest({
      ...baseManifest,
      mcpServers: {
        github: { command: "npx", env: { GITHUB_TOKEN: "secret-value" } },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toBe("$.mcpServers.github.env.GITHUB_TOKEN");
  });

  it("accepts credential-free remote MCP with local OAuth completion", () => {
    const linear = {
      url: "https://mcp.linear.app/mcp",
      transport: "streamable-http",
      auth: "oauth",
      toolFilter: { include: ["list_issues"] },
    };
    const manifest = requireManifest({
      ...baseManifest,
      mcpServers: { linear },
    });
    expect(manifest.mcpServers.linear).toEqual(linear);
  });

  it.each([
    {
      url: "https://example.com/mcp",
      transport: "streamable-http",
      headers: { Authorization: "secret" },
    },
    { url: "https://example.com/mcp", transport: "streamable-http", command: "npx" },
    { url: "https://example.com/mcp", transport: "stdio" },
  ])("rejects non-portable remote MCP config %#", (server) => {
    const result = parseTemplateManifest({
      ...baseManifest,
      mcpServers: { unsafe: server },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toMatch(/^\$\.mcpServers\.unsafe/);
  });

  it("rejects workspace traversal and duplicate destinations", () => {
    const traversal = parseTemplateManifest({
      ...baseManifest,
      workspace: { files: [{ source: "../outside", path: "inside.md" }] },
    });
    expect(traversal.ok).toBe(false);

    const duplicate = parseTemplateManifest({
      ...baseManifest,
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
        files: [{ source: "workspace/other.md", path: "AGENTS.md" }],
      },
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.workspace.files[0].path" }),
    );
  });

  it("rejects duplicate packages and cron ids", () => {
    const duplicatePackage = parseTemplateManifest({
      ...baseManifest,
      packages: [baseManifest.packages[0], baseManifest.packages[0]],
    });
    expect(duplicatePackage.ok).toBe(false);

    const duplicateCron = parseTemplateManifest({
      ...baseManifest,
      cronJobs: [baseManifest.cronJobs[0], baseManifest.cronJobs[0]],
    });
    expect(duplicateCron.ok).toBe(false);
  });

  it("rejects invalid heartbeat durations and cron expressions", () => {
    const heartbeat = parseTemplateOpenClawProfile({
      schemaVersion: 1,
      agent: { heartbeat: { every: "eventually" } },
    });
    expect(heartbeat.ok).toBe(false);
    expect(heartbeat.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.agent.heartbeat.every" }),
    );

    const cron = parseTemplateManifest({
      ...baseManifest,
      cronJobs: [
        {
          ...baseManifest.cronJobs[0],
          schedule: { cron: "not a cron expression", timezone: "UTC" },
        },
      ],
    });
    expect(cron.ok).toBe(false);
    expect(cron.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.cronJobs[0].schedule.cron" }),
    );
  });
});

describe("readTemplateManifestFile", () => {
  it("takes published identity from package.json", async () => {
    const root = tempDirs.make("openclaw-template-package-");
    await writePackage(root, "openclaw.template.json");
    await writeJson(join(root, "openclaw.template.json"), minimalManifest);

    const result = await readTemplateManifestFile(root);

    assert(result.ok, "expected package to parse");
    expect(result.source).toMatchObject({
      kind: "package",
      name: "@acme/github-triage",
      version: "3.2.1",
      integrityKind: "development-snapshot",
    });
    expect(result.source.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.source.byteLength).toBeGreaterThan(0);
  });

  it("reads a human-authored CLAW.md package through the same manifest schema", async () => {
    const root = tempDirs.make("openclaw-template-markdown-");
    await writePackage(root);
    await writeFile(
      join(root, "CLAW.md"),
      markdown("categories: [operations, research]\nagent:\n  id: triage", "\n\n# GitHub Triage"),
      "utf8",
    );

    const result = await readTemplateManifestFile(root);

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        schemaVersion: 1,
        categories: ["operations", "research"],
        agent: { id: "triage" },
      },
      source: { kind: "package", name: "@acme/github-triage", version: "3.2.1" },
    });
    assert(result.ok, "expected package to parse");
    expect(result.source).not.toHaveProperty("manifestFormatPath");
    expect(result.templateMarkdownBody?.toString("utf8")).toBe("\n# GitHub Triage");
    const plan = await buildTemplateAddPlan({
      manifest: result.manifest,
      templateMarkdownBody: result.templateMarkdownBody,
      source: result.source,
      context: { workspace: join(root, "workspace-triage") },
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "SOUL.md",
        sourceKind: "templateMarkdownBody",
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    );
  });

  it("accepts a UTF-8 BOM and includes its bytes in snapshot integrity", async () => {
    const root = tempDirs.make("openclaw-template-markdown-bom-");
    await writePackage(root);
    const raw = `\uFEFF${markdown("agent:\n  id: triage")}`;
    await writeFile(join(root, "CLAW.md"), raw, "utf8");

    const result = await readTemplateManifestFile(root);

    assert(result.ok, "expected BOM-prefixed CLAW.md to parse");
    expect(result.manifest.agent.id).toBe("triage");
    expect(result.source).toMatchObject({
      integrityKind: "development-snapshot",
      byteLength: expect.any(Number),
    });

    await writeFile(join(root, "CLAW.md"), raw.slice(1), "utf8");
    const withoutBom = await readTemplateManifestFile(root);
    assert(withoutBom.ok, "expected CLAW.md without BOM to parse");
    expect(withoutBom.source.integrity).not.toBe(result.source.integrity);
  });

  it("rejects CLAW.md without YAML frontmatter", async () => {
    const { result } = await readFixture("# Missing manifest\n");
    expectDiagnostic(result, "missing_template_frontmatter");
  });

  it.each([
    ["anchor", "agent: &agent { id: triage }"],
    ["alias", "agent: { id: &id triage, name: *id }"],
    ["merge key", "agent: { <<: { id: triage } }"],
    ["explicit tag", "agent: { id: !!str triage }"],
  ])("rejects CLAW.md YAML %s", async (_label, declaration) => {
    const { result } = await readFixture(markdown(declaration));
    expectDiagnostic(result, "unsupported_template_yaml_feature");
  });

  it("rejects a CLAW.md body that is not valid UTF-8", async () => {
    const frontmatter = Buffer.from(markdown(undefined, "\n"));
    const { result } = await readFixture(Buffer.concat([frontmatter, Buffer.from([0x80])]));
    expectDiagnostic(result, "invalid_template_markdown_utf8");
  });

  it("rejects two competing SOUL.md sources", async () => {
    const { result } = await readFixture(
      markdown(
        undefined,
        "\nPortable soul",
        "workspace:\n  bootstrapFiles:\n    SOUL.md: { source: workspace/SOUL.md }\npackages: []\nmcpServers: {}\ncronJobs: []",
      ),
    );
    expectDiagnostic(result, "template_body_soul_conflict");
  });

  it("synthesizes explicit development identity for a standalone manifest", async () => {
    const { result } = await readFixture(
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo-agent" } }),
      "demo.template.json",
    );

    assert(result.ok, "expected development manifest to parse");
    expect(result.source).toMatchObject({
      kind: "development",
      name: "local:demo.template",
      version: "0.0.0-development",
    });
  });

  it("rejects workspace sources through an intermediate symlink", async () => {
    const root = tempDirs.make("openclaw-template-reader-symlink-");
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "workspace", "AGENTS.md"), "# Agent\n", "utf8");
    await symlink(
      join(root, "workspace"),
      join(root, "workspace-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifestPath = join(root, "demo.template.json");
    await writeJson(manifestPath, {
      schemaVersion: 1,
      agent: { id: "symlink-agent" },
      workspace: { bootstrapFiles: { "AGENTS.md": { source: "workspace-link/AGENTS.md" } } },
    });

    const result = await readTemplateManifestFile(manifestPath);

    expectDiagnostic(result, "workspace_source_unsafe");
  });

  it("rejects a workspace source over the per-file byte limit", async () => {
    const root = tempDirs.make("openclaw-template-reader-file-limit-");
    await writeFile(join(root, "large.md"), Buffer.alloc(1024 * 1024 + 1));
    const manifestPath = join(root, "demo.template.json");
    await writeJson(manifestPath, {
      schemaVersion: 1,
      agent: { id: "large-agent" },
      workspace: { files: [{ source: "large.md", path: "large.md" }] },
    });

    const result = await readTemplateManifestFile(manifestPath);

    expectDiagnostic(result, "workspace_source_too_large");
  });

  it("rejects aggregate workspace bytes before reading source contents", async () => {
    const root = tempDirs.make("openclaw-template-reader-aggregate-limit-");
    const files = [];
    for (let index = 0; index < 5; index += 1) {
      const source = `large-${index}.md`;
      await writeFile(join(root, source), Buffer.alloc(1024 * 1024, index));
      files.push({ source, path: source });
    }
    const manifestPath = join(root, "demo.template.json");
    await writeJson(manifestPath, {
      schemaVersion: 1,
      agent: { id: "large-agent" },
      workspace: { files },
    });

    const result = await readTemplateManifestFile(manifestPath);

    expectDiagnostic(result, "workspace_sources_too_large");
  });

  it.runIf(process.platform !== "win32")(
    "uses the declared CLAW.md path when it is an in-package symlink",
    async () => {
      const root = tempDirs.make("openclaw-template-markdown-link-");
      await writePackage(root);
      await writeFile(join(root, "manifest.json"), markdown("agent:\n  id: triage"), "utf8");
      await symlink("manifest.json", join(root, "CLAW.md"));

      const result = await readTemplateManifestFile(root);

      expect(result).toMatchObject({
        ok: true,
        manifest: { agent: { id: "triage" } },
        source: { manifestPath: await realpath(join(root, "manifest.json")) },
      });
    },
  );

  it("rejects package manifests that escape the package root", async () => {
    const parent = tempDirs.make("openclaw-template-escape-");
    const root = join(parent, "package");
    await mkdir(root);
    await writeJson(join(parent, "outside.json"), { schemaVersion: 1, agent: { id: "outside" } });
    await writeJson(join(root, "package.json"), {
      name: "@acme/escape",
      version: "1.0.0",
      openclaw: { template: "../outside.json" },
    });

    const result = await readTemplateManifestFile(root);

    expectDiagnostic(result, "manifest_escapes_package");
  });
});

describe("buildTemplateAddPlan", () => {
  let source: TemplateSourceIdentity;
  let workspace: string;
  beforeEach(async () => {
    ({ source, workspace } = await createPlanSource());
  });
  function buildPlan(overrides: Partial<Parameters<typeof buildTemplateAddPlan>[0]> = {}) {
    return buildTemplateAddPlan({
      manifest: requireManifest(),
      source,
      ...overrides,
      context: { workspace, ...overrides.context },
    });
  }

  it("materializes resolved package identity into the consented plan", async () => {
    const plan = await buildPlan({
      context: {
        packagePreflight: async (pkg) => ({
          ok: true,
          action: "install",
          integrity: `sha256:${(pkg.kind === "skill" ? "a" : "b").repeat(64)}`,
          warning: `Review ${pkg.ref} before installation.`,
          ...(pkg.kind === "plugin"
            ? {
                installId: "github",
                ...emptyPluginPlanEvidence,
              }
            : {}),
        }),
      },
    });

    const expectedPackages = [
      {
        id: "skill:@acme/triage",
        integrity: `sha256:${"a".repeat(64)}`,
        riskWarning: "Review @acme/triage before installation.",
      },
      {
        id: "plugin:@acme/github",
        integrity: `sha256:${"b".repeat(64)}`,
        installId: "github",
        riskWarning: "Review @acme/github before installation.",
      },
    ];
    expect(plan.actions.filter((action) => action.kind === "package")).toEqual(
      expectedPackages.map(({ id, integrity, ...details }) =>
        expect.objectContaining({
          id,
          digest: integrity,
          blocked: false,
          details: expect.objectContaining({ ownerAction: "install", ...details }),
        }),
      ),
    );
    expect(plan.capabilityChanges.filter((change) => change.kind === "package")).toEqual(
      expect.arrayContaining(
        expectedPackages.map(({ id, ...effect }) =>
          expect.objectContaining({ id, effect: expect.objectContaining(effect) }),
        ),
      ),
    );
  });

  it("includes package setup requirements in plan readiness", async () => {
    const plan = await buildPlan({
      context: {
        packagePreflight: async (pkg) => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          ...(pkg.kind === "plugin"
            ? {
                installId: "github",
                ...emptyPluginPlanEvidence,
                requirements: [
                  {
                    kind: "plugin-setup" as const,
                    plugin: "github",
                    provider: "github",
                    envVars: ["GITHUB_TOKEN"],
                    authMethods: ["token"],
                  },
                ],
              }
            : {}),
        }),
      },
    });

    expect(plan.readiness.ready).toBe(false);
    expect(plan.readiness.requirements).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "plugin-setup", plugin: "github" })]),
    );
    expect(plan.actions.find((action) => action.id === "plugin:@acme/github")?.details).toEqual(
      expect.objectContaining({
        prerequisites: expect.arrayContaining([expect.objectContaining({ kind: "plugin-setup" })]),
      }),
    );
  });

  it("plans one new agent, workspace, packages, MCP servers, and agent-pinned cron jobs", async () => {
    const canonicalWorkspace = join(await realpath(source.packageRoot), "new-workspace");
    const plan = await buildPlan({ openClawProfile: baseOpenClawProfile });

    expect(plan).toMatchObject({
      schemaVersion: "openclaw.templateAddPlan.v1",
      manifestSchemaVersion: 1,
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      agent: {
        requestedId: "github-triage",
        finalId: "github-triage",
        workspace: canonicalWorkspace,
      },
      readiness: {
        ready: false,
        requirements: [{ kind: "environment", mcpServer: "github", name: "GITHUB_TOKEN" }],
      },
      summary: {
        totalActions: 9,
        agentActions: 1,
        workspaceActions: 3,
        packageActions: 2,
        mcpServerActions: 1,
        cronJobActions: 2,
        blockedActions: 2,
        capabilityEscalations: 5,
      },
    });
    expect(plan.capabilityChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", id: "github-triage" }),
        expect.objectContaining({ kind: "package", id: "plugin:@acme/github" }),
        expect.objectContaining({ kind: "mcpServer", id: "github" }),
        expect.objectContaining({ kind: "cronJob", id: "weekday-triage" }),
      ]),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "AGENTS.md",
        digest: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "cronJob",
        id: "weekday-triage",
        target: "cron:weekday-triage:agent=github-triage",
      }),
    );
  });

  it("numbers an existing agent while blocking configured workspace and MCP collisions", async () => {
    const plan = await buildPlan({
      context: {
        existingAgentIds: ["github-triage"],
        existingWorkspacePaths: [workspace],
        existingMcpServerNames: ["github"],
      },
    });

    expect(plan.agent.finalId).toBe("github-triage-2");
    expect(plan.blockers.map((item) => item.code)).toEqual([
      "workspace_collision",
      "package_install_unavailable",
      "package_install_unavailable",
      "mcp_server_collision",
    ]);
    expect(plan.summary.blockedActions).toBe(6);
  });

  it("canonicalizes a missing workspace through an existing aliased parent", async () => {
    const root = tempDirs.make("openclaw-template-workspace-alias-");
    const canonicalParent = join(root, "canonical");
    const aliasParent = join(root, "alias");
    await mkdir(canonicalParent);
    await symlink(canonicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const canonicalWorkspace = join(await realpath(canonicalParent), "new-workspace");

    const plan = await buildPlan({
      context: {
        workspace: join(aliasParent, "new-workspace"),
        existingWorkspacePaths: [canonicalWorkspace],
      },
    });

    expect(plan.agent.workspace).toBe(canonicalWorkspace);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "workspace_collision" }));
  });

  it("plans reuse for an exact existing MCP server", async () => {
    const manifest = requireManifest();
    const plan = await buildPlan({
      manifest,
      context: {
        existingMcpServers: { github: manifest.mcpServers.github! },
      },
    });

    expect(plan.blockers.map((item) => item.code)).not.toContain("mcp_server_collision");
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "mcpServer",
        id: "github",
        blocked: false,
        details: expect.objectContaining({ expectedState: "present-exact" }),
      }),
    );
  });

  it("uses an explicit unused agent id for every derived action", async () => {
    const plan = await buildPlan({ context: { agentId: "triage-two" } });

    expect(plan.agent.finalId).toBe("triage-two");
    expect(plan.actions.find((action) => action.kind === "agent")?.id).toBe("triage-two");
    expect(plan.actions.find((action) => action.kind === "cronJob")?.target).toContain(
      "agent=triage-two",
    );
  });

  it("rejects workspace sources through symlinked parents", async () => {
    await symlink(
      join(source.packageRoot, "workspace"),
      join(source.packageRoot, "workspace-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const plan = await buildPlan({
      manifest: requireManifest({
        schemaVersion: 1,
        agent: { id: "symlink-agent" },
        workspace: {
          bootstrapFiles: { "AGENTS.md": { source: "workspace-link/AGENTS.md" } },
        },
      }),
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_source_unsafe" }),
    );
    const workspaceAction = plan.actions.find(
      (action) => action.kind === "workspaceFile" && action.id === "AGENTS.md",
    );
    expect(workspaceAction).toMatchObject({ kind: "workspaceFile", blocked: true });
    expect(workspaceAction).not.toHaveProperty("digest");
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes workspace identity through symlinked parents",
    async () => {
      const realParent = join(source.packageRoot, "real-parent");
      const aliasParent = join(source.packageRoot, "alias-parent");
      await mkdir(realParent, { recursive: true });
      await symlink(realParent, aliasParent, "dir");

      const plan = await buildPlan({
        manifest: requireManifest({ schemaVersion: 1, agent: { id: "canonical-agent" } }),
        context: { workspace: join(aliasParent, "workspace-canonical-agent") },
      });

      const canonicalWorkspace = join(await realpath(realParent), "workspace-canonical-agent");
      expect(plan.agent.workspace).toBe(canonicalWorkspace);
      expect(plan.agent.config.workspace).toBe(canonicalWorkspace);
      expect(plan.actions.find((action) => action.kind === "workspace")?.target).toBe(
        canonicalWorkspace,
      );
    },
  );

  it("blocks aggregate workspace bytes before hashing sources", async () => {
    const files = [];
    for (let index = 0; index < 5; index += 1) {
      const sourcePath = `workspace/large-${index}.md`;
      await writeFile(join(source.packageRoot, sourcePath), Buffer.alloc(1024 * 1024, index));
      files.push({ source: sourcePath, path: `large-${index}.md` });
    }
    const plan = await buildPlan({
      manifest: requireManifest({
        schemaVersion: 1,
        agent: { id: "large-agent" },
        workspace: { files },
      }),
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_sources_too_large" }),
    );
    const workspaceFileActions = plan.actions.filter((action) => action.kind === "workspaceFile");
    expect(workspaceFileActions).toHaveLength(5);
    expect(workspaceFileActions.every((action) => action.blocked)).toBe(true);
    expect(workspaceFileActions.every((action) => !Object.hasOwn(action, "digest"))).toBe(true);
  });
  it("binds plan integrity to the source and planned mutations", async () => {
    const input = { openClawProfile: baseOpenClawProfile };
    const first = await buildPlan(input);
    const repeated = await buildPlan(input);
    const changed = await buildPlan({
      ...input,
      source: { ...source, integrity: "sha256:changed" },
    });
    const changedCapability = await buildPlan({
      ...input,
      openClawProfile: {
        ...baseOpenClawProfile,
        agent: {
          ...baseOpenClawProfile.agent,
          tools: { allow: ["read", "exec"] },
        },
      },
    });

    expect(repeated.planIntegrity).toBe(first.planIntegrity);
    // Existing consent tokens bind this description for profiles without the new fields.
    expect(first.capabilityChanges.find((change) => change.kind === "agent")?.reason).toBe(
      "The new agent declares sandbox, tool, memory-search, or recurring heartbeat capabilities.",
    );
    expect(changed.planIntegrity).not.toBe(first.planIntegrity);
    expect(changedCapability.planIntegrity).not.toBe(first.planIntegrity);
  });
});

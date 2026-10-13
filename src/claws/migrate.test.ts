import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
} from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { applyClawMigrationPlan, buildClawMigrationPlan, ClawMigrationError } from "./migrate.js";
import {
  persistClawMigrationOwnership,
  persistClawPackageRef,
  readClawInstallRecord,
} from "./provenance.js";
import { CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION, upsertClawWorkspaceFile } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(agent: Record<string, unknown> = {}) {
  const root = tempDirs.make("openclaw-claw-migrate-");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "# Existing agent\n", "utf8");
  await writeFile(join(workspace, "SOUL.md"), "Use the current voice.\n", "utf8");
  await writeFile(join(workspace, "unrelated.json"), '{"keep":true}\n', "utf8");
  const env = {
    ...process.env,
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: join(root, "state"),
  };
  const config: OpenClawConfig = {
    agents: {
      entries: {
        worker: { workspace, ...agent },
      },
    },
  };
  const build = (activeConfig = config) =>
    buildClawMigrationPlan({ agentId: "worker", config: activeConfig, options: { env } });
  return { root, workspace, env, config, build };
}

describe("Claw migration planning", () => {
  it("builds a stable read-only plan without creating a package or state database", async () => {
    const { workspace, env, build } = await fixture({
      name: "Existing worker",
      heartbeat: { every: "30m" },
    });
    const first = await build();
    const second = await build();

    expect(first.plan).toMatchObject({
      schemaVersion: "openclaw.clawMigrationPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      agentId: "worker",
      workspace,
      workspaceFiles: [
        { path: join(workspace, "AGENTS.md") },
        { path: join(workspace, "SOUL.md") },
      ],
      generatedPackageFiles: [
        { path: "CLAW.md" },
        { path: "package.json" },
        { path: "profiles/openclaw.yml" },
        { path: "workspace/AGENTS.md" },
      ],
    });
    expect(first.plan.planIntegrity).toBe(second.plan.planIntegrity);
    await expect(access(first.plan.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(join(workspace, "AGENTS.md"), "# Updated agent\n", "utf8");
    const changed = await build();
    expect(changed.plan.planIntegrity).not.toBe(first.plan.planIntegrity);
  });

  it("fails closed when a selected prompt file is a symbolic link", async () => {
    const { root, workspace, build } = await fixture();
    const outside = join(root, "outside.md");
    await writeFile(outside, "# Outside file\n", "utf8");
    await symlink(outside, join(workspace, "IDENTITY.md"));
    await expect(build()).rejects.toMatchObject({
      code: "workspace_file_unsafe",
      path: "$.workspace.IDENTITY.md",
    });
  });

  it.each(["nested", "alias", "package"] as const)(
    "rejects overlapping %s workspace ownership",
    async (kind) => {
      const { root, workspace, env, build } = await fixture();
      let otherWorkspace =
        kind === "package" ? join(env.OPENCLAW_STATE_DIR, "claws") : join(workspace, "child");
      if (kind !== "nested") {
        await mkdir(otherWorkspace, { recursive: true });
      }
      if (kind === "alias") {
        const alias = join(root, "workspace-alias");
        await symlink(otherWorkspace, alias);
        otherWorkspace = alias;
      }
      await expect(
        build({
          agents: { entries: { worker: { workspace }, other: { workspace: otherWorkspace } } },
        }),
      ).rejects.toMatchObject({
        code:
          kind === "package"
            ? "package_destination_owned_by_agent"
            : "workspace_ownership_ambiguous",
      });
    },
  );

  it("rejects orphan secondary Claw refs during planning and the ownership transaction", async () => {
    const { env, build } = await fixture();
    const migration = await build();
    persistClawPackageRef(
      migration.addPlan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "1.0.0",
        integrity: `sha256:${"a".repeat(64)}`,
      },
      { env },
    );

    await expect(build()).rejects.toMatchObject({ code: "secondary_resources_unclaimed" });
    expect(() =>
      persistClawMigrationOwnership(migration.addPlan, migration.ownershipFiles, { env }),
    ).toThrow(/unclaimed Claw resource references/u);
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("rejects orphan workspace ownership rows during planning and the ownership transaction", async () => {
    const { workspace, env, build } = await fixture();
    const migration = await build();
    upsertClawWorkspaceFile(
      {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: "worker",
        workspace,
        path: join(workspace, "unrelated.json"),
        sourcePath: "workspace/unrelated.json",
        contentDigest: `sha256:${"b".repeat(64)}`,
        status: "complete",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      { env },
    );

    expect(() =>
      persistClawMigrationOwnership(migration.addPlan, migration.ownershipFiles, { env }),
    ).toThrow(/unclaimed Claw workspace-file ownership record/u);
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
    await expect(build()).rejects.toMatchObject({ code: "workspace_ownership_unclaimed" });
  });

  it("captures a representable inherited default model in the generated package", async () => {
    const { workspace, env } = await fixture();
    const config = {
      agents: {
        defaults: {
          model: { primary: "provider/default", fallbacks: ["provider/fallback"] },
          compaction: { mode: "safeguard" },
          subagents: {
            allowAgents: ["researcher"],
            delegationMode: "prefer",
            maxConcurrent: DEFAULT_SUBAGENT_MAX_CONCURRENT,
            archiveAfterMinutes: DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
          },
          heartbeat: { agentId: "worker", every: "45m" },
          sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "rw" },
          humanDelay: { mode: "custom", minMs: 100, maxMs: 300 },
        },
        entries: { worker: { workspace } },
      },
    } as unknown as OpenClawConfig;
    const migration = await buildClawMigrationPlan({
      agentId: "worker",
      config,
      options: { env },
    });

    expect(migration.profile?.agent.model).toEqual({
      primary: "provider/default",
      fallbacks: ["provider/fallback"],
    });
    expect(migration.addPlan.agent.config.model).toEqual(migration.profile?.agent.model);
    expect(migration.profile?.agent).toMatchObject({
      subagents: { allowAgents: ["researcher"], delegationMode: "prefer" },
      heartbeat: { every: "45m" },
      sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "rw" },
      humanDelay: { mode: "custom", minMs: 100, maxMs: 300 },
    });
    expect(migration.profile?.agent.heartbeat).not.toHaveProperty("agentId");
  });

  it("migrates a representable string model setting", async () => {
    const { env, config } = await fixture({ model: "provider/model" });
    const migration = await buildClawMigrationPlan({
      agentId: "worker",
      config,
      options: { env },
    });

    expect(migration.profile?.agent.model).toEqual({ primary: "provider/model" });
  });

  it.each([
    {
      name: "agent settings",
      agent: { skills: ["local-only"] },
      defaults: undefined,
      code: "agent_setting_unsupported",
      fields: [],
    },
    {
      name: "inherited settings",
      agent: {},
      defaults: {
        compaction: { mode: "default" as const },
        params: { temperature: 0.2 },
        skills: ["local-only"],
      },
      code: "agent_default_setting_unsupported",
      fields: ["compaction", "params", "skills"],
    },
    {
      name: "inherited subagent limits",
      agent: {},
      defaults: { subagents: { maxConcurrent: 3, archiveAfterMinutes: 90 } },
      code: "agent_default_setting_unsupported",
      fields: ["subagents.archiveAfterMinutes"],
    },
  ])("rejects unrepresentable $name", async ({ agent, defaults, code, fields }) => {
    const { config, build } = await fixture(agent);
    const result = build({ agents: { ...config.agents, defaults } });
    await expect(result).rejects.toMatchObject({ code });
    for (const field of fields) {
      await expect(result).rejects.toMatchObject({
        message: expect.stringContaining(`agents.defaults.${field}`),
      });
    }
  });

  it("rejects selected workspace changes after consent and cleans the generated package", async () => {
    const { workspace, env, config, build } = await fixture();
    const migration = await build();
    await writeFile(join(workspace, "AGENTS.md"), "# Changed after consent\n", "utf8");

    await expect(
      applyClawMigrationPlan({ migration, config, options: { env } }),
    ).rejects.toMatchObject({ code: "workspace_file_changed_after_consent" });
    await expect(access(migration.plan.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    "api_key = abcdef0123456789abcdef",
    "Authorization: Bearer bearer-token-value-that-must-not-leak",
    `Authorization: Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`,
    "session JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepayloadvalue",
    "AWS_SECRET_ACCESS_KEY=0123456789abcdef0123456789abcdef01234567",
    "GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuv",
  ])("rejects common workspace credential formats", async (secret) => {
    const { workspace, build } = await fixture();
    const file = secret.startsWith("api_key") ? "TOOLS.md" : "HEARTBEAT.md";
    await writeFile(join(workspace, file), `${secret}\n`, "utf8");

    let failure: unknown;
    try {
      await build();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ClawMigrationError);
    expect(failure).toMatchObject({
      code: "workspace_file_secret_detected",
      path: `$.workspace.${file}`,
    });
    expect(String(failure)).not.toContain(secret);
    if (secret.startsWith("GITHUB_TOKEN=")) {
      expect(String(failure)).not.toContain("ghp_0123456789abcdefghijklmnopqrstuv");
    }
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrationPlan } from "../apply.js";
import { buildMigrationPlan } from "../plan.js";
import { detectMigrationSources } from "../registry.js";

async function makeHermesHome(): Promise<{
  root: string;
  hermes: string;
  state: string;
  workspace: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-migration-"));
  const hermes = path.join(root, ".hermes");
  const state = path.join(root, ".openclaw");
  const workspace = path.join(state, "workspace");
  await fs.mkdir(path.join(hermes, "memories"), { recursive: true });
  await fs.mkdir(path.join(hermes, "skills", "demo-skill"), { recursive: true });
  await fs.mkdir(path.join(hermes, "cron"), { recursive: true });
  await fs.writeFile(path.join(hermes, "SOUL.md"), "hermes soul\n");
  await fs.writeFile(path.join(hermes, "memories", "USER.md"), "hermes user\n");
  await fs.writeFile(path.join(hermes, "memories", "MEMORY.md"), "hermes memory\n");
  await fs.writeFile(
    path.join(hermes, "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: demo\n---\n",
  );
  await fs.writeFile(path.join(hermes, "cron", "jobs.yaml"), "[]\n");
  await fs.writeFile(
    path.join(hermes, ".env"),
    ["OPENAI_API_KEY=sk-test-openai", "BRAVE_API_KEY=brave-test"].join("\n"),
  );
  await fs.writeFile(
    path.join(hermes, "config.yaml"),
    [
      "model:",
      "  default: openai/gpt-5.4",
      "providers:",
      "  openai:",
      "    base_url: https://api.openai.com/v1",
      "    api_key_env: OPENAI_API_KEY",
      "    models:",
      "      - gpt-5.4",
      "memory:",
      "  provider: honcho",
      "  honcho:",
      "    recall_mode: hybrid",
      "skills:",
      "  config:",
      "    demo-skill:",
      "      project: docs",
      "mcp_servers:",
      "  time:",
      "    command: npx",
      "    args: ['-y', 'mcp-server-time']",
    ].join("\n"),
  );
  return { root, hermes, state, workspace };
}

describe("Hermes migration provider", () => {
  it("detects Hermes homes from HERMES_HOME", async () => {
    const fixture = await makeHermesHome();
    const detections = await detectMigrationSources({ HERMES_HOME: fixture.hermes });

    expect(detections).toEqual([
      expect.objectContaining({
        providerId: "hermes",
        sourceDir: fixture.hermes,
        confidence: "high",
      }),
    ]);
  });

  it("builds a redacted-safe plan with memory, plugin, provider, skill, mcp, and archive actions", async () => {
    const fixture = await makeHermesHome();
    const plan = await buildMigrationPlan({
      providerId: "hermes",
      sourceDir: fixture.hermes,
      targetStateDir: fixture.state,
      targetWorkspaceDir: fixture.workspace,
      migrateSecrets: true,
      env: { HOME: fixture.root },
    });

    expect(plan.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining([
        "copyFile",
        "copyTree",
        "mergeConfig",
        "writeEnv",
        "writeSecretRef",
        "enablePlugin",
        "archiveOnly",
      ]),
    );
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "enablePlugin", pluginId: "honcho" }),
        expect.objectContaining({ kind: "mergeConfig", category: "mcp" }),
        expect.objectContaining({ kind: "mergeConfig", category: "skills" }),
      ]),
    );
  });

  it("applies into a fresh OpenClaw state and blocks existing state by default", async () => {
    const fixture = await makeHermesHome();
    const env = {
      HOME: fixture.root,
      OPENCLAW_STATE_DIR: fixture.state,
      OPENCLAW_CONFIG_PATH: path.join(fixture.state, "openclaw.json"),
    };
    const plan = await buildMigrationPlan({
      providerId: "hermes",
      sourceDir: fixture.hermes,
      targetStateDir: fixture.state,
      targetWorkspaceDir: fixture.workspace,
      migrateSecrets: true,
      env,
    });

    const result = await applyMigrationPlan({ plan, yes: true, env });

    await expect(fs.readFile(path.join(fixture.workspace, "SOUL.md"), "utf-8")).resolves.toBe(
      "hermes soul\n",
    );
    await expect(fs.readFile(path.join(fixture.workspace, "MEMORY.md"), "utf-8")).resolves.toBe(
      "hermes memory\n",
    );
    await expect(
      fs.readFile(
        path.join(fixture.workspace, "skills", "hermes-imports", "demo-skill", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toContain("demo-skill");
    await expect(fs.readFile(path.join(fixture.state, ".env"), "utf-8")).resolves.toContain(
      "OPENAI_API_KEY=",
    );
    await expect(
      fs.readFile(path.join(fixture.state, "openclaw.json"), "utf-8"),
    ).resolves.toContain('"memory"');
    await expect(
      fs.readFile(path.join(result.reportDir, "plan.json"), "utf-8"),
    ).resolves.not.toContain("sk-test-openai");

    await expect(applyMigrationPlan({ plan, yes: true, env })).rejects.toThrow(
      "Import into existing setups is disabled",
    );
  });
});

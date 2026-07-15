import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { exportClawAgent } from "./export.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

async function installedFixture() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-export-"));
  await mkdir(join(root, "source", "reference"), { recursive: true });
  await writeFile(join(root, "source", "SOUL.md"), "managed soul\n", "utf8");
  await writeFile(join(root, "source", "reference", "policy.md"), "managed policy\n", "utf8");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker", tools: { deny: ["exec"] } },
    workspace: {
      bootstrapFiles: { "SOUL.md": { source: "source/SOUL.md" } },
      files: [{ source: "source/reference/policy.md", path: "reference/policy.md" }],
    },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.2.3",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrity: "sha256:manifest",
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
  let config: OpenClawConfig = {};
  await applyClawAddPlan(plan, {
    env: { OPENCLAW_STATE_DIR: join(root, "state") },
    commitConfig: async (transform) => {
      config = transform(config);
    },
  });
  persistClawPackageRef(
    plan,
    { kind: "skill", source: "clawhub", ref: "@acme/triage", version: "2.0.0" },
    { env: { OPENCLAW_STATE_DIR: join(root, "state") } },
  );
  return { root, plan, config, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
}

describe("exportClawAgent", () => {
  it("writes a grouped package from one installed agent", async () => {
    const fixture = await installedFixture();
    const out = join(fixture.root, "exported");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
    });

    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "worker",
      manifest: {
        schemaVersion: 1,
        agent: { id: "worker", name: "Worker", tools: { deny: ["exec"] } },
        workspace: {
          bootstrapFiles: { "SOUL.md": { source: "workspace/SOUL.md" } },
          files: [{ source: "workspace/reference/policy.md", path: "reference/policy.md" }],
        },
        packages: [{ kind: "skill", source: "clawhub", ref: "@acme/triage", version: "2.0.0" }],
        mcpServers: {},
        cronJobs: [],
      },
    });
    expect(JSON.parse(await readFile(join(out, "package.json"), "utf8"))).toMatchObject({
      name: "@acme/worker",
      version: "1.2.3",
      openclaw: { claw: "openclaw.claw.json" },
    });
    await expect(readFile(join(out, "workspace", "SOUL.md"), "utf8")).resolves.toBe(
      "managed soul\n",
    );
  });

  it("exports current content when a managed file was intentionally edited", async () => {
    const fixture = await installedFixture();
    await writeFile(join(fixture.plan.agent.workspace, "SOUL.md"), "operator revision\n", "utf8");
    const out = join(fixture.root, "exported-edited");

    await exportClawAgent("worker", out, { env: fixture.env, config: fixture.config });

    await expect(readFile(join(out, "workspace", "SOUL.md"), "utf8")).resolves.toBe(
      "operator revision\n",
    );
    await expect(readFile(join(out, "package.json"), "utf8")).resolves.toSatisfy((raw) => {
      const pkg = JSON.parse(raw);
      return (
        pkg.name === "openclaw-claw-worker" && /^0\.0\.0-export\.[0-9a-f]{12}$/.test(pkg.version)
      );
    });
  });

  it("packages a safe workspace-relative avatar as a sidecar", async () => {
    const fixture = await installedFixture();
    const avatarPath = join(fixture.plan.agent.workspace, "avatars", "worker.png");
    await mkdir(join(fixture.plan.agent.workspace, "avatars"), { recursive: true });
    await writeFile(avatarPath, "avatar bytes");
    fixture.config.agents!.list![0] = {
      ...fixture.config.agents!.list![0],
      identity: { avatar: "avatars/worker.png" },
    };
    const out = join(fixture.root, "exported-avatar");

    const result = await exportClawAgent("worker", out, {
      env: fixture.env,
      config: fixture.config,
    });

    expect(result.manifest.agent.identity?.avatar).toBe("avatars/worker.png");
    expect(result.manifest.workspace.files).toContainEqual({
      source: "workspace/avatars/worker.png",
      path: "avatars/worker.png",
    });
    await expect(readFile(join(out, "workspace", "avatars", "worker.png"), "utf8")).resolves.toBe(
      "avatar bytes",
    );
  });

  it("omits valid empty optional arrays", async () => {
    const fixture = await installedFixture();
    fixture.config.agents!.list![0] = {
      ...fixture.config.agents!.list![0],
      tools: { allow: [], deny: [] },
      groupChat: { mentionPatterns: [] },
    };

    const result = await exportClawAgent("worker", join(fixture.root, "exported-empty-arrays"), {
      env: fixture.env,
      config: fixture.config,
    });

    expect(result.manifest.agent.tools).toBeUndefined();
    expect(result.manifest.agent.groupChat).toBeUndefined();
  });

  it("expands a home-relative output directory", async () => {
    const fixture = await installedFixture();
    vi.stubEnv("HOME", fixture.root);

    const result = await exportClawAgent("worker", "~/exported-home", {
      env: fixture.env,
      config: fixture.config,
    });

    expect(result.outputDirectory).toBe(join(fixture.root, "exported-home"));
    await expect(
      readFile(join(result.outputDirectory, "openclaw.claw.json"), "utf8"),
    ).resolves.toContain('"schemaVersion": 1');
  });

  it("fails closed when a managed file is unavailable", async () => {
    const fixture = await installedFixture();
    await writeFile(join(fixture.plan.agent.workspace, "SOUL.md"), "still available\n", "utf8");
    await rm(join(fixture.plan.agent.workspace, "reference", "policy.md"));

    await expect(
      exportClawAgent("worker", join(fixture.root, "exported-missing"), {
        env: fixture.env,
        config: fixture.config,
      }),
    ).rejects.toMatchObject({ code: "workspace_files_unavailable" });
  });

  it("never writes into an existing output directory", async () => {
    const fixture = await installedFixture();
    const out = join(fixture.root, "existing");
    await mkdir(out);
    await writeFile(join(out, "operator.txt"), "keep\n", "utf8");

    await expect(
      exportClawAgent("worker", out, { env: fixture.env, config: fixture.config }),
    ).rejects.toMatchObject({ code: "output_collision" });
    await expect(readFile(join(out, "operator.txt"), "utf8")).resolves.toBe("keep\n");
  });
});

// E2E coverage for experimental grouped Claw inspection and add planning.
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runOpenClaw(
  args: string[],
  options?: { expectFailure?: boolean; stateDir?: string },
) {
  const stateDir = options?.stateDir ?? tempDirs.make("openclaw-claws-lifecycle-e2e-");
  const env = {
    ...process.env,
    HOME: stateDir,
    USERPROFILE: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_EXPERIMENTAL_CLAWS: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_TEST_RUNTIME_LOG: "1",
    VITEST: "",
  };
  try {
    const result = await execFileAsync(process.execPath, ["openclaw.mjs", ...args], {
      cwd: process.cwd(),
      env,
      maxBuffer: 1024 * 1024,
    });
    if (options?.expectFailure) {
      throw new Error(`expected command to fail: ${args.join(" ")}`);
    }
    return { ok: true as const, stdout: result.stdout, stderr: result.stderr, stateDir };
  } catch (error) {
    if (!options?.expectFailure) {
      const failed = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `${failed.message}\nstdout:\n${failed.stdout ?? ""}\nstderr:\n${failed.stderr ?? ""}`,
        { cause: error },
      );
    }
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false as const,
      code: failed.code,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      stateDir,
    };
  }
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed);
}

describe("claws lifecycle cli e2e", () => {
  const manifestPath = "src/claws/fixtures/incident-response.claw.json";

  it("migrates an existing agent in place and releases only Claw ownership on remove", async () => {
    const stateDir = tempDirs.make("openclaw-claws-migrate-e2e-");
    const workspace = join(stateDir, "workspace");
    const agentDir = join(stateDir, "agents", "main", "agent");
    const sessionsDir = join(stateDir, "agents", "main", "sessions");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(sessionsDir, { recursive: true }),
    ]);
    const originalFiles = new Map([
      [join(workspace, "AGENTS.md"), Buffer.from("# Existing instructions\n", "utf8")],
      [join(workspace, "SOUL.md"), Buffer.from("Keep the existing voice.\n", "utf8")],
      [join(workspace, "BOOTSTRAP.md"), Buffer.from("First-run state stays local.\n", "utf8")],
      [join(workspace, "unrelated.txt"), Buffer.from("Leave me unmanaged.\n", "utf8")],
      [join(agentDir, "auth-profiles.json"), Buffer.from('{"sentinel":"auth"}\n', "utf8")],
      [join(sessionsDir, "session.jsonl"), Buffer.from('{"sentinel":"transcript"}\n', "utf8")],
      [join(workspace, "memory.sqlite"), Buffer.from("existing database bytes\n", "utf8")],
    ]);
    for (const [path, content] of originalFiles) {
      await writeFile(path, content);
    }
    const configPath = join(stateDir, "openclaw.json");
    const config = {
      gateway: { mode: "local", controlUi: { enabled: false } },
      agents: {
        defaults: {
          model: { primary: "provider/default", fallbacks: ["provider/fallback"] },
          systemAgent: { agentId: "main" },
        },
        entries: { main: { name: "Existing agent", workspace } },
      },
    };
    const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await writeFile(configPath, configBytes);
    const beforeStats = new Map(
      await Promise.all(
        [...originalFiles.keys()].map(async (path) => [path, await stat(path)] as const),
      ),
    );

    const preview = await runOpenClaw(["claws", "migrate", "main", "--dry-run", "--json"], {
      stateDir,
    });
    const plan = parseJson(preview.stdout) as {
      planIntegrity: string;
      packageRoot: string;
      workspaceFiles: Array<{ path: string }>;
      openClawProfile?: { agent: { model?: { primary?: string; fallbacks?: string[] } } };
      retained: string[];
    };
    expect(plan).toMatchObject({
      schemaVersion: "openclaw.clawMigrationPlan.v1",
      mutationAllowed: false,
      agentId: "main",
      workspace,
      workspaceFiles: [
        { path: join(workspace, "AGENTS.md") },
        { path: join(workspace, "SOUL.md") },
      ],
      retained: expect.arrayContaining([
        "BOOTSTRAP.md (one-time workspace seed)",
        "credentials and auth state",
        "session indexes and transcripts",
        "agent databases and runtime state",
        "all other workspace files and directories",
      ]),
    });
    expect(plan.openClawProfile?.agent.model).toEqual({
      primary: "provider/default",
      fallbacks: ["provider/fallback"],
    });
    expect(plan.packageRoot).toBe(join(stateDir, "claws", "local", "main"));

    const migrated = await runOpenClaw(
      ["claws", "migrate", "main", "--yes", "--plan-integrity", plan.planIntegrity, "--json"],
      { stateDir },
    );
    expect(parseJson(migrated.stdout)).toMatchObject({
      schemaVersion: "openclaw.clawMigrationResult.v1",
      status: "complete",
      agentId: "main",
      workspace,
      packageRoot: plan.packageRoot,
    });
    expect(await readFile(configPath)).toEqual(configBytes);
    const status = await runOpenClaw(["claws", "status", "main", "--json"], { stateDir });
    expect(await readFile(configPath)).toEqual(configBytes);
    expect(parseJson(status.stdout)).toMatchObject({
      summary: { claws: 1, driftedFiles: 0 },
      records: [
        {
          install: { agentId: "main", agentOrigin: "adopted" },
          agentState: "present",
          workspaceFiles: [
            { path: "AGENTS.md", state: "unchanged" },
            { path: "SOUL.md", state: "unchanged" },
          ],
        },
      ],
    });
    const inspected = await runOpenClaw(["claws", "inspect", plan.packageRoot, "--json"], {
      stateDir,
    });
    expect(parseJson(inspected.stdout)).toMatchObject({
      valid: true,
      source: { kind: "package" },
      manifest: { agent: { id: "main", name: "Existing agent" } },
    });
    // Exercise updates after a package stops pinning an inherited value. The
    // live agent still gets this model from agents.defaults, so its effective
    // settings and adopted ownership digest remain stable.
    await rm(join(plan.packageRoot, "profiles", "openclaw.yml"));
    const statusAfterPackageMutation = await runOpenClaw(["claws", "status", "main", "--json"], {
      stateDir,
    });
    expect(parseJson(statusAfterPackageMutation.stdout)).toMatchObject({
      records: [{ install: { agentOrigin: "adopted" }, agentState: "present" }],
    });
    const update = await runOpenClaw(["claws", "update", "main", "--dry-run", "--json"], {
      stateDir,
    });
    const updatePlan = parseJson(update.stdout) as { planIntegrity: string };
    expect(updatePlan).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      blockers: [],
      actions: expect.arrayContaining([
        expect.objectContaining({ kind: "agent", action: "unchanged" }),
      ]),
    });
    const updated = await runOpenClaw(
      ["claws", "update", "main", "--yes", "--plan-integrity", updatePlan.planIntegrity, "--json"],
      { stateDir },
    );
    expect(parseJson(updated.stdout)).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "complete",
      agentId: "main",
    });
    const statusAfterUpdate = await runOpenClaw(["claws", "status", "main", "--json"], {
      stateDir,
    });
    expect(parseJson(statusAfterUpdate.stdout)).toMatchObject({
      records: [{ install: { agentOrigin: "adopted" }, agentState: "present" }],
    });

    const configWithoutAgent = {
      ...config,
      agents: { ...config.agents, entries: {} },
    };
    await writeFile(configPath, `${JSON.stringify(configWithoutAgent, null, 2)}\n`, "utf8");
    const statusBeforeRestore = await runOpenClaw(["claws", "status", "main", "--json"], {
      stateDir,
    });
    expect(parseJson(statusBeforeRestore.stdout)).toMatchObject({
      records: [{ install: { agentOrigin: "adopted" }, agentState: "missing" }],
    });
    const restorePreview = await runOpenClaw(["claws", "update", "main", "--dry-run", "--json"], {
      stateDir,
    });
    const restorePlan = parseJson(restorePreview.stdout) as {
      planIntegrity: string;
      actions: Array<{ kind: string; action: string }>;
    };
    expect(restorePlan.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "agent", action: "change" })]),
    );
    const restored = await runOpenClaw(
      ["claws", "update", "main", "--yes", "--plan-integrity", restorePlan.planIntegrity, "--json"],
      { stateDir },
    );
    expect(parseJson(restored.stdout)).toMatchObject({ status: "complete", agentId: "main" });
    const statusAfterRestore = await runOpenClaw(["claws", "status", "main", "--json"], {
      stateDir,
    });
    expect(parseJson(statusAfterRestore.stdout)).toMatchObject({
      records: [{ install: { agentOrigin: "adopted" }, agentState: "present" }],
    });
    const configBytesAfterRestore = await readFile(configPath);

    const removePreview = await runOpenClaw(["claws", "remove", "main", "--dry-run", "--json"], {
      stateDir,
    });
    const removePlan = parseJson(removePreview.stdout) as {
      planIntegrity: string;
      actions: unknown[];
    };
    expect(removePlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", action: "retain" }),
        expect.objectContaining({ kind: "workspace", action: "retain", target: workspace }),
        expect.objectContaining({ kind: "sessionTranscripts", action: "retain" }),
        expect.objectContaining({ kind: "installRecord", action: "release" }),
      ]),
    );
    const removed = await runOpenClaw(
      ["claws", "remove", "main", "--yes", "--plan-integrity", removePlan.planIntegrity, "--json"],
      { stateDir },
    );
    expect(parseJson(removed.stdout)).toMatchObject({
      status: "complete",
      agentId: "main",
      agentRemoved: false,
    });
    expect(await readFile(configPath)).toEqual(configBytesAfterRestore);
    for (const [path, content] of originalFiles) {
      expect(await readFile(path)).toEqual(content);
      const after = await stat(path);
      expect(after.ino).toBe(beforeStats.get(path)?.ino);
      expect(after.mtimeMs).toBe(beforeStats.get(path)?.mtimeMs);
    }
    const afterStatus = await runOpenClaw(["claws", "status", "main", "--json"], {
      expectFailure: true,
      stateDir,
    });
    expect(afterStatus.code).toBe(1);
    expect(parseJson(afterStatus.stdout)).toMatchObject({ summary: { claws: 0 } });
  });

  it("inspects a grouped development manifest", async () => {
    const inspect = parseJson(
      (await runOpenClaw(["claws", "inspect", manifestPath, "--json"])).stdout,
    );

    expect(inspect).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: {
        schemaVersion: 1,
        agent: { id: "incident-response" },
        packages: expect.any(Array),
      },
      openClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: { allow: ["read", "write", "web_fetch"], deny: ["exec", "browser"] },
          heartbeat: { every: "30m", isolatedSession: true, timeoutSeconds: 120 },
        },
      },
    });
  });

  it("reports and removes a Claw-created agent through plan-first lifecycle commands", async () => {
    const instance = await createOpenClawTestInstance({
      name: "claws-lifecycle-remove",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_EXPERIMENTAL_CLAWS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        const run = async (args: string[]) => {
          const result = await instance.cli(args);
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
          return result;
        };
        const addPreview = await run([
          "claws",
          "add",
          "src/claws/fixtures/workspace-agent.claw.json",
          "--dry-run",
          "--json",
        ]);
        const addPlan = parseJson(addPreview.stdout) as { planIntegrity: string };
        await run([
          "claws",
          "add",
          "src/claws/fixtures/workspace-agent.claw.json",
          "--yes",
          "--plan-integrity",
          addPlan.planIntegrity,
          "--json",
        ]);
        const status = await run(["claws", "status", "workspace-agent", "--json"]);
        expect(parseJson(status.stdout)).toMatchObject({
          schemaVersion: "openclaw.clawStatus.v1",
          summary: { claws: 1, driftedFiles: 0 },
          records: [{ install: { agentId: "workspace-agent" }, agentState: "present" }],
        });

        const preview = await run(["claws", "remove", "workspace-agent", "--dry-run", "--json"]);
        const removePlan = parseJson(preview.stdout) as { planIntegrity: string };
        expect(removePlan).toMatchObject({
          schemaVersion: "openclaw.clawRemovePlan.v1",
          mutationAllowed: false,
          agentId: "workspace-agent",
          blockers: [],
        });

        const removed = await run([
          "claws",
          "remove",
          "workspace-agent",
          "--yes",
          "--plan-integrity",
          removePlan.planIntegrity,
          "--json",
        ]);
        expect(parseJson(removed.stdout)).toMatchObject({
          schemaVersion: "openclaw.clawRemoveResult.v1",
          status: "complete",
          agentId: "workspace-agent",
          agentRemoved: true,
        });
        const config = JSON.parse(await readFile(instance.configPath, "utf8"));
        const canonicalStateDir = await realpath(instance.stateDir);
        expect(config.agents).toEqual({
          defaults: {
            systemAgent: { agentId: "main" },
          },
          entries: { main: { workspace: join(canonicalStateDir, "workspace") } },
        });
      },
      () => instance.cleanup(),
    );
  });

  it("exports an installed agent as a self-contained grouped package", async () => {
    const instance = await createOpenClawTestInstance({
      name: "claws-lifecycle-export",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_EXPERIMENTAL_CLAWS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        const run = async (args: string[]) => {
          const result = await instance.cli(args);
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
          return result;
        };
        const source = "src/claws/fixtures/workspace-agent.claw.json";
        const addPreview = await run(["claws", "add", source, "--dry-run", "--json"]);
        const addPlan = parseJson(addPreview.stdout) as { planIntegrity: string };
        await run([
          "claws",
          "add",
          source,
          "--yes",
          "--plan-integrity",
          addPlan.planIntegrity,
          "--json",
        ]);
        const outputDirectory = join(instance.stateDir, "exported-claw");
        const exported = await run([
          "claws",
          "export",
          "workspace-agent",
          "--out",
          outputDirectory,
          "--json",
        ]);
        expect(parseJson(exported.stdout)).toMatchObject({
          schemaVersion: "openclaw.clawExportResult.v1",
          stability: "experimental",
          agentId: "workspace-agent",
          outputDirectory,
          manifest: {
            schemaVersion: 1,
            agent: { id: "workspace-agent" },
            workspace: {
              bootstrapFiles: {
                "HEARTBEAT.md": { source: "workspace/HEARTBEAT.md" },
              },
              files: [
                {
                  source: "workspace/reference/policy.md",
                  path: "reference/policy.md",
                },
              ],
            },
          },
        });
        expect(
          JSON.parse(await readFile(join(outputDirectory, "package.json"), "utf8")),
        ).toMatchObject({
          name: "openclaw-claw-workspace-agent",
          version: expect.stringMatching(/^0\.0\.0-export\.[0-9a-f]{64}$/),
          type: "module",
        });
        await expect(readFile(join(outputDirectory, "CLAW.md"), "utf8")).resolves.toContain(
          "Incident Response",
        );
        const inspected = await run(["claws", "inspect", outputDirectory, "--json"]);
        expect(parseJson(inspected.stdout)).toMatchObject({
          valid: true,
          source: { kind: "package" },
          manifest: { agent: { id: "workspace-agent" } },
        });
        const roundTripArgs = ["claws", "add", outputDirectory, "--agent-id", "workspace-copy"];
        const roundTripPreview = await run([...roundTripArgs, "--dry-run", "--json"]);
        const roundTripPlan = parseJson(roundTripPreview.stdout) as { planIntegrity: string };
        const roundTrip = await run([
          ...roundTripArgs,
          "--yes",
          "--plan-integrity",
          roundTripPlan.planIntegrity,
          "--json",
        ]);
        expect(parseJson(roundTrip.stdout)).toMatchObject({
          status: "complete",
          claw: { kind: "package" },
          agent: { finalId: "workspace-copy" },
          workspaceFiles: [
            expect.objectContaining({ path: "SOUL.md" }),
            expect.objectContaining({ path: "reference/policy.md" }),
          ],
        });
      },
      () => instance.cleanup(),
    );
  });
});

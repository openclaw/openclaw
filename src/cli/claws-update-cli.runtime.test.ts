import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyClawAddPlan } from "../claws/add.js";
import { ClawHubSourceError, type ClawHubClawTrust } from "../claws/clawhub-source.js";
import { planClawUpdateForGateway } from "../claws/gateway-lifecycle-plan.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import { readClawInstallRecord } from "../claws/provenance.js";
import { readClawManifestFile } from "../claws/reader.js";
import type { ClawReadResult } from "../claws/types.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { runClawsUpdateCommand } from "./claws-update-cli.runtime.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  readInventory: vi.fn(),
}));

vi.mock("../claws/clawhub-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claws/clawhub-source.js")>()),
  withResolvedClawHubSource: mocks.resolve,
}));
vi.mock("../claws/inventory-read.js", () => ({ readClawInventory: mocks.readInventory }));
vi.mock("../state/openclaw-state-lease.js", () => ({
  withOpenClawStateLease: async (
    _options: unknown,
    run: (lease: { assertOwned: () => void }) => Promise<unknown>,
  ) => await run({ assertOwned: () => undefined }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearConfigCache();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

type LoadedClaw = Extract<ClawReadResult, { ok: true }>;

async function readVerifiedSource(root: string, integrity: string): Promise<LoadedClaw> {
  const loaded = await readClawManifestFile(root);
  if (!loaded.ok) {
    throw new Error(JSON.stringify(loaded.diagnostics));
  }
  return {
    ...loaded,
    source: { ...loaded.source, integrityKind: "artifact", integrity, byteLength: 321 },
  };
}

describe("default Claw CLI update after ClawHub Add", () => {
  it("keeps an artifact install eligible for Gateway Update", async () => {
    const stateDir = tempDirs.make("openclaw-clawhub-cli-update-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const configPath = join(stateDir, "openclaw.json");
    const digest = "a".repeat(64);
    const integrity = `sha256:${digest}`;
    const packageName = "@openclaw/worker";
    const version = "1.0.0";
    const cacheRoot = join(stateDir, "claws", "sources", digest);
    const extractedRoot = join(stateDir, "extracted");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    await mkdir(cacheRoot, { recursive: true });
    await writeFile(
      join(cacheRoot, "package.json"),
      JSON.stringify({ name: packageName, version, openclaw: { claw: "openclaw.claw.json" } }),
    );
    await writeFile(
      join(cacheRoot, "openclaw.claw.json"),
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "worker", name: "Worker" },
        workspace: { bootstrapFiles: {}, files: [] },
        packages: [],
        mcpServers: {},
        cronJobs: [],
      }),
    );
    await cp(cacheRoot, extractedRoot, { recursive: true });
    const installedSource = await readVerifiedSource(cacheRoot, integrity);
    const extractedSource = await readVerifiedSource(extractedRoot, integrity);
    let config: OpenClawConfig = {};
    const addPlan = await buildClawAddPlan({
      manifest: installedSource.manifest,
      source: installedSource.source,
      context: { config, workspace: join(stateDir, "workspace-worker") },
    });
    expect(addPlan.blockers).toEqual([]);
    const added = await applyClawAddPlan(addPlan, {
      env,
      consentPlanIntegrity: addPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(added.status).toBe("complete");
    await writeFile(configPath, JSON.stringify(config));
    clearConfigCache();

    const trust: ClawHubClawTrust = {
      riskAcknowledgementRequired: false,
      trustRecord: {
        clawhubTrustDisposition: "clean",
        clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
      },
    };
    let verifiedSource = extractedSource;
    mocks.resolve.mockImplementation(
      async (input: {
        mode: "preview" | "apply";
        acknowledgeClawHubRisk?: boolean;
        run: (
          source: LoadedClaw,
          trust: ClawHubClawTrust,
          persistSource: () => Promise<LoadedClaw>,
        ) => Promise<unknown>;
      }) => {
        if (
          input.mode === "apply" &&
          trust.riskAcknowledgementRequired &&
          !input.acknowledgeClawHubRisk
        ) {
          throw new ClawHubSourceError(
            "clawhub_risk_acknowledgement_required",
            "Explicit acknowledgement is required for this ClawHub release.",
          );
        }
        return {
          value: await input.run(verifiedSource, trust, async () => installedSource),
          ...trust,
        };
      },
    );
    mocks.readInventory.mockImplementation(async () => {
      const install = readClawInstallRecord("worker", { env });
      if (!install) {
        throw new Error("missing Claw install");
      }
      return {
        installs: [install],
        packages: [],
        workspaceFiles: [],
        mcpServers: [],
        cronJobs: [],
      };
    });

    const output: unknown[] = [];
    const runtime: OutputRuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code) => {
        throw new Error(`Claw CLI exited ${code}: ${JSON.stringify(output.at(-1))}`);
      },
      writeStdout: vi.fn(),
      writeJson: (value) => output.push(value),
    };
    await runClawsUpdateCommand("worker", { dryRun: true, json: true }, runtime);
    const preview = output.pop() as { planIntegrity: string; targetClaw: { integrity: string } };
    expect(mocks.resolve).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ coordinate: { packageName, version }, mode: "preview" }),
    );
    await runClawsUpdateCommand(
      "worker",
      { yes: true, planIntegrity: preview.planIntegrity, json: true },
      runtime,
    );
    expect(output.pop()).toMatchObject({ status: "complete" });
    expect(mocks.resolve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ coordinate: { packageName, version }, mode: "apply" }),
    );
    expect(readClawInstallRecord("worker", { env })?.claw).toMatchObject({
      integrityKind: "artifact",
      integrity,
    });
    await expect(
      planClawUpdateForGateway({
        agentId: "worker",
        source: { packageName, version },
        config,
      }),
    ).resolves.toMatchObject({ operation: "update", blockers: [] });

    const beforeMismatch = readClawInstallRecord("worker", { env });
    verifiedSource = {
      ...extractedSource,
      source: { ...extractedSource.source, integrity: `sha256:${"b".repeat(64)}` },
    };
    await expect(
      runClawsUpdateCommand(
        "worker",
        { yes: true, planIntegrity: preview.planIntegrity, json: true },
        runtime,
      ),
    ).rejects.toThrow("Claw CLI exited 1");
    expect(output.pop()).toMatchObject({
      diagnostics: [{ code: "clawhub_recorded_artifact_mismatch" }],
    });
    expect(readClawInstallRecord("worker", { env })).toEqual(beforeMismatch);

    const resolverCalls = mocks.resolve.mock.calls.length;
    await runClawsUpdateCommand(
      "worker",
      { from: extractedRoot, dryRun: true, json: true },
      runtime,
    );
    const localPreview = output.pop() as { targetClaw: { integrity: string } };
    const localSource = await readClawManifestFile(extractedRoot);
    expect(localSource.ok).toBe(true);
    if (!localSource.ok) {
      throw new Error("Expected a local Claw source");
    }
    expect(localSource.source.integrityKind).toBe("development-snapshot");
    expect(localPreview.targetClaw.integrity).toBe(localSource.source.integrity);
    expect(mocks.resolve).toHaveBeenCalledTimes(resolverCalls);

    verifiedSource = extractedSource;
    trust.riskAcknowledgementRequired = true;
    trust.trustWarning = "Review required for this ClawHub release.";
    await runClawsUpdateCommand("worker", { dryRun: true, json: true }, runtime);
    const riskPreview = output.pop() as {
      planIntegrity: string;
      diagnostics: Array<{ code: string }>;
    };
    expect(riskPreview.diagnostics).toContainEqual(
      expect.objectContaining({ code: "clawhub_trust_warning" }),
    );
    const beforeRisk = readClawInstallRecord("worker", { env });
    await expect(
      runClawsUpdateCommand(
        "worker",
        { yes: true, planIntegrity: riskPreview.planIntegrity, json: true },
        runtime,
      ),
    ).rejects.toThrow("Claw CLI exited 1");
    expect(output.pop()).toMatchObject({
      diagnostics: [{ code: "clawhub_risk_acknowledgement_required" }],
    });
    expect(readClawInstallRecord("worker", { env })).toEqual(beforeRisk);
    await runClawsUpdateCommand(
      "worker",
      {
        yes: true,
        planIntegrity: riskPreview.planIntegrity,
        acknowledgeClawHubRisk: true,
        json: true,
      },
      runtime,
    );
    expect(output.pop()).toMatchObject({ status: "complete" });
    expect(mocks.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "apply", acknowledgeClawHubRisk: true }),
    );
    expect(readClawInstallRecord("worker", { env })?.claw).toMatchObject({
      integrityKind: "artifact",
      integrity,
    });

    const beforeCorrupt = readClawInstallRecord("worker", { env });
    await writeFile(join(cacheRoot, "untrusted.txt"), "changed");
    await expect(
      runClawsUpdateCommand(
        "worker",
        {
          yes: true,
          planIntegrity: riskPreview.planIntegrity,
          acknowledgeClawHubRisk: true,
          json: true,
        },
        runtime,
      ),
    ).rejects.toThrow("Claw CLI exited 1");
    expect(output.pop()).toMatchObject({
      diagnostics: [{ code: "clawhub_cached_source_mismatch" }],
    });
    expect(readClawInstallRecord("worker", { env })).toEqual(beforeCorrupt);
  });
});

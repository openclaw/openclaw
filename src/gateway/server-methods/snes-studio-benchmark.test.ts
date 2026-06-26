import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSnesStudioBenchmarkHandlers,
  loadSnesToolchainStatusSnapshot,
  loadSnesGlm52StatusSnapshot,
  loadSnesBenchmarkLatestSnapshot,
  loadSnesMasteryStatusSnapshot,
} from "./snes-studio-benchmark.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-snes-benchmark-rpc-"));
  tempDirs.push(dir);
  return dir;
}

describe("SNES Studio benchmark Gateway method", () => {
  it("loads the latest real output benchmark report and summary", async () => {
    const artifactDir = await makeTempDir();
    await writeFile(
      path.join(artifactDir, "latest.json"),
      JSON.stringify({
        currentDefaultsByRole: { "snes-hardware-qa": "ollama/openclaw-control-qwen25-32b:latest" },
        downloadsAttempted: false,
        generatedAt: "2026-06-22T01:02:03.000Z",
        hostedGlmUsed: false,
        hostedProvidersUsed: false,
        modelSummaries: [{ role: "snes-hardware-qa", modelRef: "local-glm-5.2-2bit" }],
        promotionApplied: false,
        recommendedWinnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
        rounds: 3,
        status: "partial",
        winnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
      }),
    );
    await writeFile(path.join(artifactDir, "latest-summary.md"), "# summary\n");

    const snapshot = await loadSnesBenchmarkLatestSnapshot({ artifactDir });

    expect(snapshot).toMatchObject({
      available: true,
      downloadsAttempted: false,
      hostedGlmUsed: false,
      hostedProvidersUsed: false,
      rounds: 3,
      status: "partial",
    });
    expect(snapshot.recommendedWinnersByRole["snes-hardware-qa"]).toBe("local-glm-5.2-2bit");
    expect(snapshot.summaryMarkdown).toBe("# summary\n");
  });

  it("returns a non-error missing snapshot when no report exists", async () => {
    const artifactDir = await makeTempDir();
    const snapshot = await loadSnesBenchmarkLatestSnapshot({ artifactDir });

    expect(snapshot.available).toBe(false);
    expect(snapshot.status).toBe("missing");
    expect(snapshot.blocker).toContain("No real output benchmark report found");
  });

  it("responds through the Gateway handler", async () => {
    const handler = createSnesStudioBenchmarkHandlers({
      loadSnapshot: async () => ({
        available: true,
        blocker: null,
        currentDefaultsByRole: {},
        downloadsAttempted: false,
        generatedAt: "2026-06-22T01:02:03.000Z",
        hostedGlmUsed: false,
        hostedProvidersUsed: false,
        modelSummaries: [],
        promotionApplied: false,
        recommendedWinnersByRole: {},
        reportPath: ".artifacts/snes-real-output-model-benchmark/latest.json",
        rounds: 1,
        status: "ready",
        summaryMarkdown: null,
        summaryPath: ".artifacts/snes-real-output-model-benchmark/latest-summary.md",
        winnersByRole: {},
      }),
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.benchmark.latest"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "1", method: "snes.benchmark.latest", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ok: true, payload: { status: "ready" } });
  });

  it("reports local GLM status from runtime proof, benchmark proof, and config", async () => {
    const runtimeDir = await makeTempDir();
    const proofDir = await makeTempDir();
    const benchmarkDir = await makeTempDir();
    await writeFile(
      path.join(runtimeDir, "latest.json"),
      JSON.stringify({
        diagnostic: {
          decodeReady: true,
          modelId: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
          status: "ready",
        },
        generatedAt: "2026-06-22T01:02:03.000Z",
      }),
    );
    await writeFile(
      path.join(proofDir, "latest.json"),
      JSON.stringify({
        ok: true,
        proof: { score: 100 },
      }),
    );
    await writeFile(
      path.join(benchmarkDir, "latest.json"),
      JSON.stringify({
        recommendedWinnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
        winnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
      }),
    );

    const snapshot = await loadSnesGlm52StatusSnapshot({
      agentProofArtifactDir: proofDir,
      benchmarkArtifactDir: benchmarkDir,
      runtimeArtifactDir: runtimeDir,
      config: {
        agents: {
          list: [
            {
              id: "snes-hardware-qa",
              model: {
                primary: "local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
              },
            },
          ],
        },
        models: {
          providers: {
            "local-glm52": {},
          },
        },
      },
    });

    expect(snapshot).toMatchObject({
      agentProofReady: true,
      available: true,
      benchmarkRecommendsHardwareQa: true,
      blocker: null,
      hardwareQaPromoted: true,
      providerConfigured: true,
      runtimeReady: true,
      runtimeStatus: "ready",
    });
  });

  it("returns GLM status through the Gateway handler", async () => {
    const handler = createSnesStudioBenchmarkHandlers({
      loadGlm52Status: async () => ({
        agentProofReady: true,
        agentProofReportPath: ".artifacts/glm52-agent-proof/latest.json",
        agentProofScore: 100,
        available: true,
        benchmarkRecommendsHardwareQa: true,
        blocker: null,
        generatedAt: "2026-06-22T01:02:03.000Z",
        hardwareQaModel: "local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
        hardwareQaPromoted: true,
        modelRef: "local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
        providerConfigured: true,
        providerId: "local-glm52",
        runtimeReady: true,
        runtimeReportPath: ".artifacts/glm52-local-runtime/latest.json",
        runtimeStatus: "ready",
      }),
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.glm52.status"]?.({
      client: null,
      context: { getRuntimeConfig: () => ({}) } as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "1", method: "snes.glm52.status", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ok: true, payload: { available: true } });
  });

  it("returns read-only SNES toolchain status through the Gateway handler", async () => {
    const handler = createSnesStudioBenchmarkHandlers({
      loadToolchainStatus: async () => ({
        blockers: ["PVSnesLib is required for production SNES builds."],
        fxpakVolume: { detail: "No FXPAK volume.", status: "missing" },
        generatedAt: "2026-06-23T01:02:03.000Z",
        liveProbe: true,
        manifestPath: "/tmp/toolchain-manifest.json",
        receiptSummary: { conversion: { status: "pass" } },
        toolchainHome: "/tmp/snes-toolchain",
        status: "blocked",
        tools: [
          {
            detail: "not detected",
            id: "pvsneslib",
            installHint: "install pvsneslib",
            label: "PVSnesLib",
            requiredForProduction: true,
            status: "missing",
          },
        ],
      }),
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.toolchain.status"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "1", method: "snes.toolchain.status", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ok: true, payload: { liveProbe: true, status: "blocked" } });
  });

  it("loads generic SNES Mastery status from receipts", async () => {
    const artifactRoot = await makeTempDir();
    const manifests = path.join(artifactRoot, "manifests");
    const mastery = path.join(artifactRoot, "mastery");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(manifests, { recursive: true });
    await mkdir(mastery, { recursive: true });
    await writeFile(
      path.join(manifests, "snes-mastery-status-receipt.json"),
      JSON.stringify({
        blockers: [{ id: "G9", title: "Kata 013", percentComplete: 0 }],
        generatedAt: "2026-06-26T01:02:03.000Z",
        kataSummary: { passed: 14, total: 15, percentComplete: 93.3 },
        milestoneSummary: { pass: 13, total: 17 },
        nextIncomplete: { id: "G9", title: "Kata 013" },
        nextKata: { id: "kata-013-emulator-screenshot-regression" },
        status: "blocked",
      }),
    );
    await writeFile(path.join(manifests, "validation-receipt.json"), JSON.stringify({ ok: true }));
    await writeFile(
      path.join(manifests, "generic-scope-guard-receipt.json"),
      JSON.stringify({ status: "pass" }),
    );

    const snapshot = await loadSnesMasteryStatusSnapshot({ artifactRoot });

    expect(snapshot).toMatchObject({
      available: true,
      genericScope: { status: "pass" },
      kataSummary: { passed: 14, total: 15 },
      legalCorpus: { ok: true, status: "pass" },
      status: "blocked",
    });
  });

  it("creates blank SNES project packages through the Gateway handler", async () => {
    const handler = createSnesStudioBenchmarkHandlers({
      createBlankProject: async (params) => {
        expect(params).toMatchObject({ projectId: "blank-snes-platformer" });
        return {
          generatedAt: "2026-06-26T01:02:03.000Z",
          hostedGlmUsed: false,
          localOnly: true,
          packageHash: "abc123",
          packagePath: ".artifacts/snes-projects/blank-snes-platformer/project.json",
          projectId: "blank-snes-platformer",
          projectName: "Blank SNES Platformer",
          projectSpecific: false,
          proofClaim: "project-package-created-only",
          removableMediaWritePerformed: false,
          status: "pass",
        };
      },
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.project.createBlank"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: { projectId: "blank-snes-platformer" },
      req: { id: "1", method: "snes.project.createBlank", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: {
        packagePath: ".artifacts/snes-projects/blank-snes-platformer/project.json",
        proofClaim: "project-package-created-only",
        removableMediaWritePerformed: false,
        status: "pass",
      },
    });
  });

  it("runs generic SNES proof actions through the Gateway handler", async () => {
    const handler = createSnesStudioBenchmarkHandlers({
      runGenericProofAction: async (params) => ({
        actionId:
          params && typeof params === "object" && "actionId" in params
            ? (params.actionId as never)
            : "mastery-refresh",
        blocker: null,
        blockers: [],
        command:
          "node .artifacts/snes-game-builder-reference/scripts/snes-mastery-harness.mjs refresh --json",
        generatedAt: "2026-06-26T01:02:03.000Z",
        hostedGlmUsed: false,
        localOnly: true,
        projectSpecific: false,
        removableMediaWritePerformed: false,
        status: "pass",
        summary: { status: "pass" },
      }),
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.proof.run"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: { actionId: "budget-enforcement" },
      req: { id: "1", method: "snes.proof.run", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: {
        actionId: "budget-enforcement",
        hostedGlmUsed: false,
        removableMediaWritePerformed: false,
        status: "pass",
      },
    });
  });

  it("returns generic SNES Mastery status through the Gateway handler", async () => {
    const handler = createSnesStudioBenchmarkHandlers({
      loadMasteryStatus: async () => ({
        available: true,
        blocker: "One or more SNES Mastery milestones are blocked.",
        blockers: [{ id: "G9", title: "Kata 013", percentComplete: 0 }],
        generatedAt: "2026-06-26T01:02:03.000Z",
        genericScope: { path: ".artifacts/scope.json", status: "pass" },
        gpt55Used: false,
        hostedGlmUsed: false,
        kataSummary: { passed: 14, total: 15, percentComplete: 93.3 },
        ledgerPath: ".artifacts/ledger.json",
        legalCorpus: { ok: true, path: ".artifacts/validation.json", status: "pass" },
        milestoneSummary: { pass: 13, total: 17 },
        nextIncomplete: { id: "G9", title: "Kata 013" },
        nextKata: { id: "kata-013-emulator-screenshot-regression" },
        projectSpecific: false,
        roadmapPath: ".artifacts/roadmap.json",
        status: "blocked",
        statusPath: ".artifacts/status.json",
      }),
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.mastery.status"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "1", method: "snes.mastery.status", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { kataSummary: { passed: 14, total: 15 }, status: "blocked" },
    });
  });

  it("probes the current host toolchain without throwing when tools are missing", async () => {
    const snapshot = await loadSnesToolchainStatusSnapshot();

    expect(snapshot.liveProbe).toBe(true);
    expect(snapshot.manifestPath).toContain("toolchain-manifest.json");
    expect(snapshot.toolchainHome).toContain("snes-toolchain");
    expect(snapshot.tools.map((tool) => tool.id)).toEqual(
      expect.arrayContaining(["pvsneslib", "superfamiconv", "pixelorama", "ldtk", "mesen"]),
    );
    expect(snapshot.fxpakVolume.detail.length).toBeGreaterThan(0);
  });

  it("returns generic SNES production status and one-milestone execution", async () => {
    const runCalls: unknown[] = [];
    const handler = createSnesStudioBenchmarkHandlers({
      runGenericProduction: async (params, mode) => {
        runCalls.push({ mode, params });
        return {
          adapterPlan: { status: "blocked" },
          blocker: null,
          completedCount: mode === "continue" ? 1 : 0,
          control: { paused: false },
          currentMilestone: { id: "GEN01", name: "Project package" },
          emulatorPlan: { status: "blocked" },
          fxpakPlan: { status: "ready" },
          gpt55Used: false,
          latestReceipt: null,
          localGlmOnly: true,
          nextMilestone: { id: "GEN01", name: "Project package" },
          packet: { gpt55Used: false, localGlmOnly: true },
          paths: { statePath: ".artifacts/snes-projects/comet-fox-mvp/production/state.json" },
          projectProof: { status: "blocked" },
          projectId: "comet-fox-mvp",
          projectName: "Comet Fox MVP",
          projectPackage: {} as never,
          romScaffold: { status: "blocked" },
          state: { currentMilestoneId: "GEN02" } as never,
          status: mode === "continue" ? "pass" : "ready",
          toolchain: { status: "blocked", tools: [], blockers: [], fxpakVolume: {} } as never,
          totalCount: 6,
          workerMode: "deterministic-contract-proof",
        };
      },
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];
    const invoke = async (method: string, params: Record<string, unknown> = {}) => {
      await handler[method]?.({
        client: null,
        context: {} as never,
        isWebchatConnect: () => false,
        params,
        req: { id: method, method, params, type: "req" },
        respond: (ok, payload) => calls.push({ ok, payload }),
      });
    };

    await invoke("snes.production.status", { projectId: "comet-fox-mvp" });
    await invoke("snes.production.continue", { projectId: "comet-fox-mvp" });

    expect(runCalls).toEqual([
      { mode: "status", params: { projectId: "comet-fox-mvp" } },
      { mode: "continue", params: { projectId: "comet-fox-mvp" } },
    ]);
    expect(calls[0]).toMatchObject({ ok: true, payload: { gpt55Used: false, status: "ready" } });
    expect(calls[1]).toMatchObject({ ok: true, payload: { completedCount: 1, status: "pass" } });
  });

  it("runs SNES visual project actions through Gateway handlers", async () => {
    const runCalls: unknown[] = [];
    const handler = createSnesStudioBenchmarkHandlers({
      runToolchainProjectAction: async (params, mode) => {
        runCalls.push({ mode, params });
        return {
          artifacts: {
            receiptPath: `.artifacts/snes-projects/comet-fox-mvp/toolchain/${mode}/receipt.json`,
          },
          hostedGlmUsed: false,
          localOnly: true,
          projectId: "comet-fox-mvp",
          status: "pass",
        };
      },
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];
    const invoke = async (method: string, params: Record<string, unknown> = {}) => {
      await handler[method]?.({
        client: null,
        context: { getRuntimeConfig: () => ({}) } as never,
        isWebchatConnect: () => false,
        params,
        req: { id: method, method, params, type: "req" },
        respond: (ok, payload) => calls.push({ ok, payload }),
      });
    };

    await invoke("snes.visual.reject", { humanScore: 3, projectId: "stanskis-world" });
    await invoke("snes.visual.artBible", { projectId: "stanskis-world" });
    await invoke("snes.visual.artSourcePack", { projectId: "stanskis-world" });
    await invoke("snes.visual.compileArt", { projectId: "comet-fox-mvp" });
    await invoke("snes.visual.captureProof", { projectId: "comet-fox-mvp" });
    await invoke("snes.visual.runtimeAssetTruth", { projectId: "comet-fox-mvp" });
    await invoke("snes.visual.qualityAudit", { projectId: "comet-fox-mvp" });
    await invoke("snes.visual.approve", { humanScore: 100, projectId: "comet-fox-mvp" });

    expect(runCalls).toEqual([
      { mode: "visual-reject", params: { humanScore: 3, projectId: "stanskis-world" } },
      { mode: "project-art-bible", params: { projectId: "stanskis-world" } },
      { mode: "project-art-source-pack", params: { projectId: "stanskis-world" } },
      { mode: "project-art-compile", params: { projectId: "comet-fox-mvp" } },
      { mode: "project-visual-proof", params: { projectId: "comet-fox-mvp" } },
      { mode: "project-runtime-asset-truth", params: { projectId: "comet-fox-mvp" } },
      { mode: "project-visual-quality-audit", params: { projectId: "comet-fox-mvp" } },
      { mode: "project-visual-approval", params: { humanScore: 100, projectId: "comet-fox-mvp" } },
    ]);
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.ok)).toBe(true);
    expect(calls[0].payload).toMatchObject({ hostedGlmUsed: false, status: "pass" });
  });

  it("persists generic SNES production artifacts with the default runner", async () => {
    const artifactRoot = await makeTempDir();
    const previousRoot = process.env.OPENCLAW_SNES_PROJECTS_ARTIFACT_DIR;
    process.env.OPENCLAW_SNES_PROJECTS_ARTIFACT_DIR = artifactRoot;
    try {
      const handler = createSnesStudioBenchmarkHandlers();
      const calls: Array<{ ok: boolean; payload?: unknown }> = [];
      const invoke = async (method: string, params: Record<string, unknown> = {}) => {
        await handler[method]?.({
          client: null,
          context: { getRuntimeConfig: () => ({}) } as never,
          isWebchatConnect: () => false,
          params,
          req: { id: method, method, params, type: "req" },
          respond: (ok, payload) => calls.push({ ok, payload }),
        });
      };

      await invoke("snes.production.status", { projectId: "comet-fox-mvp" });
      await invoke("snes.production.continue", { projectId: "comet-fox-mvp" });

      const statePath = path.join(artifactRoot, "comet-fox-mvp", "production", "state.json");
      const projectPath = path.join(artifactRoot, "comet-fox-mvp", "project.json");
      const summaryPath = path.join(
        artifactRoot,
        "comet-fox-mvp",
        "production",
        "latest-summary.md",
      );
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        completedMilestones?: string[];
        projectId?: string;
      };
      const projectPackage = JSON.parse(await readFile(projectPath, "utf8")) as {
        format?: string;
        source?: string;
      };
      const summary = await readFile(summaryPath, "utf8");

      expect(calls[0]).toMatchObject({
        ok: true,
        payload: { projectId: "comet-fox-mvp", workerMode: "deterministic-contract-proof" },
      });
      expect(calls[1]).toMatchObject({ ok: true, payload: { completedCount: 1 } });
      expect(state.projectId).toBe("comet-fox-mvp");
      expect(state.completedMilestones).toContain("GEN01");
      expect(projectPackage.format).toBe("openclaw-snes-project-package");
      expect(projectPackage.source).toBe("sample-mvp");
      expect(summary).toContain("Routine GPT 5.5 used: no");
    } finally {
      if (previousRoot === undefined) {
        delete process.env.OPENCLAW_SNES_PROJECTS_ARTIFACT_DIR;
      } else {
        process.env.OPENCLAW_SNES_PROJECTS_ARTIFACT_DIR = previousRoot;
      }
    }
  });

  it("returns Stanski production status through the Gateway handler", async () => {
    const runCalls: unknown[] = [];
    const handler = createSnesStudioBenchmarkHandlers({
      runStanskiProduction: async (args) => {
        runCalls.push(args);
        return {
          completedCount: 2,
          nextMilestone: { id: "G03", name: "Todd production sprite sheet" },
          status: "ready",
          totalCount: 40,
        };
      },
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.stanski.production.status"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "1", method: "snes.stanski.production.status", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(runCalls).toEqual([{ mode: "status", runSmoke: false }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { completedCount: 2, status: "ready", totalCount: 40 },
    });
  });

  it("runs exactly one Stanski production milestone by default", async () => {
    const runCalls: unknown[] = [];
    const handler = createSnesStudioBenchmarkHandlers({
      runStanskiProduction: async (args) => {
        runCalls.push(args);
        return {
          completedCount: 3,
          results: [{ milestoneId: "G03", status: "pass" }],
          status: "pass",
          totalCount: 40,
        };
      },
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.stanski.production.continue"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "1", method: "snes.stanski.production.continue", params: {}, type: "req" },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(runCalls).toEqual([{ maxMilestones: 1, mode: "continue", runSmoke: true }]);
    expect(calls[0]).toMatchObject({ ok: true, payload: { completedCount: 3, status: "pass" } });
  });

  it("caps dashboard Stanski production requests at forty milestones and supports retry", async () => {
    const runCalls: unknown[] = [];
    const handler = createSnesStudioBenchmarkHandlers({
      runStanskiProduction: async (args) => {
        runCalls.push(args);
        return { completedCount: 4, status: "pass", totalCount: 40 };
      },
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await handler["snes.stanski.production.retryBlocked"]?.({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: { maxMilestones: 999, runSmoke: false },
      req: {
        id: "1",
        method: "snes.stanski.production.retryBlocked",
        params: { maxMilestones: 999, runSmoke: false },
        type: "req",
      },
      respond: (ok, payload) => calls.push({ ok, payload }),
    });

    expect(runCalls).toEqual([{ maxMilestones: 40, mode: "retry-blocked", runSmoke: false }]);
    expect(calls[0]).toMatchObject({ ok: true, payload: { status: "pass" } });
  });

  it("supports bounded auto, split, and control Stanski production actions", async () => {
    const runCalls: unknown[] = [];
    const handler = createSnesStudioBenchmarkHandlers({
      runStanskiProduction: async (args) => {
        runCalls.push(args);
        return { completedCount: 6, status: "ready", totalCount: 45 };
      },
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];
    const invoke = async (method: string, params: Record<string, unknown> = {}) => {
      await handler[method]?.({
        client: null,
        context: {} as never,
        isWebchatConnect: () => false,
        params,
        req: { id: method, method, params, type: "req" },
        respond: (ok, payload) => calls.push({ ok, payload }),
      });
    };

    await invoke("snes.stanski.production.splitNext");
    await invoke("snes.stanski.production.auto", { maxRuntimeMinutes: 999, maxMilestones: 999 });
    await invoke("snes.stanski.production.pause");
    await invoke("snes.stanski.production.resume");
    await invoke("snes.stanski.production.cancel");

    expect(runCalls).toEqual([
      { mode: "split-next", runSmoke: false },
      {
        maxMilestones: 40,
        maxRuntimeMinutes: 30,
        mode: "auto",
        runSmoke: true,
        until: "blocked",
      },
      { mode: "pause", runSmoke: false },
      { mode: "resume", runSmoke: false },
      { mode: "cancel", runSmoke: false },
    ]);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.ok)).toBe(true);
  });
});

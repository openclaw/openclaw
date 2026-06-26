import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STANSKI_PROMPT_CHAR_BUDGET,
  createGlmMilestonePrompt,
  createMilestonePacket,
  fetchWithAbortTimeout,
  initializeProductionFiles,
  loadProductionSnapshot,
  parseStrictGlmJson,
  productionPaths,
  resolveMaxOutputTokensForMilestone,
  resolveTimeoutSecondsForMilestone,
  runStanskiProduction,
  selectNextMilestone,
  validateGlmMilestonePatch,
  validateProductionRendererImpact,
} from "../../scripts/lib/stanski-production-loop.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProductionDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "stanski-production-loop-"));
  tempDirs.push(dir);
  return dir;
}

function okFetchPatch(patch: unknown) {
  return async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(patch) } }],
      model: "GLM",
    }),
    text: async () => "",
  });
}

const readyProbe = () => ({ decodeReady: true, status: "ready", blocker: null });
const fixedNow = () => new Date("2026-06-22T00:00:00.000Z");

function setCompletedThroughG06(artifactDir: string) {
  const snapshot = initializeProductionFiles({ artifactDir }, { now: fixedNow });
  writeFileSync(
    snapshot.paths.state,
    `${JSON.stringify(
      {
        ...snapshot.state,
        completedMilestones: ["G01", "G02", "G03", "G04", "G05", "G06"],
        currentMilestoneId: "G07",
      },
      null,
      2,
    )}\n`,
  );
}

function validG07aPatch() {
  return {
    milestoneId: "G07a",
    localGlmOnly: true,
    hostedGlmUsed: false,
    patchType: "assetPackPatch",
    summary: "Adds concrete sidewalk road and pothole tile specs.",
    assetPackPatch: {
      assetId: "g07a-sidewalk-road-pothole-v1",
      states: ["sidewalk", "road", "pothole", "curb"],
      frames: Array.from({ length: 10 }, (_, index) => ({
        id: `g07a-tile-${index}`,
        state: index % 2 === 0 ? "sidewalk" : "road",
        durationMs: 100,
        notes: "16x16 tile with collision usage for solid street/platform/decorative placement",
      })),
      palette: ["#101820", "#394457", "#7b8794", "#d9c7a3"],
      identityTraits: ["Cleveland cracked sidewalk", "readable pothole silhouette"],
      animationNotes: ["collision usage: solid curb, decorative crack, hazard pothole"],
    },
    qaHypothesis: ["Screenshots should show non-generic street tile variation."],
  };
}

function writeRendererProof(
  rootDir: string,
  manifestCounts = { appliedPatches: 1, assetPacks: 0 },
) {
  writeFileSync(
    path.join(rootDir, "index.html"),
    `<html><title>Stanski's World - GLM Production Visual test</title><script>const productionManifestSummary=${JSON.stringify(manifestCounts)}; const toddProductionSpriteDataUrl='data:image/png;base64,test'; function render(){ctx.drawImage(sprite,0,0)}</script></html>`,
  );
  writeFileSync(
    path.join(rootDir, "playable-proof.json"),
    JSON.stringify({
      title: "Stanski's World - GLM Production Visual test",
      buildLabel: "Visual sprite renderer test",
      productionManifestSummary: manifestCounts,
      mediaStatus: { titleAsset: { status: "pass" } },
    }),
  );
  writeFileSync(
    path.join(rootDir, "stanskis-world.revised.oc-snes-bundle.json"),
    JSON.stringify({
      productionManifestSummary: manifestCounts,
      mediaStatus: { titleAsset: { status: "pass" } },
    }),
  );
}

describe("Stanski GLM production loop", () => {
  it("initializes durable state and selects the next milestone outside GLM", () => {
    const artifactDir = tempProductionDir();
    const snapshot = initializeProductionFiles({ artifactDir }, { now: fixedNow });

    expect(snapshot.state.currentMilestoneId).toBe("G01");
    expect(snapshot.state.currentHumanVisualGrade).toBe(24);
    expect(snapshot.state.targetHumanVisualGrade).toBe(100);
    expect(snapshot.state.gpt55UsagePolicy.useGpt55ForRoutineMilestone).toBe(false);
    expect(snapshot.backlog.milestones).toHaveLength(40);
    expect(selectNextMilestone(snapshot.backlog, snapshot.state)?.id).toBe("G01");
  });

  it("writes and reports the local-only production policy", async () => {
    const artifactDir = tempProductionDir();
    const report = await runStanskiProduction(
      { artifactDir, mode: "status", runSmoke: false },
      { now: fixedNow },
    );

    expect(report.policySummary).toMatchObject({
      hostedGlmAllowed: false,
      localGlmOnly: true,
      routineGpt55Allowed: false,
      targetHumanVisualGrade: 100,
    });
    expect(report.paths.policy).toContain("production-policy.json");
  });

  it("splits oversized G07 before asking GLM for a huge patch", async () => {
    const artifactDir = tempProductionDir();
    setCompletedThroughG06(artifactDir);

    const split = await runStanskiProduction(
      { artifactDir, mode: "split-next", runSmoke: false },
      { now: fixedNow },
    );
    const status = await runStanskiProduction(
      { artifactDir, mode: "status", runSmoke: false },
      { now: fixedNow },
    );

    expect(split.split).toMatchObject({
      status: "split",
      childIds: ["G07a", "G07b", "G07c", "G07d", "G07e"],
    });
    expect(status.completedCount).toBe(6);
    expect(status.nextMilestone).toMatchObject({ id: "G07a" });
    expect(
      loadProductionSnapshot({ artifactDir }).backlog.milestones.map(
        (item: { id: string }) => item.id,
      ),
    ).toContain("G07e");
  });

  it("builds compact milestone packets instead of sending the full transcript", () => {
    const artifactDir = tempProductionDir();
    const snapshot = initializeProductionFiles({ artifactDir }, { now: fixedNow });
    const milestone = selectNextMilestone(snapshot.backlog, snapshot.state)!;
    const packet = createMilestonePacket({
      backlog: snapshot.backlog,
      memoryCards: {
        cards: Array.from({ length: 30 }, (_, index) => ({
          milestoneId: `X${index}`,
          status: "pass",
          summary: "done",
          lockedDecisions: ["a", "b"],
        })),
      },
      milestone,
      options: { artifactDir, promptCharBudget: STANSKI_PROMPT_CHAR_BUDGET },
      state: snapshot.state,
    });
    const prompt = createGlmMilestonePrompt(packet);

    expect(prompt.length).toBeLessThanOrEqual(STANSKI_PROMPT_CHAR_BUDGET);
    expect(prompt).toContain("Complete milestone G01 only");
    expect(prompt).toContain("allowedPatchSchema");
    expect(prompt).not.toContain("rollout-");
  });

  it("uses larger local GLM output budgets for asset-heavy milestones", () => {
    expect(
      resolveMaxOutputTokensForMilestone({}, { id: "G03", patchSchema: "assetPackPatch" }),
    ).toBeGreaterThanOrEqual(3_600);
    expect(
      resolveMaxOutputTokensForMilestone({}, { id: "G01", patchSchema: "qaRubricPatch" }),
    ).toBe(900);
    expect(
      resolveTimeoutSecondsForMilestone({}, { id: "G03", patchSchema: "assetPackPatch" }),
    ).toBe(600);
    expect(
      resolveMaxOutputTokensForMilestone(
        { maxOutputTokens: 1_234 },
        { id: "G03", patchSchema: "assetPackPatch" },
      ),
    ).toBe(1_234);
  });

  it("rejects markdown, hosted GLM flags, wrong milestones, and raw code", () => {
    const artifactDir = tempProductionDir();
    const snapshot = initializeProductionFiles({ artifactDir }, { now: fixedNow });
    const milestone = selectNextMilestone(snapshot.backlog, snapshot.state)!;

    expect(() => parseStrictGlmJson('```json\n{"ok":true}\n```')).toThrow("markdown");
    expect(() => validateGlmMilestonePatch({ milestoneId: "G99" }, milestone)).toThrow(
      "milestoneId",
    );
    expect(() =>
      validateGlmMilestonePatch(
        {
          milestoneId: "G01",
          localGlmOnly: true,
          hostedGlmUsed: true,
          patchType: "qaRubricPatch",
          summary: "bad",
          qaRubricPatch: { rules: ["x"], acceptance: ["y"] },
          qaHypothesis: ["z"],
        },
        milestone,
      ),
    ).toThrow("hostedGlmUsed");
    expect(() =>
      validateGlmMilestonePatch(
        {
          milestoneId: "G01",
          localGlmOnly: true,
          hostedGlmUsed: false,
          patchType: "qaRubricPatch",
          summary: "bad",
          qaRubricPatch: { rules: ["<script>alert(1)</script>"], acceptance: ["y"] },
          qaHypothesis: ["z"],
        },
        milestone,
      ),
    ).toThrow("raw HTML or JavaScript");
  });

  it("requires useful G07 child asset patches instead of shape-only JSON", async () => {
    const artifactDir = tempProductionDir();
    setCompletedThroughG06(artifactDir);
    await runStanskiProduction({ artifactDir, mode: "split-next" }, { now: fixedNow });
    const milestone = selectNextMilestone(
      loadProductionSnapshot({ artifactDir }).backlog,
      loadProductionSnapshot({ artifactDir }).state,
    )!;

    const valid = validG07aPatch();
    expect(() =>
      validateGlmMilestonePatch(
        { ...valid, assetPackPatch: { ...valid.assetPackPatch, frames: [] } },
        milestone,
      ),
    ).toThrow("frames");
    expect(() =>
      validateGlmMilestonePatch(
        { ...valid, assetPackPatch: { ...valid.assetPackPatch, palette: ["#000"] } },
        milestone,
      ),
    ).toThrow("palette");
    expect(() =>
      validateGlmMilestonePatch(
        {
          ...valid,
          assetPackPatch: {
            ...valid.assetPackPatch,
            frames: [
              ...valid.assetPackPatch.frames,
              { id: "bad", state: "road", durationMs: 100, notes: "copied Mario sprite" },
            ],
          },
        },
        milestone,
      ),
    ).toThrow("copied-asset");
    expect(() =>
      validateGlmMilestonePatch(
        {
          ...valid,
          qaHypothesis: [
            "Original Cleveland tiles; do not copy from Nintendo, Sega, Mario, Sonic, or Mortal Kombat.",
          ],
        },
        milestone,
      ),
    ).not.toThrow();
    expect(validateGlmMilestonePatch(valid, milestone)).toBe(valid);
  });

  it("runs one milestone, writes memory cards, and never invokes GPT 5.5 on the happy path", async () => {
    const artifactDir = tempProductionDir();
    const patch = {
      milestoneId: "G01",
      localGlmOnly: true,
      hostedGlmUsed: false,
      patchType: "qaRubricPatch",
      summary: "Production art bible rules for original Cleveland 16-bit art.",
      qaRubricPatch: {
        targetScore: 100,
        humanApprovalRequired: true,
        rules: ["human grade overrides synthetic score", "no copied assets"],
        acceptance: ["screenshots pass human review"],
      },
      qaHypothesis: ["Future screenshots should be judged by human visual grade."],
    };

    const report = await runStanskiProduction(
      { artifactDir, mode: "continue", maxMilestones: 1, runSmoke: false },
      { fetchFn: okFetchPatch(patch), now: fixedNow, probeFn: readyProbe },
    );
    const snapshot = loadProductionSnapshot({ artifactDir });

    expect(report.status).toBe("ready");
    expect(report.completedCount).toBe(1);
    expect(snapshot.state.completedMilestones).toEqual(["G01"]);
    expect(snapshot.state.currentMilestoneId).toBe("G02");
    expect(snapshot.state.gpt55UsagePolicy.useGpt55ForRoutineMilestone).toBe(false);
    expect(snapshot.memoryCards.cards[0]).toMatchObject({ milestoneId: "G01", status: "pass" });
    expect(snapshot.appliedManifest.qaRubricPatches[0]).toMatchObject({
      milestoneId: "G01",
      targetScore: 100,
    });
  });

  it("retries GLM once with a smaller prompt when strict validation fails", async () => {
    const artifactDir = tempProductionDir();
    const good = {
      milestoneId: "G01",
      localGlmOnly: true,
      hostedGlmUsed: false,
      patchType: "qaRubricPatch",
      summary: "Retry succeeds.",
      qaRubricPatch: {
        targetScore: 100,
        humanApprovalRequired: true,
        rules: ["r"],
        acceptance: ["a"],
      },
      qaHypothesis: ["q"],
    };
    let calls = 0;
    const report = await runStanskiProduction(
      { artifactDir, mode: "continue", maxMilestones: 1, runSmoke: false },
      {
        fetchFn: async () => {
          calls += 1;
          return {
            ok: true,
            json: async () => ({
              choices: [
                { message: { content: calls === 1 ? "```json\n{}\n```" : JSON.stringify(good) } },
              ],
            }),
            text: async () => "",
          };
        },
        now: fixedNow,
        probeFn: readyProbe,
      },
    );

    expect(calls).toBe(2);
    expect(report.completedCount).toBe(1);
  });

  it("records a blocker instead of crashing when both GLM attempts are invalid", async () => {
    const artifactDir = tempProductionDir();
    let calls = 0;
    const report = await runStanskiProduction(
      { artifactDir, mode: "continue", maxMilestones: 1, runSmoke: false },
      {
        fetchFn: async () => {
          calls += 1;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: calls === 1 ? "not json" : "still not json" } }],
            }),
            text: async () => "",
          };
        },
        now: fixedNow,
        probeFn: readyProbe,
      },
    );
    const snapshot = loadProductionSnapshot({ artifactDir });

    expect(calls).toBe(2);
    expect(report.status).toBe("blocked");
    expect(snapshot.state.blockedMilestone).toMatchObject({
      id: "G01",
      reason: expect.stringContaining("strict validation after retry"),
    });
    expect(selectNextMilestone(snapshot.backlog, snapshot.state)).toBeNull();
  });

  it("tries one local GLM repair patch when executable QA fails", async () => {
    const artifactDir = tempProductionDir();
    const rootDir = tempProductionDir();
    const patch = {
      milestoneId: "G01",
      localGlmOnly: true,
      hostedGlmUsed: false,
      patchType: "qaRubricPatch",
      summary: "QA repairable art bible.",
      qaRubricPatch: {
        targetScore: 100,
        humanApprovalRequired: true,
        rules: ["r"],
        acceptance: ["a"],
      },
      qaHypothesis: ["q"],
    };
    let fetchCalls = 0;
    let spawnCalls = 0;
    const report = await runStanskiProduction(
      { artifactDir, mode: "continue", maxMilestones: 1, rootDir },
      {
        fetchFn: async () => {
          fetchCalls += 1;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify(patch) } }],
            }),
            text: async () => "",
          };
        },
        now: fixedNow,
        probeFn: readyProbe,
        spawnSyncFn: (_command: string, args: string[]) => {
          spawnCalls += 1;
          if (args.some((arg) => arg.includes("build-revised-playable.mjs"))) {
            const manifest = loadProductionSnapshot({ artifactDir }).appliedManifest;
            writeRendererProof(rootDir, {
              appliedPatches: manifest.appliedPatches.length,
              assetPacks: Object.keys(manifest.assetPacks ?? {}).length,
            });
            return { status: 0, stdout: "", stderr: "" };
          }
          if (spawnCalls === 2) {
            return { status: 1, stdout: "smoke failed", stderr: "" };
          }
          const outIndex = args.indexOf("--out");
          if (outIndex >= 0) {
            writeFileSync(
              args[outIndex + 1],
              JSON.stringify({
                status: "pass",
                checks: [{ code: "snes-image-asset-present", pass: true }],
                proof: {
                  quality: { score: 72 },
                  media: { titleAsset: { status: "pass" } },
                },
              }),
            );
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(fetchCalls).toBe(2);
    expect(report.status).toBe("ready");
    expect(report.completedCount).toBe(1);
    expect(loadProductionSnapshot({ artifactDir }).state.completedMilestones).toEqual(["G01"]);
  });

  it("fails renderer impact when a completed production run only writes milestone specs", () => {
    const artifactDir = tempProductionDir();
    const rootDir = tempProductionDir();
    const snapshot = initializeProductionFiles({ artifactDir, rootDir }, { now: fixedNow });
    const allIds = snapshot.backlog.milestones.map((milestone: { id: string }) => milestone.id);
    writeFileSync(
      snapshot.paths.state,
      `${JSON.stringify(
        {
          ...snapshot.state,
          completedMilestones: allIds,
          currentMilestoneId: null,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      snapshot.paths.appliedManifest,
      `${JSON.stringify(
        {
          version: 1,
          assetPacks: { todd: { assetId: "todd", frames: [] } },
          levelPatches: [],
          mechanicPatches: [],
          qaRubricPatches: [],
          releasePatches: [],
          appliedPatches: allIds.map((id: string) => ({
            milestoneId: id,
            patchType: "assetPackPatch",
          })),
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      path.join(rootDir, "index.html"),
      "<html><title>Old Stanski build</title><script>function draw(){ctx.fillRect(0,0,1,1)}</script></html>",
    );

    const integrity = validateProductionRendererImpact({
      options: { artifactDir, rootDir },
      receipt: { status: "pass", checks: [] },
    });

    expect(integrity.status).toBe("fail");
    expect(integrity.failures.join("\n")).toContain("productionManifestSummary");
    expect(integrity.failures.join("\n")).toContain("drawImage");
    expect(integrity.failures.join("\n")).toContain("snes-image-asset-present");
  });

  it("reports completed production as blocked when the playable renderer is stale", async () => {
    const artifactDir = tempProductionDir();
    const rootDir = tempProductionDir();
    const snapshot = initializeProductionFiles({ artifactDir, rootDir }, { now: fixedNow });
    const allIds = snapshot.backlog.milestones.map((milestone: { id: string }) => milestone.id);
    writeFileSync(
      snapshot.paths.state,
      `${JSON.stringify(
        {
          ...snapshot.state,
          completedMilestones: allIds,
          currentMilestoneId: null,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      snapshot.paths.appliedManifest,
      `${JSON.stringify(
        {
          version: 1,
          assetPacks: { todd: { assetId: "todd", frames: [] } },
          appliedPatches: allIds.map((id: string) => ({
            milestoneId: id,
            patchType: "assetPackPatch",
          })),
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(rootDir, "index.html"), "<html>stale</html>");

    const report = await runStanskiProduction(
      { artifactDir, mode: "status", rootDir, runSmoke: false },
      { now: fixedNow },
    );

    expect(report.status).toBe("blocked");
    expect(report.blocker).toContain("production renderer impact failed");
    expect(report.rendererImpact.status).toBe("fail");
  });

  it("auto mode splits G07 and runs one child milestone without GPT 5.5", async () => {
    const artifactDir = tempProductionDir();
    setCompletedThroughG06(artifactDir);

    const report = await runStanskiProduction(
      {
        artifactDir,
        maxMilestones: 1,
        maxRuntimeMinutes: 1,
        mode: "auto",
        runSmoke: false,
      },
      { fetchFn: okFetchPatch(validG07aPatch()), now: fixedNow, probeFn: readyProbe },
    );
    const snapshot = loadProductionSnapshot({ artifactDir });

    expect(report.status).toBe("ready");
    expect(report.results?.[0]).toMatchObject({ split: true });
    expect(snapshot.state.completedMilestones).toContain("G07a");
    expect(snapshot.state.gpt55UsagePolicy.useGpt55ForRoutineMilestone).toBe(false);
  });

  it("refuses a second auto run while a live lock is active", async () => {
    const artifactDir = tempProductionDir();
    const paths = productionPaths({ artifactDir });
    initializeProductionFiles({ artifactDir }, { now: fixedNow });
    writeFileSync(
      paths.workerLock,
      `${JSON.stringify({
        version: 1,
        pid: 12345,
        mode: "auto",
        startedAt: "2026-06-22T00:00:00.000Z",
        heartbeatAt: new Date().toISOString(),
      })}\n`,
    );

    const report = await runStanskiProduction(
      { artifactDir, maxRuntimeMinutes: 1, mode: "auto", runSmoke: false },
      { isProcessAlive: (pid: number) => pid === 12345, now: fixedNow, probeFn: readyProbe },
    );

    expect(report.status).toBe("blocked");
    expect(report.blocker).toContain("already running");
  });

  it("supports pause, resume, and cancel control commands", async () => {
    const artifactDir = tempProductionDir();

    const paused = await runStanskiProduction(
      { artifactDir, mode: "pause", runSmoke: false },
      { now: fixedNow },
    );
    expect(paused.status).toBe("paused");
    expect(loadProductionSnapshot({ artifactDir }).control.paused).toBe(true);

    const resumed = await runStanskiProduction(
      { artifactDir, mode: "resume", runSmoke: false },
      { now: fixedNow },
    );
    expect(resumed.status).toBe("ready");
    expect(loadProductionSnapshot({ artifactDir }).control.paused).toBe(false);

    const cancelled = await runStanskiProduction(
      { artifactDir, mode: "cancel", runSmoke: false },
      { now: fixedNow },
    );
    expect(cancelled.status).toBe("cancelled");
    expect(loadProductionSnapshot({ artifactDir }).control.cancelRequested).toBe(true);
  });

  it("blocks without selecting a new milestone when GLM decode is unavailable", async () => {
    const artifactDir = tempProductionDir();
    const report = await runStanskiProduction(
      { artifactDir, mode: "continue", maxMilestones: 1, runSmoke: false },
      { now: fixedNow, probeFn: () => ({ decodeReady: false, blocker: "offline" }) },
    );
    const snapshot = loadProductionSnapshot({ artifactDir });

    expect(report.status).toBe("blocked");
    expect(snapshot.state.blockedMilestone).toMatchObject({ id: "G01", reason: "offline" });
    expect(selectNextMilestone(snapshot.backlog, snapshot.state)).toBeNull();
  });

  it("restarts local GLM with the production profile when context is too small", async () => {
    const artifactDir = tempProductionDir();
    const good = {
      milestoneId: "G01",
      localGlmOnly: true,
      hostedGlmUsed: false,
      patchType: "qaRubricPatch",
      summary: "Retry after 8k context restart succeeds.",
      qaRubricPatch: {
        targetScore: 100,
        humanApprovalRequired: true,
        rules: ["human visual approval required"],
        acceptance: ["screenshots reviewed"],
      },
      qaHypothesis: ["The retry should fit after local 8k restart."],
    };
    let fetchCalls = 0;
    let restartCalls = 0;

    const report = await runStanskiProduction(
      {
        allowLocalGlmRestart: true,
        artifactDir,
        maxMilestones: 1,
        mode: "continue",
        runSmoke: false,
      },
      {
        fetchFn: async () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            return {
              ok: false,
              status: 400,
              json: async () => ({}),
              text: async () =>
                '{"error":{"message":"request exceeds the available context size","type":"exceed_context_size_error","n_ctx":512}}',
            };
          }
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify(good) } }],
              model: "GLM",
            }),
            text: async () => "",
          };
        },
        now: fixedNow,
        probeFn: readyProbe,
        spawnSyncFn: (command: string, args: string[]) => {
          if (command === "pnpm" && args.includes("glm52:runtime")) {
            restartCalls += 1;
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(report.status).toBe("ready");
    expect(fetchCalls).toBe(2);
    expect(restartCalls).toBe(1);
    expect(loadProductionSnapshot({ artifactDir }).state.completedMilestones).toEqual(["G01"]);
  });

  it("finish mode runs until the backlog is complete with local restart enabled", async () => {
    const artifactDir = tempProductionDir();
    const snapshot = initializeProductionFiles({ artifactDir }, { now: fixedNow });
    const allButLast = snapshot.backlog.milestones
      .map((milestone: { id: string }) => milestone.id)
      .filter((id: string) => id !== "F20");
    writeFileSync(
      snapshot.paths.state,
      `${JSON.stringify(
        {
          ...snapshot.state,
          completedMilestones: allButLast,
          currentMilestoneId: "F20",
        },
        null,
        2,
      )}\n`,
    );
    const patch = {
      milestoneId: "F20",
      localGlmOnly: true,
      hostedGlmUsed: false,
      patchType: "releasePatch",
      summary: "Package the final playable proof.",
      releasePatch: {
        checklist: ["local QA pass", "remote route proof", "versioned build"],
        playerFacingNotes: ["Final Stanski proof package ready for review."],
        publishGates: ["human visual approval", "Tailscale route proof"],
      },
      qaHypothesis: ["Finish mode should complete the last milestone."],
    };

    const report = await runStanskiProduction(
      { artifactDir, mode: "finish", runSmoke: false },
      { fetchFn: okFetchPatch(patch), now: fixedNow, probeFn: readyProbe },
    );

    expect(report.status).toBe("complete");
    expect(report.completedCount).toBe(40);
    expect(loadProductionSnapshot({ artifactDir }).state.completedMilestones).toContain("F20");
  });

  it("aborts stuck local GLM fetches instead of leaving the worker alive indefinitely", async () => {
    let aborted = false;
    await expect(
      fetchWithAbortTimeout(
        async (_url: string, request: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
        "http://127.0.0.1:28080/v1/chat/completions",
        {},
        1,
        "local GLM test request",
      ),
    ).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
  });
});

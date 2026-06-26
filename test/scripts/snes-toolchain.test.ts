import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  conversionSmoke,
  fxpakCopy,
  fxpakDryRun,
  fxpakTransferPackage,
  projectBrowserPlaytest,
  projectArtBible,
  projectArtCompile,
  projectArtManifest,
  projectArtSourcePack,
  projectAudioCompile,
  projectConversion,
  projectEngineRom,
  projectRom,
  projectVisualReviewPack,
  projectVisualApproval,
  projectVisualProof,
  projectVisualQualityAudit,
  projectRuntimeAssetTruth,
  projectVisualReject,
  reconcileProductionState,
  probeToolchain,
  runMode,
  writeReceipt,
} from "../../scripts/lib/snes-toolchain.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-snes-toolchain-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFixturePng(filePath: string) {
  const { default: sharp } = await import("sharp");
  const width = 160;
  const height = 120;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const leftPerson = x > 20 && x < 72 && y > 18 && y < 104;
      const rightPerson = x > 86 && x < 138 && y > 26 && y < 108;
      raw[offset] = leftPerson ? 40 + y : rightPerson ? 170 + Math.floor(y / 4) : 210;
      raw[offset + 1] = leftPerson ? 48 + Math.floor(x / 4) : rightPerson ? 70 : 190;
      raw[offset + 2] = leftPerson ? 62 : rightPerson ? 58 : 150;
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
  return { height, width };
}

function sha256Text(buffer: Buffer | string) {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("SNES toolchain runner", () => {
  it("probes the host without requiring tools to be installed", async () => {
    const artifactDir = await tempDir();
    const report = probeToolchain({ artifactDir });

    expect(report.host.arch.length).toBeGreaterThan(0);
    expect(report.manifestPath).toContain("toolchain-manifest.json");
    expect(report.tools.map((tool) => tool.id)).toEqual(
      expect.arrayContaining(["pvsneslib", "superfamiconv", "pixelorama", "ldtk"]),
    );
  });

  it("writes receipt artifacts with latest pointers", async () => {
    const artifactDir = await tempDir();
    const report = runMode("probe", { artifactDir });

    expect(report.artifacts.receiptPath).toContain("receipt.json");
    const latest = JSON.parse(await readFile(report.artifacts.latestPath, "utf8"));
    expect(latest.manifestPath).toContain("toolchain-manifest.json");
  });

  it("blocks conversion smoke cleanly when SuperFamiconv is unavailable", async () => {
    const artifactDir = await tempDir();
    const report = conversionSmoke({ artifactDir });

    expect(["blocked", "pass"]).toContain(report.status);
    expect(report.input.sha256).toMatch(/^[a-f0-9]{64}$/u);
    if (report.status === "blocked") {
      expect(report.blockers[0]).toContain("SuperFamiconv");
    }
  });

  it("creates real per-project conversion receipts without claiming visual approval", async () => {
    const projectsRoot = await tempDir();
    const report = projectConversion({ projectId: "comet-fox-mvp", projectsRoot });

    expect(["blocked", "pass"]).toContain(report.status);
    expect(report.project.id).toBe("comet-fox-mvp");
    expect(report.visualApprovalClaimed).toBe(false);
    if (report.status === "pass") {
      expect(report.conversions.length).toBeGreaterThanOrEqual(5);
      expect(report.assetRecords.map((record) => record.type)).toEqual(
        expect.arrayContaining([
          "character-sprite",
          "enemy-sprite",
          "item-sprite",
          "tileset",
          "background-layer",
        ]),
      );
      expect(
        report.assetRecords.every((record) => record.visualMaturity === "procedural-placeholder"),
      ).toBe(true);
      expect(report.assetRecords.every((record) => record.screenshotProof.length === 0)).toBe(true);
      expect(report.assetRecords.every((record) => record.visualProof.length === 1)).toBe(true);
      expect(
        report.assetRecords.every((record) => record.visualProof[0].path.includes("visual-review")),
      ).toBe(true);
      expect(report.assetManifestHash).toMatch(/^[a-f0-9]{64}$/u);
    } else {
      expect(report.blockers.length).toBeGreaterThan(0);
    }
  });

  it("converts a preserved photo reference into a SNES-safe memory-card background layer", async () => {
    const artifactRoot = path.join(process.cwd(), ".artifacts", "snes-image-assets");
    const assetId = `test-man-boy-photo-${Date.now()}`;
    const assetRoot = path.join(artifactRoot, assetId);
    tempDirs.push(assetRoot);
    const sourceDir = await tempDir();
    const sourcePath = path.join(sourceDir, "source.png");
    const dimensions = await writeFixturePng(sourcePath);
    const sourceBytes = await readFile(sourcePath);
    const preserve = spawnSync(
      process.execPath,
      [
        ".agents/skills/snes-16bit-image-assets/scripts/preserve-image-input.mjs",
        "--source",
        sourcePath,
        "--asset-id",
        assetId,
        "--asset-type",
        "backgroundLayer",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(preserve.status).toBe(0);
    const sourceReceipt = JSON.parse(
      await readFile(path.join(assetRoot, "source-image.json"), "utf8"),
    );
    expect(sourceReceipt.source.sha256).toBe(sha256Text(sourceBytes));
    expect(sourceReceipt.source.width).toBe(dimensions.width);
    expect(sourceReceipt.source.height).toBe(dimensions.height);

    const convert = spawnSync(
      process.execPath,
      [
        ".agents/skills/snes-16bit-image-assets/scripts/build-16bit-asset.mjs",
        "--asset-id",
        assetId,
        "--asset-type",
        "backgroundLayer",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(convert.status).toBe(0);
    const receipt = JSON.parse(await readFile(path.join(assetRoot, "asset-receipt.json"), "utf8"));
    expect(receipt).toMatchObject({
      assetId,
      assetType: "backgroundLayer",
      productionApproved: false,
      status: "pass",
      visualMaturity: "draft-generated",
    });
    expect(receipt.output).toMatchObject({ height: 64, mimeType: "image/png", width: 96 });
    expect(receipt.output.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.palette).toHaveLength(16);
    expect(receipt.tileUsage).toMatchObject({ estimatedTiles: 96, tileSize: 8 });
    expect(receipt.intendedUse).toContain("Family Memory Card secret room cameo");
    expect(receipt.reviewArtifacts[0].path).toContain("review-sheet");
    expect(
      receipt.qa.checks.some((check: { code: string }) => check.code === "production-approval"),
    ).toBe(true);
  });

  it("creates the Stanski's World project package, references, backlog, and World 1 data", async () => {
    const projectsRoot = await tempDir();
    const report = projectConversion({ projectId: "stanskis-world", projectsRoot });
    const projectDir = path.join(projectsRoot, "stanskis-world");
    const projectPackage = JSON.parse(
      await readFile(path.join(projectDir, "project.json"), "utf8"),
    );
    const backlog = JSON.parse(
      await readFile(path.join(projectDir, "production", "backlog.json"), "utf8"),
    );
    const state = JSON.parse(
      await readFile(path.join(projectDir, "production", "state.json"), "utf8"),
    );
    const canon = projectPackage.manifest.project.stanskiCanon;

    expect(report.project.id).toBe("stanskis-world");
    expect(projectPackage.projectName).toBe("Stanski's World");
    expect(projectPackage.source).toBe("stanski-production");
    expect(projectPackage.sampleSpecific).toBe(false);
    expect(canon.targetPlatform).toBe("original-snes-via-fxpak-pro");
    expect(canon.fxpakWrites).toBe("blocked-until-exact-mounted-volume");
    expect(canon.worldOneVerticalSlice.map((level: { title: string }) => level.title)).toEqual([
      "Cleveland: Skyline Scramble",
      "Detroit: Motor City Mayhem",
      "Lakewood: Warren Road Roof Run",
      "Edgewater Ticket Cache",
      "Turnpike Toll Trouble",
      "Fare Snatcher Boss",
    ]);
    expect(projectPackage.manifest.project.levelPlan.id).toBe("level-1-cleveland-skyline-scramble");
    expect(projectPackage.manifest.project.scenes.map((scene: { id: string }) => scene.id)).toEqual(
      ["w1-1-cleveland-skyline-scramble"],
    );
    expect(projectPackage.manifest.project.stanskiLevelOneProduction).toMatchObject({
      activeLevelId: "w1-1-cleveland-skyline-scramble",
      activeLevelTitle: "Cleveland: Skyline Scramble",
      fullGamePlanStatus: "preserved-for-later",
      openingOverlay: { world: "Cleveland", level: "1" },
      productionScope: "level-1-only",
    });
    expect(projectPackage.manifest.project.stanskiLevelOneProduction.mechanics).toMatchObject({
      startingLives: 5,
      runMultiplier: 1.5,
      gasBoostMultiplier: 1.5,
      fallingGasBoostAllowed: true,
    });
    expect(
      projectPackage.manifest.project.stanskiLevelOneProduction.objects.map(
        (object: { id: string }) => object.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        "l1-cheeseburger-trail",
        "l1-receipt-goblin",
        "l1-burrito-block",
        "l1-bridge-checkpoint",
        "l1-upper-awning-secret",
        "l1-pizza-slice",
        "l1-turnstile-snatcher",
        "l1-toilet-ending",
      ]),
    );
    expect(projectPackage.manifest.project.stanskiLevelOneProduction.replayScript.at(-1).id).toBe(
      "toilet-ending",
    );
    expect(JSON.stringify(canon)).toContain("Golden Transfer Pass #1");
    expect(JSON.stringify(canon)).toContain("Warren Road");
    expect(JSON.stringify(canon.requiredCanon)).toContain("Secret World 9");
    expect(JSON.stringify(canon.requiredCanon)).toContain("Receipt Reality");
    expect(JSON.stringify(canon.requiredCanon)).toContain("Back of the Map");
    expect(JSON.stringify(canon.requiredCanon)).toContain("photo inclusion");
    const manBoyReference = canon.references.find(
      (reference: { id: string }) => reference.id === "man-boy-snes-photo-reference",
    );
    expect(manBoyReference?.status).toBe("blocked");
    expect(manBoyReference?.usage).toContain("Family Memory Card secret room");
    expect(manBoyReference?.blocker).toContain("source image unavailable");
    const manBoyAsset = projectPackage.manifest.assetRegistry.records.find(
      (record: { id: string }) => record.id === "man-boy-snes-photo-reference",
    );
    expect(manBoyAsset?.visualMaturity).toBe("spec-only");
    expect(manBoyAsset?.blockers.join("\n")).toContain("source image unavailable");
    expect(
      backlog.some((milestone: { group?: string }) => milestone.group === "worlds-2-through-8"),
    ).toBe(true);
    expect(state.stageStates.active).toEqual(
      expect.arrayContaining(["SW-B1-M1", "SW-B1-M2", "SW-B1-M3", "SW-B1-M7", "SW-L1-M2"]),
    );
    expect(state.stageStates.planned).toEqual(
      expect.arrayContaining(["SW-FUTURE-W2-W8", "SW-FUTURE-RC"]),
    );
    expect(projectPackage.receipts.qa.map((receipt: { id: string }) => receipt.id)).toEqual(
      expect.arrayContaining([
        "batch-1-foundation",
        "visual-approval-status",
        "fxpak-write-status",
      ]),
    );
  });

  it("reconciles Stanski Level 1 production state from proof receipts without closing external gates", async () => {
    const projectsRoot = await tempDir();
    runMode("project-art-source-pack", { projectId: "stanskis-world", projectsRoot });
    runMode("project-art-compile", { projectId: "stanskis-world", projectsRoot });
    runMode("project-conversion", { projectId: "stanskis-world", projectsRoot });
    runMode("project-visual-proof", { projectId: "stanskis-world", projectsRoot });
    const playtest = runMode("project-browser-playtest", {
      levelId: "w1-1-cleveland-skyline-scramble",
      projectId: "stanskis-world",
      projectsRoot,
    });
    const report = reconcileProductionState({ projectId: "stanskis-world", projectsRoot });
    const state = JSON.parse(
      await readFile(path.join(projectsRoot, "stanskis-world", "production", "state.json"), "utf8"),
    );

    expect(playtest.status).toBe("pass");
    expect(report.status).toBe("pass");
    expect(report.completedMilestones).toEqual(
      expect.arrayContaining(["SW-L1-M0", "SW-L1-M1", "SW-L1-M2", "SW-L1-M3"]),
    );
    expect(state.stageStates.implemented).toEqual(
      expect.arrayContaining(["level-1-playable-data", "level-1-movement-contract"]),
    );
    expect(state.stageStates.built).toEqual(
      expect.arrayContaining(["project-art-compile", "project-conversion"]),
    );
    expect(state.stageStates["visual-proofed"]).toEqual(
      expect.arrayContaining(["project-visual-proof", "project-browser-playtest"]),
    );
    expect(report.visualApprovalClaimed).toBe(false);
    expect(report.blockers.join("\n")).toContain("100/100 human visual approval");
    expect(report.blockers.join("\n")).toContain("man-boy-snes-photo-reference");
  });

  it("rejects procedural art and compiles editable production-candidate source assets", async () => {
    const projectsRoot = await tempDir();
    const manifest = projectArtManifest({
      assetId: "hero",
      projectId: "comet-fox-mvp",
      projectsRoot,
    });
    const placeholderCompile = projectArtCompile({ projectId: "comet-fox-mvp", projectsRoot });
    const bible = projectArtBible({ projectId: "comet-fox-mvp", projectsRoot });
    const sourcePack = projectArtSourcePack({ projectId: "comet-fox-mvp", projectsRoot });
    const compile = projectArtCompile({ projectId: "comet-fox-mvp", projectsRoot });

    expect(manifest).toMatchObject({
      hostedGlmUsed: false,
      localGlmOnly: true,
      status: "pass",
    });
    expect(manifest.manifest.assets[0].type).toBe("character-sprite");
    expect(placeholderCompile.status).toBe("blocked");
    expect(placeholderCompile.blockers.join(" ")).toContain(
      "Editable Pixelorama/Tiled source pack",
    );
    expect(
      placeholderCompile.assetRecords.every(
        (record) => record.visualMaturity === "draft-generated-placeholder",
      ),
    ).toBe(true);
    expect(bible.status).toBe("pass");
    expect(bible.artBible.targetHumanScore).toBe(100);
    expect(sourcePack.status).toBe("pass");
    expect(sourcePack.professionalArtPack).toMatchObject({
      cleanRoomSourcePolicy: expect.objectContaining({ nintendoCodeOrAssetsUsed: false }),
      humanApproved: false,
      id: "stanski-level1-clean-room-cleveland-art-pack-v3",
      status: "candidate-generated",
    });
    expect(
      sourcePack.professionalArtPack.clevelandLandmarks.map((landmark) => landmark.label),
    ).toEqual(
      expect.arrayContaining([
        "Terminal Tower",
        "Key Tower",
        "200 Public Square",
        "Cuyahoga River bridge truss",
        "Lake Erie",
      ]),
    );
    expect(sourcePack.professionalArtPack.replacedWeakAssetIds.length).toBeGreaterThan(0);
    expect(sourcePack.tiledMapPath).toContain("level-1-visual-map.tiled.json");
    expect(sourcePack.assetRecords.every((record) => record.artSource?.editableSourcePath)).toBe(
      true,
    );
    expect(compile.status).toBe("pass");
    expect(compile.visualApprovalClaimed).toBe(false);
    expect(compile.assetRecords).toHaveLength(7);
    expect(compile.assetRecords.map((record) => record.type)).toEqual(
      expect.arrayContaining([
        "character-sprite",
        "enemy-sprite",
        "item-sprite",
        "tileset",
        "background-layer",
      ]),
    );
    const hero = compile.assetRecords.find((record) => record.type === "character-sprite");
    const tileset = compile.assetRecords.find((record) => record.type === "tileset");
    const backgroundLayers = compile.assetRecords.filter(
      (record) => record.type === "background-layer",
    );
    expect(hero?.visualMaturity).toBe("production-candidate");
    expect(hero?.licenseReceipt).toMatchObject({
      copiedCommercialAsset: false,
      license: "original-clean-room",
      nintendoCodeOrAssetsUsed: false,
      status: "pass",
    });
    expect(hero?.frames).toHaveLength(40);
    expect(hero?.artSource?.editableSourcePath).toContain("pixelorama-source");
    expect(tileset?.tileMetadata?.tileCount).toBe(96);
    expect(backgroundLayers).toHaveLength(3);
    expect(
      backgroundLayers.some((record) =>
        record.clevelandLandmarks?.some((landmark) => landmark.label === "Terminal Tower"),
      ),
    ).toBe(true);
    expect(compile.assetRecords.every((record) => record.visualProof.length >= 1)).toBe(true);
  });

  it("captures in-game visual proof screenshots without approving visuals", async () => {
    const projectsRoot = await tempDir();
    projectArtSourcePack({ projectId: "comet-fox-mvp", projectsRoot });
    projectArtCompile({ projectId: "comet-fox-mvp", projectsRoot });
    projectConversion({ projectId: "comet-fox-mvp", projectsRoot });
    const proof = projectVisualProof({ projectId: "comet-fox-mvp", projectsRoot });

    expect(proof.status).toBe("pass");
    expect(proof.visualApprovalClaimed).toBe(false);
    expect(proof.screenshots.map((shot) => shot.scene)).toEqual(["start", "mid", "goal"]);
    expect(proof.screenshots.every((shot) => shot.kind === "in-game-screenshot")).toBe(true);
    expect(proof.screenshots.every((shot) => shot.proofSource === "synthetic-composite")).toBe(
      true,
    );
    expect(proof.productionProofStatus.status).toBe("blocked");
    expect(proof.screenshots.every((shot) => shot.sha256.match(/^[a-f0-9]{64}$/u))).toBe(true);
  });

  it("blocks runtime asset truth when visual proof is synthetic instead of runtime capture", async () => {
    const projectsRoot = await tempDir();
    runMode("project-art-source-pack", { projectId: "stanskis-world", projectsRoot });
    runMode("project-art-compile", { projectId: "stanskis-world", projectsRoot });
    runMode("project-conversion", { projectId: "stanskis-world", projectsRoot });
    runMode("project-engine-rom", { projectId: "stanskis-world", projectsRoot });
    runMode("project-visual-proof", { projectId: "stanskis-world", projectsRoot });
    const truth = projectRuntimeAssetTruth({ projectId: "stanskis-world", projectsRoot });

    expect(truth.status).toBe("blocked");
    expect(truth.assets.length).toBeGreaterThanOrEqual(5);
    expect(truth.assets.every((asset) => asset.runtimeProofStatus === "blocked")).toBe(true);
    expect(truth.blockers.join("\n")).toContain("synthetic-composite");
  });

  it("proves runtime asset truth only after converted pixels are engine-bound and runtime-captured", async () => {
    const projectsRoot = await tempDir();
    runMode("project-art-source-pack", { projectId: "stanskis-world", projectsRoot });
    runMode("project-art-compile", { projectId: "stanskis-world", projectsRoot });
    runMode("project-conversion", { projectId: "stanskis-world", projectsRoot });
    const engine = runMode("project-engine-rom", { projectId: "stanskis-world", projectsRoot });
    runMode("project-visual-proof", {
      projectId: "stanskis-world",
      projectsRoot,
      proofSource: "runtime-capture",
    });
    const truth = projectRuntimeAssetTruth({ projectId: "stanskis-world", projectsRoot });

    if (engine.status !== "pass") {
      expect(truth.status).toBe("blocked");
      expect(truth.blockers.join("\n")).toContain("project-engine-rom");
      return;
    }

    expect(engine.runtimeAssetBinding).toMatchObject({
      productionPixelBinding: true,
      status: "source-bound-converted-assets",
    });
    expect(truth.status).toBe("pass");
    expect(truth.runtimeAssetBinding.productionPixelBinding).toBe(true);
    expect(truth.assets.every((asset) => asset.runtimeProofStatus === "proven")).toBe(true);
    expect(
      truth.assets.every((asset) =>
        asset.convertedOutputsBound.some((output) => output.path.endsWith("tiles.4bpp")),
      ),
    ).toBe(true);
  });

  it("blocks Stanski visual quality audit from weak human grades and missing runtime asset truth", async () => {
    const projectsRoot = await tempDir();
    runMode("visual-reject", {
      humanScore: 3,
      levelId: "w1-1-cleveland-skyline-scramble",
      projectId: "stanskis-world",
      projectsRoot,
    });
    runMode("project-art-source-pack", { projectId: "stanskis-world", projectsRoot });
    runMode("project-art-compile", { projectId: "stanskis-world", projectsRoot });
    runMode("project-conversion", { projectId: "stanskis-world", projectsRoot });
    runMode("project-engine-rom", { projectId: "stanskis-world", projectsRoot });
    runMode("project-visual-proof", { projectId: "stanskis-world", projectsRoot });
    runMode("project-runtime-asset-truth", { projectId: "stanskis-world", projectsRoot });
    const audit = projectVisualQualityAudit({ projectId: "stanskis-world", projectsRoot });

    expect(audit.status).toBe("blocked");
    expect(audit.humanGrades).toMatchObject({
      inGameScreenshots: 3,
      spriteSheets: 72,
      toddSpriteSheet: 72,
      enemySpriteSheet: 72,
      itemSpriteSheet: 72,
      tileset: 20,
      backgroundLayer: 8,
    });
    expect(audit.screenshotMetrics).toHaveLength(3);
    expect(audit.blockers.join("\n")).toContain("Human in-game screenshot grade is 3/100");
    expect(audit.runtimeAssetTruth.status).toBe("blocked");
    expect(audit.blockers.join("\n")).toContain("synthetic-composite");
    expect(audit.safeReferencePolicy.commercialRomDownloadAllowed).toBe(false);
  });

  it("generates a Stanski human review pack without claiming visual approval", async () => {
    const projectsRoot = await tempDir();
    runMode("project-art-source-pack", { projectId: "stanskis-world", projectsRoot });
    runMode("project-art-compile", { projectId: "stanskis-world", projectsRoot });
    runMode("project-conversion", { projectId: "stanskis-world", projectsRoot });
    runMode("project-visual-proof", { projectId: "stanskis-world", projectsRoot });
    const pack = projectVisualReviewPack({
      levelId: "w1-1-cleveland-skyline-scramble",
      projectId: "stanskis-world",
      projectsRoot,
    });

    expect(pack.status).toBe("pass");
    expect(pack.visualApprovalClaimed).toBe(false);
    expect(pack.humanApprovalRequired).toBe(true);
    expect(pack.blockers).toEqual([]);
    expect(pack.artifacts.markdownPath).toContain("review-pack.md");
  });

  it("verifies Stanski Level 1 browser playtest assertions from deterministic project data", async () => {
    const projectsRoot = await tempDir();
    const playtest = projectBrowserPlaytest({
      levelId: "w1-1-cleveland-skyline-scramble",
      projectId: "stanskis-world",
      projectsRoot,
    });

    expect(playtest.status).toBe("pass");
    expect(playtest.replayResult).toMatchObject({
      finalStep: "toilet-ending",
      reachedGoal: true,
    });
    expect(playtest.assertions.every((assertion) => assertion.pass)).toBe(true);
    expect(playtest.assertions.map((assertion) => assertion.code)).toEqual(
      expect.arrayContaining([
        "opening-overlay",
        "five-lives",
        "run-1-5x",
        "falling-gas-boost",
        "crouch-projectile-origin",
        "first-30-seconds-pacing",
        "checkpoint-before-hardest-section",
        "lower-and-secret-upper-routes",
        "projectile-gate-after-pickup",
        "finishable-after-one-death-restart",
        "toilet-ending",
      ]),
    );
  });

  it("records a 3/100 Stanski visual rejection and keeps production blocked", async () => {
    const projectsRoot = await tempDir();
    const rejection = projectVisualReject({
      humanScore: 3,
      levelId: "w1-1-cleveland-skyline-scramble",
      projectId: "stanskis-world",
      projectsRoot,
    });
    const report = reconcileProductionState({ projectId: "stanskis-world", projectsRoot });
    const projectPackage = JSON.parse(
      await readFile(path.join(projectsRoot, "stanskis-world", "project.json"), "utf8"),
    );

    expect(rejection).toMatchObject({
      fxpakProductionExportBlocked: true,
      humanScore: 3,
      productionBlocked: true,
      status: "rejected",
      targetScore: 100,
    });
    expect(rejection.reasons.join(" ")).toContain("recognizable Cleveland skyline");
    expect(report.blockers.join(" ")).toContain("Current visuals rejected by human score 3/100");
    expect(projectPackage.manifest.productionReadiness.visualApproval).toMatchObject({
      currentHumanScore: 3,
      status: "rejected",
      targetScore: 100,
    });
  });

  it("keeps the Stanski man/boy source photo as an external blocker instead of generating a fake source", async () => {
    const projectsRoot = await tempDir();
    const sourcePack = projectArtSourcePack({ projectId: "stanskis-world", projectsRoot });

    expect(sourcePack.status).toBe("pass");
    expect(sourcePack.professionalArtPack.externalBlockedAssetIds).toContain(
      "man-boy-snes-photo-reference",
    );
    expect(sourcePack.assetRecords.map((record) => record.id)).not.toContain(
      "man-boy-snes-photo-reference",
    );
    expect(sourcePack.professionalArtPack.blockers.join("\n")).toContain(
      "original source photo is still external-blocked",
    );
  });

  it("records human visual approval only after visual proof exists", async () => {
    const projectsRoot = await tempDir();
    projectArtSourcePack({ projectId: "comet-fox-mvp", projectsRoot });
    projectArtCompile({ projectId: "comet-fox-mvp", projectsRoot });
    projectConversion({ projectId: "comet-fox-mvp", projectsRoot });
    projectVisualProof({
      projectId: "comet-fox-mvp",
      projectsRoot,
      proofSource: "runtime-capture",
    });
    const unconfirmedApproval = projectVisualApproval({
      approver: "human-test",
      humanScore: 100,
      projectId: "comet-fox-mvp",
      projectsRoot,
    });
    expect(unconfirmedApproval.status).toBe("blocked");
    expect(unconfirmedApproval.blockers.join(" ")).toContain("confirm-human-reviewed-visuals");

    const approval = projectVisualApproval({
      approver: "human-test",
      confirmHumanReviewedVisuals: true,
      humanScore: 100,
      projectId: "comet-fox-mvp",
      projectsRoot,
      reviewNote: "Reviewed contact sheets, atlas sheets, background composites, and screenshots.",
    });

    expect(approval).toMatchObject({
      gpt55VisualJudgeUsed: false,
      hostedGlmUsed: false,
      humanReviewed: true,
      humanScore: 100,
      reviewNote: "Reviewed contact sheets, atlas sheets, background composites, and screenshots.",
      status: "pass",
    });
    expect(approval.screenshotProof).toHaveLength(3);
    const approvedPackage = JSON.parse(
      await readFile(path.join(projectsRoot, "comet-fox-mvp", "project.json"), "utf8"),
    );
    expect(
      approvedPackage.manifest.assetRegistry.records.every(
        (record: { visualMaturity?: string }) => record.visualMaturity === "production-approved",
      ),
    ).toBe(true);
    expect(approvedPackage.manifest.productionReadiness.visualApproval).toMatchObject({
      currentHumanScore: 100,
      status: "approved",
    });
  });

  it("builds or blocks a generated project ROM with an exact receipt", async () => {
    const projectsRoot = await tempDir();
    const report = projectRom({ projectId: "comet-fox-mvp", projectsRoot });

    expect(["blocked", "pass"]).toContain(report.status);
    expect(report.project.id).toBe("comet-fox-mvp");
    expect(report.projectHash).toMatch(/^[a-f0-9]{64}$/u);
    if (report.status === "pass") {
      expect(report.rom.fileName).toMatch(/^comet-fox-mvp-[a-f0-9]{12}\.sfc$/u);
      expect(report.rom.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(report.generatedProject.source).toBe("openclaw-generated-pvsneslib-project");
      expect(report.proofKind).toBe("scaffold");
    } else {
      expect(report.blockers.length).toBeGreaterThan(0);
    }
  });

  it("builds or blocks the real engine runtime without treating scaffolds as gameplay", async () => {
    const projectsRoot = await tempDir();
    const report = projectEngineRom({ projectId: "stanskis-world", projectsRoot });

    expect(["blocked", "pass", "rejected-scaffold"]).toContain(report.status);
    expect(report.project.id).toBe("stanskis-world");
    expect(report.proofKind).toBe("engine-runtime");
    if (report.status === "pass") {
      expect(report.productionReady).toBe(true);
      expect(report.runtimeMaturity).toBe("production-candidate-level");
      expect(report.levelWidthPx).toBeGreaterThanOrEqual(2048);
      expect(report.cameraScroll).toBe(true);
      expect(report.collisionMap).toBe(true);
      expect(report.objectCount).toBeGreaterThanOrEqual(10);
      expect(report.metaspriteFrameCount).toBeGreaterThanOrEqual(8);
      expect(report.endingStateMachine).toBe(true);
      expect(report.audioRuntimeIntegrated).toBe(true);
      expect(report.buildCommand.status).toBe(0);
      expect(report.scaffoldClassification).toMatchObject({
        isScaffold: false,
        runtimeMaturity: "production-candidate-level",
        status: "real-runtime-candidate",
      });
      expect(report.engineRuntimeProof).toMatchObject({
        audioRuntimeIntegrated: true,
        cameraScroll: true,
        collisionMap: true,
        endingStateMachine: true,
        levelWidthPx: expect.any(Number),
        objectCount: expect.any(Number),
        runtimeMaturity: "production-candidate-level",
        status: "pass",
      });
      expect(report.engineRuntimeProof.features).toEqual(
        expect.arrayContaining(["player-movement", "jump", "enemy", "collectible", "goal"]),
      );
      expect(report.rom.fileName).toMatch(/^stanskis-world-engine-[a-f0-9]{12}\.sfc$/u);
      expect(report.rom.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(report.superfamicheck?.ok).toBe(true);
    } else if (report.status === "rejected-scaffold") {
      expect(report.scaffoldClassification).toMatchObject({
        isScaffold: true,
        status: "rejected-scaffold",
      });
      expect(report.productionReady).toBe(false);
      expect(report.blockers.join(" ")).toContain("text-mode scaffold");
    } else {
      expect(report.blockers.length).toBeGreaterThan(0);
    }
  });

  it("creates a local SNES audio compile receipt with Stanski runtime integration hooks", async () => {
    const projectsRoot = await tempDir();
    const report = projectAudioCompile({ projectId: "stanskis-world", projectsRoot });

    expect(report.status).toBe("pass");
    expect(report.audioRuntimeIntegrated).toBe(true);
    expect(report.aramBudget.totalBytes).toBeLessThan(report.aramBudget.availableBytes);
    expect(report.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps FXPAK dry-run blocked when no FAT32 media is mounted", async () => {
    const projectsRoot = await tempDir();
    const projectId = "comet-fox-mvp";
    const romPath = path.join(projectsRoot, "test.sfc");
    const toolchainDir = path.join(projectsRoot, projectId, "toolchain");
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(toolchainDir, { recursive: true });
      await writeFile(romPath, "rom");
      await writeFile(
        path.join(toolchainDir, "latest-rom.json"),
        JSON.stringify({
          status: "pass",
          rom: {
            fileName: "test.sfc",
            path: romPath,
            sha256: "7d865e959b2466918c9863afca942d0fb7d0b60e3f5b062802e027b6d015fc44",
          },
        }),
      );
    });
    const report = fxpakDryRun({
      projectId,
      projectsRoot,
      volumesRoot: path.join(projectsRoot, "Volumes"),
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(["no mounted FXPAK/SD2SNES FAT32 media"]);
  });

  it("copies only the approved ROM to a confirmed FAT32 FXPAK path and verifies hashes", async () => {
    const projectsRoot = await tempDir();
    const projectId = "comet-fox-mvp";
    const volume = path.join(projectsRoot, "FXPAK");
    const romPath = path.join(projectsRoot, "source.sfc");
    const sourcePath = path.join(projectsRoot, "engine.c");
    const toolchainDir = path.join(projectsRoot, projectId, "toolchain");
    const romBytes = Buffer.from("openclaw-snes-rom");
    const romHash = "3bc9f2110e75f5b4e33462c866986be6f18babf92c3e33c8b1aae4abb5d4e58c";
    await import("node:fs/promises").then(async ({ mkdir, readdir, readFile, writeFile }) => {
      await mkdir(volume, { recursive: true });
      await mkdir(toolchainDir, { recursive: true });
      await writeFile(romPath, romBytes);
      await writeFile(
        sourcePath,
        [
          "void game(void) {",
          "  bgInitTileSet(0, 0, 0, 0, 0, 0, 0);",
          "  bgInitMapSet(0, 0, 0, 0, 0);",
          "  oamInit();",
          "  spcBoot();",
          "}",
        ].join("\n"),
      );
      await writeFile(
        path.join(toolchainDir, "latest-visual-approval.json"),
        JSON.stringify({ status: "pass", humanScore: 100 }),
      );
      await writeFile(
        path.join(toolchainDir, "latest-engine-rom.json"),
        JSON.stringify({
          status: "pass",
          productionReady: true,
          proofKind: "engine-runtime",
          runtimeMaturity: "production-candidate-level",
          buildCommand: { status: 0 },
          audioReceipt: { status: "pass", audioRuntimeIntegrated: true },
          generatedProject: { files: [{ path: sourcePath }] },
          rom: { fileName: "source.sfc", path: romPath, sha256: romHash },
        }),
      );
      const dryRun = fxpakDryRun({
        allowNonVolumesForTests: true,
        fileSystem: "FAT32",
        fxpakVolume: volume,
        projectId,
        projectsRoot,
      });
      const copy = fxpakCopy({
        allowFxpakWrite: true,
        allowNonVolumesForTests: true,
        confirmFxpakVolume: volume,
        fileSystem: "FAT32",
        fxpakVolume: volume,
        projectId,
        projectsRoot,
      });

      expect(dryRun.status).toBe("pass");
      expect(copy.status).toBe("pass");
      expect(copy.copied.destinationSha256).toBe(romHash);
      expect(await readFile(copy.copied.destinationPath, "utf8")).toBe("openclaw-snes-rom");
      expect((await readdir(volume)).some((name) => name.endsWith(".srm"))).toBe(false);
    });
  });

  it("creates a manual FXPAK/Games transfer package without writing removable media", async () => {
    const projectsRoot = await tempDir();
    const projectId = "stanskis-world";
    const rom = runMode("project-engine-rom", {
      levelId: "w1-1-cleveland-skyline-scramble",
      projectId,
      projectsRoot,
    });
    const report = fxpakTransferPackage({ projectId, projectsRoot });

    expect(rom.status).toBe("pass");
    expect(report.status).toBe("blocked");
    expect(report.copiedToRemovableMedia).toBe(false);
    expect(report.blockers.join(" ")).toContain("No 100/100 human visual approval receipt exists");
  });

  it("blocks FXPAK export when the latest engine ROM is still a text scaffold", async () => {
    const projectsRoot = await tempDir();
    const projectId = "comet-fox-mvp";
    const volume = path.join(projectsRoot, "FXPAK");
    const romPath = path.join(projectsRoot, "source.sfc");
    const sourcePath = path.join(projectsRoot, "hello_world.c");
    const toolchainDir = path.join(projectsRoot, projectId, "toolchain");
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(volume, { recursive: true });
      await mkdir(toolchainDir, { recursive: true });
      await writeFile(romPath, "rom");
      await writeFile(sourcePath, 'void main(void){ consoleDrawText(playerX, playerY, "@"); }');
      await writeFile(
        path.join(toolchainDir, "latest-engine-rom.json"),
        JSON.stringify({
          status: "pass",
          proofKind: "engine-runtime",
          buildCommand: { status: 0 },
          audioReceipt: { status: "pass" },
          generatedProject: { files: [{ path: sourcePath }] },
          rom: {
            fileName: "source.sfc",
            path: romPath,
            sha256: "7d865e959b2466918c9863afca942d0fb7d0b60e3f5b062802e027b6d015fc44",
          },
        }),
      );
    });
    const report = fxpakDryRun({
      allowNonVolumesForTests: true,
      fileSystem: "FAT32",
      fxpakVolume: volume,
      projectId,
      projectsRoot,
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("text-mode scaffold");
  });

  it("blocks FXPAK export when the latest engine ROM has not reached production-candidate maturity", async () => {
    const projectsRoot = await tempDir();
    const projectId = "comet-fox-mvp";
    const volume = path.join(projectsRoot, "FXPAK");
    const romPath = path.join(projectsRoot, "source.sfc");
    const sourcePath = path.join(projectsRoot, "runtime.c");
    const toolchainDir = path.join(projectsRoot, projectId, "toolchain");
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(volume, { recursive: true });
      await mkdir(toolchainDir, { recursive: true });
      await writeFile(romPath, "rom");
      await writeFile(
        sourcePath,
        "void main(void){ oamSet(0,1,1,3,0,0,0,0); bgInitMapSet(0,0,0,0,0); spcProcess(); }",
      );
      await writeFile(
        path.join(toolchainDir, "latest-engine-rom.json"),
        JSON.stringify({
          status: "pass",
          proofKind: "engine-runtime",
          buildCommand: { status: 0 },
          runtimeMaturity: "playable-level-runtime",
          productionReady: true,
          audioReceipt: { status: "pass", audioRuntimeIntegrated: true },
          generatedProject: { files: [{ path: sourcePath }] },
          rom: {
            fileName: "source.sfc",
            path: romPath,
            sha256: "7d865e959b2466918c9863afca942d0fb7d0b60e3f5b062802e027b6d015fc44",
          },
        }),
      );
    });
    const report = fxpakDryRun({
      allowNonVolumesForTests: true,
      fileSystem: "FAT32",
      fxpakVolume: volume,
      projectId,
      projectsRoot,
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toContain("production-candidate-level");
  });

  it("writes arbitrary proof receipts", async () => {
    const artifactDir = await tempDir();
    const artifacts = writeReceipt(
      "conversion",
      { generatedAt: "2026-06-23T00:00:00.000Z", status: "pass" },
      artifactDir,
    );

    expect(JSON.parse(await readFile(artifacts.latestPath, "utf8"))).toMatchObject({
      status: "pass",
    });
  });
});

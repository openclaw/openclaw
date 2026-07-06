import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts/snes-asset-studio.mjs");
const teamScriptPath = path.join(process.cwd(), "scripts/snes-team-orchestrator.mjs");
const fixturePath = path.join(process.cwd(), "fixtures/snes-asset-studio/source-fixture.png");
const sheetFixturePath = path.join(
  process.cwd(),
  "fixtures/snes-asset-studio/source-sheet-fixture.png",
);
const promptPath = path.join(process.cwd(), "fixtures/snes-demo-prompt.txt");

function uniqueProject(prefix = "asset-studio-test") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function runAsset(args: string[], env: NodeJS.ProcessEnv = {}) {
  const output = execFileSync(process.execPath, [scriptPath, ...args, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(output);
}

function runAssetBlocked(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(result.status).not.toBe(0);
  return JSON.parse(result.stdout);
}

function runTeam(args: string[]) {
  const output = execFileSync(process.execPath, [teamScriptPath, ...args, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function prepareAsset(project: string, assetId = "hero_sprite") {
  runAsset([
    "preserve",
    "--project",
    project,
    "--asset-id",
    assetId,
    "--kind",
    "sprite",
    "--source",
    fixturePath,
  ]);
  runAsset([
    "intent",
    "--project",
    project,
    "--asset-id",
    assetId,
    "--kind",
    "sprite",
    "--dimensions",
    "32x32",
    "--frames",
    "3",
  ]);
  runAsset(["convert", "--project", project, "--asset-id", assetId]);
  runAsset(["contact-sheet", "--project", project, "--asset-id", assetId]);
  runAsset(["pipeline", "--project", project, "--asset-id", assetId]);
  runTeam(["--mode", "create-game", "--project", project, "--prompt", promptPath]);
  runAsset(["insert", "--project", project, "--asset-id", assetId, "--target", "player.sprite"]);
}

describe("SNES Asset Studio CLI", () => {
  it("preserves, converts, contact-sheets, and inserts a generic asset without runtime-proof collapse", () => {
    const project = uniqueProject();
    const assetId = "hero_sprite";
    const preserve = runAsset([
      "preserve",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--kind",
      "sprite",
      "--source",
      fixturePath,
    ]);
    expect(preserve.status).toBe("pass");
    expect(preserve.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(preserve.source.preservedPath)).toBe(true);

    const intent = runAsset([
      "intent",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--kind",
      "sprite",
      "--dimensions",
      "32x32",
      "--frames",
      "3",
      "--must-show",
      "readable hero silhouette,clear face",
      "--must-not-show",
      "placeholder box,licensed character",
    ]);
    expect(intent.status).toBe("pass");
    expect(intent.intent.runtimeProofRequired).toBe(true);

    const conversion = runAsset(["convert", "--project", project, "--asset-id", assetId]);
    expect(conversion.status).toBe("pass");
    expect(conversion.output.colorCount).toBeLessThanOrEqual(16);
    expect(conversion.output.frameCount).toBe(3);

    const contactSheet = runAsset(["contact-sheet", "--project", project, "--asset-id", assetId]);
    expect(contactSheet.status).toBe("pass");
    expect(contactSheet.blankFrames).toEqual([]);
    expect(contactSheet.duplicateFrames).toEqual([]);
    expect(fs.existsSync(contactSheet.contactSheetPath)).toBe(true);

    const pipeline = runAsset(["pipeline", "--project", project, "--asset-id", assetId]);
    expect(pipeline.status).toBe("pass");
    expect(pipeline.runtimeProofSatisfied).toBe(false);
    expect(pipeline.stages.runtimeUse.status).toBe("blocked");

    const created = runTeam([
      "--mode",
      "create-game",
      "--project",
      project,
      "--prompt",
      promptPath,
    ]);
    expect(created.status).toBe("pass");

    const insertion = runAsset([
      "insert",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--target",
      "player.sprite",
    ]);
    expect(insertion.status).toBe("pass");
    expect(insertion.runtimeProofSatisfied).toBe(false);
    expect(fs.existsSync(insertion.manifestPath)).toBe(true);

    const runtimePlan = runAssetBlocked([
      "runtime-proof-plan",
      "--project",
      project,
      "--asset-id",
      assetId,
    ]);
    expect(runtimePlan.status).toBe("blocked");
    expect(runtimePlan.staticInsertionIsRuntimeProof).toBe(false);
    expect(runtimePlan.requiredFutureProof.expectedRuntimeLocation).toBe("player.sprite");

    const dashboard = runTeam(["--mode", "dashboard-snapshot", "--project", project]);
    expect(dashboard.status).toBe("pass");
    expect(dashboard.assetStudio.assetCount).toBe(1);
    expect(dashboard.assetStudio.assets[0]).toMatchObject({
      assetId,
      target: "player.sprite",
      runtimeProofSatisfied: false,
    });
  });

  it("blocks missing sources and blocked named-game or commercial references", () => {
    const project = uniqueProject("asset-studio-negative");
    const missing = runAssetBlocked([
      "preserve",
      "--project",
      project,
      "--asset-id",
      "missing_sprite",
      "--kind",
      "sprite",
      "--source",
      "fixtures/snes-asset-studio/does-not-exist.png",
    ]);
    expect(missing.status).toBe("blocked");
    expect(missing.blocker).toContain("source image not found");

    const named = runAssetBlocked([
      "preserve",
      "--project",
      project,
      "--asset-id",
      "metro_sprite",
      "--kind",
      "sprite",
      "--source",
      fixturePath,
    ]);
    expect(named.status).toBe("blocked");
    expect(named.blocker).toContain("blocked named-game");

    const commercial = runAssetBlocked([
      "intent",
      "--project",
      project,
      "--asset-id",
      "hero_sprite",
      "--kind",
      "sprite",
      "--must-show",
      "Super Mario style copy",
    ]);
    expect(commercial.status).toBe("blocked");
    expect(commercial.blocker).toContain("blocked named-game or commercial reference");
  });

  it("extracts horizontal source-sheet frames and rejects invalid crop boxes", () => {
    const project = uniqueProject("asset-studio-sheet");
    const assetId = "sheet_sprite";
    runAsset([
      "preserve",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--kind",
      "sprite",
      "--source",
      sheetFixturePath,
    ]);
    runAsset([
      "intent",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--kind",
      "sprite",
      "--dimensions",
      "16x16",
      "--frames",
      "3",
    ]);
    const conversion = runAsset([
      "convert",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--frame-layout",
      "horizontal",
      "--fit",
      "cover",
    ]);
    expect(conversion.status).toBe("pass");
    expect(conversion.conversionOptions.frameLayout).toBe("horizontal");
    expect(conversion.output.frameCount).toBe(3);
    const qa = runAsset(["contact-sheet", "--project", project, "--asset-id", assetId]);
    expect(qa.status).toBe("pass");

    const badCrop = runAssetBlocked([
      "convert",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--crop",
      "99,99,10,10",
    ]);
    expect(badCrop.status).toBe("blocked");
    expect(badCrop.blocker).toContain("crop rectangle is outside");
  });

  it("compiles inserted assets without claiming runtime proof", () => {
    const project = uniqueProject("asset-studio-compile");
    const assetId = "hero_sprite";
    prepareAsset(project, assetId);

    const compile = runAsset(["compile", "--project", project, "--asset-id", assetId]);
    expect(compile.status).toBe("pass");
    expect(compile.runtimeProofSatisfied).toBe(false);
    expect(compile.romBuildRequired).toBe(true);
    expect(fs.existsSync(compile.metadataPath)).toBe(true);
    expect(fs.existsSync(compile.headerPath)).toBe(true);
  });

  it("builds a deterministic runtime demo ROM receipt without claiming emulator proof", () => {
    const project = uniqueProject("asset-studio-runtime-demo");
    const assetId = "hero_sprite";
    prepareAsset(project, assetId);
    runAsset(["compile", "--project", project, "--asset-id", assetId]);

    const demo = runAsset(["runtime-demo", "--project", project, "--asset-id", assetId], {
      OPENCLAW_SNES_ASSET_STUDIO_FAKE_BUILD: "1",
    });

    expect(demo.status).toBe("pass");
    expect(demo.format).toBe("openclaw-snes-asset-runtime-demo-rom-v1");
    expect(demo.runtimeProofSatisfied).toBe(false);
    expect(demo.emulatorScreenshotProofRequired).toBe(true);
    expect(demo.renderMode).toBe("oam-metasprite");
    expect(demo.superfamicheck.ok).toBe(true);
    expect(demo.rom.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(demo.rom.path)).toBe(true);
    expect(fs.existsSync(demo.sourcePath)).toBe(true);
  });

  it("blocks runtime demo when compile proof is missing or local toolchain is unavailable", () => {
    const missingCompileProject = uniqueProject("asset-studio-runtime-demo-missing");
    const assetId = "hero_sprite";
    prepareAsset(missingCompileProject, assetId);

    const missingCompile = runAssetBlocked([
      "runtime-demo",
      "--project",
      missingCompileProject,
      "--asset-id",
      assetId,
    ]);
    expect(missingCompile.status).toBe("blocked");
    expect(missingCompile.blocker).toContain("missing runtime compiler receipt");

    const missingToolchainProject = uniqueProject("asset-studio-runtime-demo-tools");
    prepareAsset(missingToolchainProject, assetId);
    runAsset(["compile", "--project", missingToolchainProject, "--asset-id", assetId]);
    const missingToolchain = runAssetBlocked(
      ["runtime-demo", "--project", missingToolchainProject, "--asset-id", assetId],
      {
        OPENCLAW_SNES_ASSET_STUDIO_DISABLE_DEFAULT_TOOLCHAIN: "1",
        PVSNESLIB_HOME: "/definitely/not/pvsneslib",
      },
    );
    expect(missingToolchain.status).toBe("blocked");
    expect(missingToolchain.blocker).toContain("PVSnesLib toolchain not found");
  });

  it("blocks runtime proof without ROM/screenshot and passes with explicit proof artifacts", () => {
    const project = uniqueProject("asset-studio-runtime-proof");
    const assetId = "hero_sprite";
    prepareAsset(project, assetId);
    runAsset(["compile", "--project", project, "--asset-id", assetId]);

    const missing = runAssetBlocked(["runtime-proof", "--project", project, "--asset-id", assetId]);
    expect(missing.status).toBe("blocked");
    expect(missing.staticInsertionIsRuntimeProof).toBe(false);

    const romPath = path.join(".artifacts", "snes-asset-studio", project, "proof-rom.sfc");
    const screenshotPath = path.join(
      ".artifacts",
      "snes-asset-studio",
      project,
      "proof-screenshot.png",
    );
    fs.mkdirSync(path.dirname(romPath), { recursive: true });
    fs.writeFileSync(
      romPath,
      Buffer.from("generic clean-room snes asset runtime proof rom fixture"),
    );
    fs.copyFileSync(fixturePath, screenshotPath);

    const proof = runAsset([
      "runtime-proof",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--rom",
      romPath,
      "--screenshot",
      screenshotPath,
      "--signature",
      "fixture-visible-pixels",
    ]);
    expect(proof.status).toBe("pass");
    expect(proof.runtimeProofSatisfied).toBe(true);
    expect(proof.staticInsertionIsRuntimeProof).toBe(false);
    expect(proof.screenshot.nonTransparentPixels).toBeGreaterThan(0);

    const wrongSha = runAssetBlocked([
      "runtime-proof",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--rom",
      romPath,
      "--screenshot",
      screenshotPath,
      "--expected-rom-sha256",
      "0".repeat(64),
    ]);
    expect(wrongSha.status).toBe("blocked");
    expect(wrongSha.blocker).toContain("ROM SHA mismatch");
  });

  it("separates visual approval from production runtime approval", () => {
    const project = uniqueProject("asset-studio-approval");
    const assetId = "hero_sprite";
    prepareAsset(project, assetId);

    const productionBlocked = runAssetBlocked([
      "approve-visual",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--approval-note",
      "Looks good for structural checkpoint.",
      "--production",
      "true",
    ]);
    expect(productionBlocked.status).toBe("blocked");
    expect(productionBlocked.blocker).toContain("runtime proof");

    const approval = runAsset([
      "approve-visual",
      "--project",
      project,
      "--asset-id",
      assetId,
      "--approval-note",
      "Looks good for structural checkpoint.",
      "--score",
      "90",
    ]);
    expect(approval.status).toBe("pass");
    expect(approval.humanApproved).toBe(true);
    expect(approval.runtimeProofSatisfied).toBe(false);
  });

  it("records local-only redraw attempts as blocked when no local generator is configured", () => {
    const project = uniqueProject("asset-studio-redraw");
    const result = spawnSync(
      process.execPath,
      [scriptPath, "redraw-local", "--project", project, "--asset-id", "hero_sprite", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 90_000,
      },
    );
    expect(result.status).not.toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.status).toBe("blocked");
    expect(receipt.hostedImageGenerationUsed).toBe(false);
    expect(receipt.hostedGlmUsed).toBe(false);
  });
});

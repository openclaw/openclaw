// All UI E2E projects provide Chromium metadata without acquiring a UI server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { TestProject } from "vitest/node";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import type { ControlUiE2ePrebuiltAssets } from "../../ui/src/test-helpers/control-ui-e2e-shared-preview.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { assertUiE2ePreflight } from "./vitest.ui-e2e-preflight.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eDeploymentAssets?: ControlUiE2ePrebuiltAssets;
    controlUiE2eChromium: { executablePath: string; available: boolean };
    controlUiE2eCleanup: { timeoutMs: number; pool: "forks"; isolate: true };
  }
}

const preflights = new WeakMap<TestProject, Promise<void>>();

export default async function setup(project: TestProject) {
  const { pool, isolate, hookTimeout: timeoutMs } = project.config;
  if (pool !== "forks" || !isolate || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Control UI E2E requires isolated forks and a finite hookTimeout for owned cleanup",
    );
  }
  project.provide("controlUiE2eCleanup", { pool: "forks", isolate: true, timeoutMs });
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const available = canRunPlaywrightChromium(executablePath);
  if (available) {
    const root = project.vitest.getRootProject();
    let preflight = preflights.get(root);
    if (!preflight) {
      preflight = assertUiE2ePreflight();
      preflights.set(root, preflight);
    }
    await preflight;
  }
  const deploymentRoot = process.env.OPENCLAW_UI_E2E_DEPLOYMENT_ARTIFACT_ROOT;
  if (deploymentRoot) {
    // Artifact restore verifies provenance; fixtures copy before changing identity.
    const { buildId, version } = normalizeControlUiBuildInfo(
      JSON.parse(readFileSync(path.join(deploymentRoot, "..", "build-info.json"), "utf8")),
    );
    const assets: ControlUiE2ePrebuiltAssets = {
      root: path.resolve(deploymentRoot),
      buildInfo: { buildId, version },
    };
    project.vitest.getRootProject().provide("controlUiE2eDeploymentAssets", assets);
  }
  project.provide("controlUiE2eChromium", { executablePath, available });
}

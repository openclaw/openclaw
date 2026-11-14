// UI E2E projects share Chromium without acquiring a UI server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { TestProject } from "vitest/node";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../ui/src/test-helpers/playwright-chromium.ts";
import { assertUiE2ePreflight } from "./vitest.ui-e2e-preflight.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eChromium: { executablePath: string; available: boolean; wsEndpoint: string | null };
    controlUiE2eCleanup: { timeoutMs: number; pool: "forks"; isolate: true };
  }
}

export default async function setup(project: TestProject) {
  const { pool, isolate, hookTimeout: timeoutMs } = project.config;
  if (pool !== "forks" || !isolate || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Control UI E2E requires isolated forks and a finite hookTimeout for owned cleanup",
    );
  }
  project.provide("controlUiE2eCleanup", { pool: "forks", isolate: true, timeoutMs });
  const root = project.vitest.getRootProject();
  // Vitest initializes selected project setups sequentially. The invocation owns
  // the process; suites close only their connection and its browser contexts.
  if (root.getProvidedContext().controlUiE2eChromium !== undefined) {
    return;
  }
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const available = canRunPlaywrightChromium(executablePath);
  if (available) {
    await assertUiE2ePreflight();
  }
  const productionRoot = process.env.OPENCLAW_UI_E2E_PRODUCTION_ARTIFACT_ROOT;
  const deploymentRoot = process.env.OPENCLAW_UI_E2E_DEPLOYMENT_ARTIFACT_ROOT;
  const artifactRoot = productionRoot || deploymentRoot;
  if (artifactRoot) {
    // Artifact restore owns digest/revision verification. Fixtures copy these
    // immutable production bytes before changing HTML or service-worker identity.
    const { buildId, version } = normalizeControlUiBuildInfo(
      JSON.parse(readFileSync(path.join(artifactRoot, "..", "build-info.json"), "utf8")),
    );
    const assets = { root: path.resolve(artifactRoot), buildInfo: { buildId, version } };
    // Deployment fixtures can borrow restored production bytes without narrowing
    // the suite or replacing its separately owned mock/native-plugin bundle.
    root.provide("controlUiE2eDeploymentAssets", assets);
    if (productionRoot) {
      root.provide("controlUiE2ePrebuiltAssets", assets);
    }
  }
  const browser = available
    ? await chromium.launchServer({
        executablePath,
        // Match private suite launches: full-tile CPU rasterization is deterministic.
        args: ["--disable-partial-raster", "--disable-gpu-rasterization"],
      })
    : undefined;
  // onClose runs after the entire invocation and worker pool settle, including
  // sibling projects whose setup borrowed the endpoint. A browser crash fails
  // its connected suites; the CI harness does not retry or relaunch it.
  if (browser) {
    project.vitest.onClose(() => browser.close());
  }
  root.provide("controlUiE2eChromium", {
    executablePath,
    available,
    wsEndpoint: browser?.wsEndpoint() ?? null,
  });
}

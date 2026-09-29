// All UI E2E projects provide Chromium metadata without acquiring a UI server.
import { chromium } from "playwright";
import type { TestProject } from "vitest/node";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { assertUiE2ePreflight } from "./vitest.ui-e2e-preflight.ts";

declare module "vitest" {
  export interface ProvidedContext {
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
  project.provide("controlUiE2eChromium", { executablePath, available });
}

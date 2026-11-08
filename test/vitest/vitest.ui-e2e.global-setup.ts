// UI E2E projects share Chromium without acquiring a UI server.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserServer } from "playwright";
import type { TestProject } from "vitest/node";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
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
  const setupStarted = performance.now();
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const available = canRunPlaywrightChromium(executablePath);
  if (available) {
    await assertUiE2ePreflight();
  }
  const productionRoot = process.env.OPENCLAW_UI_E2E_PRODUCTION_ARTIFACT_ROOT;
  if (productionRoot) {
    // Artifact restore owns digest/revision verification. Fixtures copy these
    // immutable production bytes before changing HTML or service-worker identity.
    const { buildId, version } = normalizeControlUiBuildInfo(
      JSON.parse(readFileSync(path.join(productionRoot, "..", "build-info.json"), "utf8")),
    );
    root.provide("controlUiE2ePrebuiltAssets", {
      root: path.resolve(productionRoot),
      buildInfo: { buildId, version },
    });
  }
  const launchStarted = performance.now();
  const browser = available
    ? await chromium.launchServer({
        executablePath,
        // Match private suite launches: full-tile CPU rasterization is deterministic.
        args: ["--disable-partial-raster", "--disable-gpu-rasterization"],
      })
    : undefined;
  const launchMs = performance.now() - launchStarted;
  // onClose runs after the entire invocation and worker pool settle, including
  // sibling projects whose setup borrowed the endpoint. A browser crash fails
  // its connected suites; the CI harness does not retry or relaunch it.
  if (browser) {
    // launchServer retains browser logs internally, so forward crash diagnostics.
    const browserProcess = browser.process();
    browserProcess.stderr?.pipe(process.stderr, { end: false });
    browserProcess.once("exit", (code, signal) => {
      console.error(`[ui-e2e] Chromium exited (code=${code}, signal=${signal})`);
    });
    const observer = await observeTargetCrashes(browser).catch(async () => {
      await browser.close();
      // A connect error can contain the private browser endpoint.
      throw new Error("UI E2E could not initialize Chromium crash diagnostics");
    });
    project.vitest.onClose(async () => {
      try {
        await browser.close();
      } finally {
        await observer.close();
      }
    });
  }
  root.provide("controlUiE2eChromium", {
    executablePath,
    available,
    wsEndpoint: browser?.wsEndpoint() ?? null,
  });
  console.info(
    `[ui-e2e] Chromium setup ${Math.round(performance.now() - setupStarted)} ms; launch ${Math.round(launchMs)} ms; available=${available}`,
  );
}

// Inspector.targetCrashed has no payload. The browser Target domain retains the
// native termination reason even when the page cannot execute diagnostics.
async function observeTargetCrashes(server: BrowserServer) {
  const connection = await chromium.connect(server.wsEndpoint(), { timeout: 10_000 });
  try {
    const session = await connection.newBrowserCDPSession();
    const crashes: Array<{ at: string; targetId: string; status: string; errorCode: number }> = [];
    let dropped = 0;
    let artifact: string | undefined;
    let writeFailed = false;
    session.on("Target.targetCrashed", ({ targetId, status, errorCode }) => {
      if (crashes.length < 32) {
        const crash = {
          at: new Date().toISOString(),
          targetId: targetId.slice(0, 128),
          status: status.slice(0, 128),
          errorCode,
        };
        crashes.push(crash);
        // No target URLs, titles, page content, or browser connection endpoints.
        console.error("[ui-e2e] Chromium target crashed", JSON.stringify(crash));
      } else {
        dropped += 1;
      }
      if (writeFailed) {
        return;
      }
      try {
        artifact ??= path.join(
          createControlUiE2eArtifactDir(
            "failure-chromium",
            process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim() ||
              path.resolve(import.meta.dirname, "../../.artifacts/control-ui-e2e-timeouts/local"),
          ),
          "failure.public.json",
        );
        // Publish synchronously at the event, not from a crashed page or its teardown.
        // The existing CI failure-*/failure.public.json upload includes this record.
        writeFileSync(
          `${artifact}.tmp`,
          JSON.stringify({ kind: "chromium-target-crashes", crashes, dropped }) + "\n",
          { mode: 0o600 },
        );
        renameSync(`${artifact}.tmp`, artifact);
      } catch {
        writeFailed = true;
        console.error("[ui-e2e] failed to write Chromium crash diagnostics");
      }
    });
    // Arm before any test worker borrows the endpoint; discovery never attaches or pauses targets.
    await session.send("Target.setDiscoverTargets", { discover: true });
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}

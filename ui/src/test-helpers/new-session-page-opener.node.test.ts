import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { runVitestShutdownCommand } from "../../../test/helpers/vitest-shutdown-command.ts";
import { resolvePlaywrightChromiumExecutablePath } from "./playwright-chromium.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);

it("captures New Session failures before closing their contexts and starting the next test", (context) => {
  const run = Promise.resolve().then(async () => {
    context.signal.throwIfAborted();
    // openclaw-temp-dir: allow retain native-fork evidence when process-tree shutdown fails.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "new-session-context-"));
    let joined = false;
    try {
      const diagnostics = path.join(root, "diagnostics");
      await fs.mkdir(diagnostics);
      await fs.mkdir(path.join(root, "home"));
      await fs.symlink(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const helper = path.join(repoRoot, "ui/src/test-helpers/control-ui-e2e.ts");
      await fs.writeFile(
        path.join(root, "fixture.test.ts"),
        `
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createPageOpener } from ${JSON.stringify(path.join(repoRoot, "ui/src/e2e/new-session-page.scenario.test-support.ts"))};
import { createNewSessionPageE2eSuite } from ${JSON.stringify(path.join(repoRoot, "ui/src/e2e/new-session-page.test-support.ts"))};
vi.mock(${JSON.stringify(helper)}, async (original) => ({
  ...await original(),
  startControlUiE2eServer: async () => ({ baseUrl: "http://fixture.invalid/", close: async () => {} }),
}));
const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const closedWithReport = [];
suite.define(() => {
  it("original failure", async () => {
    const page = await openPage({ viewport: { width: 390, height: 844 } });
    await page.setContent("<h1>Synthetic diagnostic witness</h1>");
    page.context().on("close", () => {
      closedWithReport.push(fs.readdirSync(${JSON.stringify(diagnostics)}).some(name =>
        fs.existsSync(path.join(${JSON.stringify(diagnostics)}, name, "failure.private.json"))));
    });
    throw new Error("private-synthetic-new-session-failure");
  });
  it("successor", () => { expect(suite.browser.contexts()).toHaveLength(0); });
});
afterAll(() => fs.writeFileSync(${JSON.stringify(path.join(root, "journal.json"))}, JSON.stringify({
  closedWithReport, browserConnected: suite.browser.isConnected(),
})));
`,
      );
      await fs.writeFile(
        path.join(root, "vitest.config.ts"),
        `
import { defineConfig } from "vitest/config";
import { createVitestResolveConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.resolve.ts"))};
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  resolve: createVitestResolveConfig(${JSON.stringify(repoRoot)}),
  test: { pool: "forks", isolate: true, maxWorkers: 1, fileParallelism: false,
    testTimeout: 10000, hookTimeout: 10000,
    provide: {
      controlUiE2eChromium: { available: true, executablePath: ${JSON.stringify(resolvePlaywrightChromiumExecutablePath(chromium.executablePath()))}, wsEndpoint: null },
      controlUiE2eCleanup: { timeoutMs: 10000, pool: "forks", isolate: true },
    },
  },
});
`,
      );
      const reportPath = path.join(root, "report.json");
      const output = await runVitestShutdownCommand({
        args: [
          path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
          "run",
          path.join(root, "fixture.test.ts"),
          "--root",
          root,
          "--config",
          path.join(root, "vitest.config.ts"),
          "--configLoader",
          "runner",
          "--reporter=json",
          `--outputFile=${reportPath}`,
        ],
        cwd: repoRoot,
        signal: context.signal,
        timeoutMs: 45_000,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          USERPROFILE: path.join(root, "home"),
          OPENCLAW_HOME: path.join(root, "home"),
          OPENCLAW_STATE_DIR: path.join(root, "home/.openclaw"),
          OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: diagnostics,
          CI: "true",
          NO_COLOR: "1",
        },
      });
      joined = true;
      expect(output.code, output.stdout + output.stderr).toBe(1);
      const report: JsonTestResults = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(report).toMatchObject({ numFailedTests: 1, numPassedTests: 1 });
      expect(JSON.stringify(report)).toContain("private-synthetic-new-session-failure");
      expect(JSON.parse(await fs.readFile(path.join(root, "journal.json"), "utf8"))).toEqual({
        closedWithReport: [true],
        browserConnected: false,
      });
      const captures = await fs.readdir(diagnostics);
      expect(captures).toHaveLength(1);
      const capture = path.join(diagnostics, captures[0]!);
      const publicText = await fs.readFile(path.join(capture, "failure.public.json"), "utf8");
      expect(JSON.parse(publicText)).toMatchObject({
        hostBeforeRead: { pageClosed: false, browserConnected: true },
        rendererRead: "completed",
      });
      expect(publicText).not.toContain("private-synthetic");
      expect(
        JSON.parse(await fs.readFile(path.join(capture, "failure.private.json"), "utf8")),
      ).toMatchObject({
        failure: { message: "private-synthetic-new-session-failure" },
        screenshot: "failure.private.png",
      });
      expect((await fs.stat(path.join(capture, "failure.private.png"))).size).toBeGreaterThan(0);
    } finally {
      if (joined) {
        await fs.rm(root, { recursive: true, force: true });
      } else {
        console.warn(`Retained unjoined New Session fixture: ${root}`);
      }
    }
  });
  context.onTestFinished(() => run);
  return run;
});

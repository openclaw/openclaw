import {
  defineConfig,
  type TestProjectInlineConfiguration,
  type TestUserConfig,
} from "vitest/config";
import { intersectIncludePatterns } from "./vitest.include-patterns.ts";
import { matchesVitestGlob } from "./vitest.pattern-file.ts";
import { createUiE2eVitestConfig } from "./vitest.ui-e2e.config.ts";
import { uiE2eRealGatewayTestFiles } from "./vitest.ui-paths.mjs";

// New real-Gateway files stay serial until their shared readers/writers are audited.
// Listed fixtures own their HOME, state, ports, and cleanup; UI bytes are either
// borrowed from the invocation preview or read by their prepared Gateway child.
const parallelFiles = new Set([
  "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-composer-websearch-kill-switch.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-flow.catalog-bootstrap.e2e.test.ts",
  "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-project-media.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-reconnect-continuity.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-stop-finished-run.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-thinking-metadata.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
  "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
  "ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
  "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
  "ui/src/e2e/device-alias-rename.real-gateway.e2e.test.ts",
  "ui/src/e2e/logs-lifecycle.e2e.test.ts",
  "ui/src/e2e/model-api-keys.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-catalog-partial-refresh.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-picker-search.real-gateway.e2e.test.ts",
  "ui/src/e2e/profile-page.real-gateway.e2e.test.ts",
  "ui/src/e2e/quota-reset-status.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-progress-hovercard.real-gateway.e2e.test.ts",
  "ui/src/e2e/usage-sessions-owner-attribution.e2e.test.ts",
  "ui/src/e2e/worker-initial-setup.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
]);

export function createPrebuiltUiE2eVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const base = createUiE2eVitestConfig(env, argv);
  const include =
    intersectIncludePatterns(
      uiE2eRealGatewayTestFiles,
      base.test?.include ?? [],
      matchesVitestGlob,
    ) ?? [];
  const project = (name: string) => {
    const selected = base.test?.projects?.find(
      (candidate): candidate is TestProjectInlineConfiguration & { test: TestUserConfig } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "test" in candidate &&
        candidate.test?.name === name,
    );
    if (!selected) {
      throw new Error(`Prebuilt UI E2E requires canonical project ${name}`);
    }
    return selected;
  };
  const projects = ["ui-e2e-serial", "ui-e2e-serial-standalone"].flatMap((name) => {
    const template = project(name);
    const files =
      intersectIncludePatterns(include, template.test.include ?? [], matchesVitestGlob) ?? [];
    const globalSetup = [
      "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts",
      ...[template.test.globalSetup ?? []].flat(),
    ];
    return [
      {
        ...template,
        test: {
          ...template.test,
          globalSetup,
          include: files.filter((file) => !parallelFiles.has(file)),
        },
      },
      {
        ...template,
        cacheDir: template.cacheDir?.replace("serial", "real-gateway"),
        test: {
          ...template.test,
          globalSetup,
          include: files.filter((file) => parallelFiles.has(file)),
          name: name.replace("serial", "real-gateway"),
          fileParallelism: true,
          // Both later projects share Vitest's one root-bounded worker pool.
          maxWorkers: undefined,
          sequence: { ...template.test.sequence, groupOrder: 2 },
        },
      },
    ];
  });
  return defineConfig({ ...base, test: { ...base.test, include, projects } });
}

export default createPrebuiltUiE2eVitestConfig();

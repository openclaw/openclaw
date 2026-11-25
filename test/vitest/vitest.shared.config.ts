import fs from "node:fs";
import path from "node:path";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { controlUiSolidPlugin } from "../../ui/config/control-ui-solid.ts";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  BUNDLED_PLUGIN_TEST_GLOB,
} from "./vitest.bundled-plugin-paths.ts";
import { createVitestDeclaredInputsPlugin } from "./vitest.declared-inputs.ts";
import { nodeVitestConfig, repoRoot, resolveRepoRootPath } from "./vitest.node-base.ts";
import { sharedVitestExcludePatterns } from "./vitest.pattern-file.ts";
import { createVitestResolveConfig } from "./vitest.resolve.ts";
import { compiledSubprocessesPlugin } from "./vitest.worker-artifacts.ts";

export {
  repoRoot,
  resolveRepoRootPath,
  resolveSharedVitestWorkerConfig,
} from "./vitest.node-base.ts";
export type { LocalVitestScheduling } from "./vitest.node-base.ts";
export const nonIsolatedRunnerPath = path.join(repoRoot, "test", "non-isolated-runner.ts");
const vitestConfigFiles = fs
  .readdirSync(path.join(repoRoot, "test", "vitest"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:mjs|mts|ts)$/u.test(entry.name))
  .map((entry) => `test/vitest/${entry.name}`)
  .toSorted((left, right) => left.localeCompare(right));

export const sharedVitestConfig = {
  ...nodeVitestConfig,
  plugins: [
    ...nodeVitestConfig.plugins,
    // Node tests also import UI renderers. Keep their compiler off non-UI sources.
    ...controlUiSolidPlugin([
      `${repoRoot.replaceAll("\\", "/")}/ui/**/*.tsx`,
      `${repoRoot.replaceAll("\\", "/")}/extensions/*/browser/**/*.tsx`,
      `${repoRoot.replaceAll("\\", "/")}/extensions/*/src/control-ui.tsx`,
    ]),
    createStateSchemaInlinePlugin(repoRoot),
    createVitestDeclaredInputsPlugin(repoRoot),
    compiledSubprocessesPlugin(),
  ],
  resolve: createVitestResolveConfig(repoRoot),
  test: {
    ...nodeVitestConfig.test,
    runner: nonIsolatedRunnerPath,
    // Vitest matches these with picomatch against absolute changed-file paths, so every entry
    // must resolve absolute; relative entries silently never match. Explicit lane files keep
    // watcher registration working (chokidar v4+ ignores globs in watcher.add) while the glob
    // keeps match coverage for files added after config load.
    forceRerunTriggers: [
      "package.json",
      "pnpm-lock.yaml",
      "vitest.config.ts",
      "test/setup.ts",
      "test/setup.env.ts",
      "test/setup.shared.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
      ...vitestConfigFiles,
      "test/vitest/**/*.{ts,mts,mjs}",
    ].map(resolveRepoRootPath),
    include: [
      "src/**/*.test.ts",
      BUNDLED_PLUGIN_TEST_GLOB,
      "packages/**/*.test.ts",
      "test/**/*.test.ts",
      "ui/src/pages/chat/tool-stream.node.test.ts",
    ],
    setupFiles: [resolveRepoRootPath("test/setup.ts")],
    exclude: [...sharedVitestExcludePatterns],
    coverage: {
      provider: "v8" as const,
      reporter: ["text", "lcov"],
      all: false,
      exclude: [
        `${BUNDLED_PLUGIN_ROOT_DIR}/**`,
        "apps/**",
        "ui/**",
        "test/**",
        "src/**/*.test.ts",
        "src/entry.ts",
        "src/index.ts",
        "src/runtime.ts",
        "src/logging.ts",
        "src/cli/**",
        "src/commands/**",
        "src/daemon/**",
        "src/hooks/**",
        "src/macos/**",
        "src/acp/**",
        "src/agents/**",
        "src/channels/**",
        "src/gateway/**",
        "src/line/**",
        "src/media-understanding/**",
        "src/node-host/**",
        "src/plugins/**",
        "src/providers/**",
        "src/secrets/**",
        "src/agents/model-scan.ts",
        "src/agents/embedded-agent-runner.ts",
        "src/agents/sandbox-paths.ts",
        "src/agents/sandbox.ts",
        "src/agents/agent-tool-definition-adapter.ts",
        "src/agents/tools/discord-actions*.ts",
        "src/infra/update-check.ts",
        "src/infra/ports-inspect.ts",
        "src/infra/outbound/outbound-session.ts",
        "src/gateway/control-ui.ts",
        "src/gateway/server-channels.ts",
        "src/gateway/server-methods/config.ts",
        "src/gateway/server-methods/send.ts",
        "src/gateway/server-methods/skills.ts",
        "src/gateway/talk/handlers/index.ts",
        "src/gateway/server-methods/web.ts",
        "src/gateway/server-methods/wizard.ts",
        "src/gateway/call.ts",
        "src/process/exec.ts",
        "src/tui/**",
        "src/wizard/**",
        "src/browser/**",
        "src/webchat/**",
        "src/gateway/server.ts",
        "src/gateway/client.ts",
        "packages/gateway-protocol/src/**",
        "src/infra/tailscale.ts",
      ],
    },
  },
};

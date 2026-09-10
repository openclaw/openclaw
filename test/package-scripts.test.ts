// Package script tests validate root package script invariants.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parseBuildAllArgs, resolveBuildAllSteps } from "../scripts/build-all.mts";
import { detectChangedScope } from "../scripts/ci-changed-scope.mjs";

type RootPackageJson = {
  scripts: Record<string, string>;
};

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const NODE_OPTIONS_WITH_VALUE = new Set([
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--import",
  "--loader",
  "--max-old-space-size",
  "--require",
  "--test-name-pattern",
  "--test-reporter",
  "-C",
  "-r",
]);

function readPackageJson(): RootPackageJson {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as RootPackageJson;
}

function readWindowsCiPartScripts(): [string, string] {
  const scripts = readPackageJson().scripts;
  return [
    expectDefined(scripts["test:windows:ci:1"], "Windows CI part 1 script"),
    expectDefined(scripts["test:windows:ci:2"], "Windows CI part 2 script"),
  ];
}

function readWindowsCiCoverageScript(): string {
  return readWindowsCiPartScripts().join(" ");
}

function readProjectTestTargets(script: string): string[] {
  const tokens = tokenizeCommand(script);
  const runnerIndex = tokens.indexOf("scripts/test-projects.mts");
  return runnerIndex < 0 ? [] : tokens.slice(runnerIndex + 1);
}

function tokenizeCommand(command: string): string[] {
  return (
    command
      .match(/"[^"]*"|'[^']*'|[^\s]+/gu)
      ?.map((token) => token.replace(/^(['"])(.*)\1$/u, "$2")) ?? []
  );
}

function extractNodeScriptTargets(script: string): string[] {
  return script.split(/\s*(?:&&|\|\||;)\s*/u).flatMap((command) => {
    const tokens = tokenizeCommand(command);
    let index = tokens[0] === "env" ? 1 : 0;

    while (ENV_ASSIGNMENT_RE.test(tokens[index] ?? "")) {
      index += 1;
    }

    if (tokens[index] !== "node") {
      return [];
    }

    for (let tokenIndex = index + 1; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      if (!token) {
        continue;
      }
      if (token.startsWith("scripts/")) {
        return [token];
      }
      if (token === "--") {
        continue;
      }
      if (token.startsWith("--") && token.includes("=")) {
        continue;
      }
      if (NODE_OPTIONS_WITH_VALUE.has(token)) {
        tokenIndex += 1;
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }

      return [];
    }

    return [];
  });
}

describe("package scripts", () => {
  it("finds node script targets after env assignments and valued node options", () => {
    expect(
      extractNodeScriptTargets(
        "FOO=1 node --import ./scripts/tsx.mjs scripts/release-check.ts && node --max-old-space-size=8192 --import ./scripts/tsx.mjs scripts/plugin-sdk-surface-report.mts && env BAR=1 node -r ./preload.cjs scripts/check.ts",
      ),
    ).toEqual([
      "scripts/release-check.ts",
      "scripts/plugin-sdk-surface-report.mts",
      "scripts/check.ts",
    ]);
  });

  it("keeps direct node script targets present in the source checkout", () => {
    const packageJson = readPackageJson();
    const missingTargets = Object.entries(packageJson.scripts).flatMap(([name, script]) =>
      extractNodeScriptTargets(script)
        .filter((target) => !fs.existsSync(target))
        .map((target) => `${name}: ${target}`),
    );

    expect(missingTargets).toEqual([]);
  });

  it("keeps direct Node package scripts off POSIX-only env assignment prefixes", () => {
    const packageJson = readPackageJson();
    const directNodeEnvScripts = Object.entries(packageJson.scripts).flatMap(([name, script]) =>
      script
        .split(/\s*(?:&&|\|\||;)\s*/u)
        .filter((command) => {
          const tokens = tokenizeCommand(command);
          let index = tokens[0] === "env" ? 1 : 0;
          const hasEnvPrefix = ENV_ASSIGNMENT_RE.test(tokens[index] ?? "");
          while (ENV_ASSIGNMENT_RE.test(tokens[index] ?? "")) {
            index += 1;
          }
          return hasEnvPrefix && tokens[index] === "node";
        })
        .map((command) => `${name}: ${command}`),
    );

    expect(directNodeEnvScripts).toEqual([]);
  });

  it.each([{ scriptName: "build:docker", expectedCount: 2 }])(
    "runs TypeScript steps in $scriptName through the tooling bootstrap",
    ({ scriptName, expectedCount }) => {
      const script = expectDefined(
        readPackageJson().scripts[scriptName],
        `package script ${scriptName}`,
      );

      expect(script).not.toContain("--experimental-strip-types");
      expect(
        script.match(/node --import \.\/scripts\/tsx\.mjs scripts\/[^\s]+\.ts(?=\s|$)/gu),
      ).toHaveLength(expectedCount);
    },
  );

  it("enables live cache validation in the package script", () => {
    expect(readPackageJson().scripts["test:live:cache"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/run-with-env.mts OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 -- node --import ./scripts/tsx.mjs scripts/check-live-cache.ts",
    );
  });

  it("builds runtime artifacts before browser bootstrap E2E against real Chromium", () => {
    expect(readPackageJson().scripts["test:e2e:browser-extension"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime && node --import ./scripts/tsx.mjs scripts/run-with-env.mts PLAYWRIGHT_BROWSERS_PATH=.artifacts/playwright-browsers -- node --import ./scripts/tsx.mjs scripts/ensure-playwright-chromium.mts --require-playwright-chromium && node --import ./scripts/tsx.mjs scripts/run-with-env.mts PLAYWRIGHT_BROWSERS_PATH=.artifacts/playwright-browsers OPENCLAW_BROWSER_EXTENSION_E2E=1 OPENCLAW_E2E_WORKERS=1 -- node scripts/run-vitest.mjs extensions/browser/chrome-extension/bootstrap.chromium.test.ts",
    );
  });

  it("gives the plugin SDK usage scan enough heap for repository-wide analysis", () => {
    expect(readPackageJson().scripts["plugin-sdk:usage"]).toBe(
      "node --max-old-space-size=8192 --import ./scripts/tsx.mjs scripts/analyze-plugin-sdk-usage.ts",
    );
  });

  it("runs dead-code reports fail-fast", () => {
    expect(readPackageJson().scripts["deadcode:report"]).toBe(
      "pnpm deadcode:full && pnpm deadcode:exports",
    );
  });

  it.each(["build:strict-smoke", "build:plugin-sdk:strict-smoke"])(
    "%s publishes canonical declarations before strict export checks",
    (scriptName) => {
      const script = expectDefined(readPackageJson().scripts[scriptName], scriptName);
      const tokens = tokenizeCommand(script);
      const buildAllIndex = tokens.indexOf("scripts/build-all.mts");
      const targets =
        buildAllIndex < 0
          ? extractNodeScriptTargets(script)
          : resolveBuildAllSteps(parseBuildAllArgs(tokens.slice(buildAllIndex + 1)).profile)
              .filter((step) => step.kind !== "pnpm")
              .flatMap((step) => extractNodeScriptTargets(["node", ...step.args].join(" ")));
      const check = targets.indexOf("scripts/check-plugin-sdk-exports.mts");

      expect(check).toBeGreaterThanOrEqual(0);
      for (const prerequisite of [
        "scripts/runtime-postbuild.mjs",
        "scripts/write-plugin-sdk-entry-dts.ts",
      ]) {
        const publication = targets.indexOf(prerequisite);
        expect(publication, prerequisite).toBeGreaterThanOrEqual(0);
        expect(publication, prerequisite).toBeLessThan(check);
      }
    },
  );

  it("builds generated plugin assets before Docker runtime postbuild", () => {
    const commands = expectDefined(
      readPackageJson().scripts["build:docker"],
      "package script build:docker",
    ).split(" && ");

    const assets = commands.indexOf("pnpm plugins:assets:build");
    const postbuild = commands.indexOf("node scripts/runtime-postbuild.mjs");
    expect(assets).toBeGreaterThanOrEqual(0);
    expect(postbuild).toBeGreaterThanOrEqual(0);
    expect(assets).toBeLessThan(postbuild);
  });

  it("cleans package builds before validating release contents", () => {
    const scripts = readPackageJson().scripts;

    expect(scripts["build:package"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/build-all.mts package",
    );
    expect(scripts["release:check"]).toBe(
      "pnpm build:package && pnpm release:generated:check && node --import ./scripts/tsx.mjs scripts/release-check.ts",
    );
  });

  it("uses the shipped package launcher for npm start", () => {
    expect(readPackageJson().scripts.start).toBe("node openclaw.mjs");
  });

  it("builds iOS against a generic simulator by default", () => {
    const script = readPackageJson().scripts["ios:build"];

    expect(script).toContain("${IOS_DEST:-generic/platform=iOS Simulator}");
    expect(script).not.toContain("name=iPhone");
  });

  it("keeps the Wear app in the root Android contributor gates", () => {
    const scripts = readPackageJson().scripts;

    expect(scripts["android:assemble"]).toContain(":wear:assembleDebug");
    expect(scripts["android:format"]).toContain(":wear:ktlintFormat");
    expect(scripts["android:lint"]).toContain(":wear:ktlintCheck");
    expect(scripts["android:lint:android"]).toContain(":wear:lintDebug");
    expect(scripts["android:test"]).toContain(":wear:testDebugUnitTest");
  });

  it("routes every declared Windows CI test to its native lane", () => {
    const missedTargets = readWindowsCiPartScripts()
      .flatMap(readProjectTestTargets)
      .filter((target) => !detectChangedScope([target]).runWindows);
    expect(missedTargets).toEqual([]);
  });

  it.for([
    { platform: "windows", parts: [1, 2] },
    { platform: "macos", parts: [1, 2, 3] },
  ])(
    "partitions $platform CI coverage into disjoint explicit test lists",
    ({ platform, parts }) => {
      const scripts = readPackageJson().scripts;
      const partScripts = parts.map((part) =>
        expectDefined(scripts[`test:${platform}:ci:${part}`], `${platform} CI part ${part}`),
      );
      const partTargets = partScripts.map(readProjectTestTargets);

      expect(scripts[`test:${platform}:ci`]).toBe(
        parts.map((part) => `pnpm test:${platform}:ci:${part}`).join(" && "),
      );
      expect(scripts[`test:${platform}:ci:${parts.length + 1}`]).toBeUndefined();
      for (const [partIndex, targets] of partTargets.entries()) {
        expect(targets.length).toBeGreaterThan(0);
        expect(
          targets.every((target) => target.endsWith(".test.ts") && fs.existsSync(target)),
        ).toBe(true);
        const laterTargets = new Set(partTargets.slice(partIndex + 1).flat());
        expect(
          targets.filter((target) => laterTargets.has(target)),
          `${platform} CI part ${partIndex + 1} overlaps a later part`,
        ).toEqual([]);
      }
    },
  );

  it("keeps required native coverage in Windows CI", () => {
    const requiredTargets = [
      "src/node-host/node-worker-transfer-client.test.ts",
      "test/scripts/format-generated-module.test.ts",
      "test/scripts/direct-run-entrypoints.test.ts",
      "test/scripts/vitest-worker-artifacts.test.ts",
      "test/scripts/vitest-worker-artifacts.transforms.test.ts",
      "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts",
      "src/commands/doctor-gateway-auth-token.windows.test.ts",
      "src/infra/state-migrations.legacy-session-store.test.ts",
      "src/infra/sqlite-snapshot.test.ts",
      "src/state/openclaw-state-ownership.test.ts",
      "src/media/local-media-path.windows.test.ts",
      "src/auto-reply/reply.triggers.trigger-handling.stages-inbound-media-into-sandbox-workspace.test.ts",
      "src/infra/ssh-client.windows.test.ts",
      "src/infra/ports.test.ts",
      "src/infra/advertised-lan-host.windows.test.ts",
      "src/test-utils/openclaw-test-state.test.ts",
      "src/snapshot/local-repository.windows.test.ts",
      "src/commands/backup-verify.test.ts",
      "src/config/sessions/session-accessor.sqlite-archive.worker.test.ts",
      "test/scripts/openclaw-cross-os-installer.windows.test.ts",
      "test/scripts/run-with-env.test.ts",
      "test/scripts/ts-topology.test.ts",
      "extensions/mxc/test/mxc-backend.test.ts",
      "extensions/mxc/test/sandbox-policy-loader.test.ts",
      "src/agents/bash-tools.exec.script-preflight.test.ts",
      "src/infra/exec-allowlist-pattern.test.ts",
      "src/infra/executable-path.test.ts",
      "src/plugin-sdk/node-host.test.ts",
      "src/process/terminal-pty.test.ts",
      "src/tui/tui.resolve-codex-bin.test.ts",
      "src/infra/fs-safe-remove.test.ts",
      "src/agents/tools/media-tool-file-url.windows.test.ts",
      "src/media/web-media.file-url.windows.test.ts",
      "extensions/msteams/src/media-helpers.test.ts",
      "extensions/msteams/src/messenger.test.ts",
      "src/auto-reply/usage-bar/template.windows.test.ts",
      "src/media-understanding/attachments.file-url.windows.test.ts",
      "src/utils.test.ts",
      "src/commands/agents.commands.list.test.ts",
      "src/cli/daemon-cli/status.print.test.ts",
      "packages/terminal-core/src/display-string.test.ts",
      "src/agents/sandbox/fs-paths.test.ts",
      "src/agents/sessions/tools/render-utils.test.ts",
      "src/agents/agent-tools.read.windows.test.ts",
      "src/agents/agent-tools.read.host-operations.test.ts",
      "src/agents/sessions/tools/path-utils.test.ts",
      "src/agents/provider-local-service.env-case.test.ts",
      "src/infra/process-env.test.ts",
      "src/cli/mcp-cli.path-case.windows.test.ts",
      "extensions/memory-core/src/memory-extra-file-path.windows.test.ts",
    ];
    const actualTargets = new Set(readWindowsCiPartScripts().flatMap(readProjectTestTargets));

    expect(requiredTargets.filter((target) => !actualTargets.has(target))).toEqual([]);
  });

  it("keeps the native Scheduled Task lifecycle proof opt-in", () => {
    const scripts = readPackageJson().scripts;

    expect(readWindowsCiCoverageScript()).not.toContain("schtasks.integration.e2e.test.ts");
    expect(scripts["test:windows:schtasks:integration"]).toContain(
      "CI_WINDOWS_SCHTASKS_INTEGRATION=1",
    );
    expect(scripts["test:windows:schtasks:integration"]).toContain(
      "src/daemon/schtasks.integration.e2e.test.ts",
    );
  });

  it("runs cross-OS installer behavior coverage in Windows CI", () => {
    expect(
      readWindowsCiPartScripts()
        .flatMap(readProjectTestTargets)
        .filter((target) => target === "test/scripts/install-ps1.test.ts"),
    ).toHaveLength(1);
  });
});

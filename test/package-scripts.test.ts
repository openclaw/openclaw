// Package script tests validate root package script invariants.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
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

  it("runs live cache validation through the shared live runtime selector", () => {
    expect(readPackageJson().scripts["test:live:cache"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/run-with-env.mts OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 -- node --import ./scripts/tsx.mjs scripts/test-live.mts src/agents/live-cache-regression.live.test.ts",
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
});

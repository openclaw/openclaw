import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectMinimalRuntimeProfileReport,
  runMinimalRuntimeProfileCheck,
} from "../../scripts/check-openclaw-minimal-runtime-profile.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

async function writeFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function createMinimalRuntimeProfile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: "openclaw-minimal-runtime",
    mode: "local-offline",
    requiredSurfaces: [
      { id: "gateway", kind: "runtime", path: "src/gateway" },
      { id: "session", kind: "runtime", path: "src/config/sessions" },
      { id: "diagnostics", kind: "runtime", path: "src/infra/diagnostic-events.ts" },
      {
        id: "controlled-runner",
        kind: "automation",
        path: "scripts/openclaw-controlled-task-runner.mjs",
      },
    ],
    disabledExternalSurfaces: [
      "browser-control",
      "global-codex-skills",
      "live-model-api",
      "live-trading",
      "message-channels",
    ],
    runtimeEnv: {
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
    },
    safety: {
      externalApi: false,
      globalSkillDependency: false,
      liveTrading: false,
      writesOutsideRepo: false,
    },
    validation: [
      "node scripts/check-openclaw-minimal-runtime-profile.mjs --check",
      "pnpm autonomous:inventory:check",
    ],
    ...overrides,
  };
}

async function createPassingFixture(rootDir: string): Promise<void> {
  for (const relativeDir of ["src/gateway", "src/config/sessions"]) {
    await fs.mkdir(path.join(rootDir, relativeDir), { recursive: true });
  }
  await writeFile(rootDir, "src/infra/diagnostic-events.ts", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-controlled-task-runner.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "config/openclaw-minimal-runtime-profile.json",
    JSON.stringify(createMinimalRuntimeProfile(), null, 2),
  );
}

describe("check-openclaw-minimal-runtime-profile", () => {
  it("passes for an offline minimal runtime profile", async () => {
    const rootDir = createTempDir("openclaw-minimal-runtime-profile-pass-");
    await createPassingFixture(rootDir);

    const report = await collectMinimalRuntimeProfileReport({ repoRoot: rootDir });

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails when external API access is allowed", async () => {
    const rootDir = createTempDir("openclaw-minimal-runtime-profile-external-api-");
    await createPassingFixture(rootDir);
    await writeFile(
      rootDir,
      "config/openclaw-minimal-runtime-profile.json",
      JSON.stringify(
        createMinimalRuntimeProfile({
          safety: {
            externalApi: true,
            globalSkillDependency: false,
            liveTrading: false,
            writesOutsideRepo: false,
          },
        }),
        null,
        2,
      ),
    );

    const report = await collectMinimalRuntimeProfileReport({ repoRoot: rootDir });
    const safetyCheck = report.checks.find((check) => check.id === "safety-externalApi");

    expect(report.ok).toBe(false);
    expect(safetyCheck?.status).toBe("fail");
  });

  it("fails when global skill dependency is not explicitly disabled", async () => {
    const rootDir = createTempDir("openclaw-minimal-runtime-profile-global-skill-");
    await createPassingFixture(rootDir);
    await writeFile(
      rootDir,
      "config/openclaw-minimal-runtime-profile.json",
      JSON.stringify(
        createMinimalRuntimeProfile({
          disabledExternalSurfaces: ["browser-control", "live-model-api", "live-trading"],
        }),
        null,
        2,
      ),
    );

    const report = await collectMinimalRuntimeProfileReport({ repoRoot: rootDir });
    const globalSkillCheck = report.checks.find(
      (check) => check.id === "disabled-global-codex-skills",
    );

    expect(report.ok).toBe(false);
    expect(globalSkillCheck?.status).toBe("fail");
  });

  it("returns non-zero in check mode when the profile is invalid", async () => {
    const rootDir = createTempDir("openclaw-minimal-runtime-profile-check-fail-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "src/gateway"), { recursive: true });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runMinimalRuntimeProfileCheck({
      repoRoot: rootDir,
      io: {
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toContain("[FAIL] surface-gateway");
    expect(stderr.join("")).toContain("minimal runtime profile check failed");
  });
});

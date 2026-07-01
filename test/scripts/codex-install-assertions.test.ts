// Codex Install Assertions tests cover Codex plugin install E2E helpers.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPathInside,
  findPackageJson,
  npmProjectRootForInstalledPackage,
} from "../../scripts/e2e/lib/codex-install-utils.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/codex-on-demand/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
const tempDirs: string[] = [];
const tmpFixtureFiles = ["/tmp/openclaw-codex-inspect.json", "/tmp/openclaw-plugins-list.json"];

afterEach(() => {
  for (const file of tmpFixtureFiles) {
    rmSync(file, { force: true });
  }
  cleanupTempDirs(tempDirs);
});

function nodeOptionsWithoutExperimentalWarnings(): string {
  const current = process.env.NODE_OPTIONS ?? "";
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeAuthProfileStoreSqlite(agentDir: string) {
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO auth_profile_store (store_key, store_json, updated_at)
        VALUES (?, ?, ?)
      `,
    ).run(
      "primary",
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      }),
      Date.now(),
    );
  } finally {
    db.close();
  }
}

function runCodexOnDemandAssertions(root: string) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    },
  });
}

function createCodexInstallFixture(root: string) {
  const stateDir = path.join(root, "state");
  const npmRoot = path.join(stateDir, "npm");
  const installPath = path.join(npmRoot, "projects", "codex", "node_modules", "@openclaw", "codex");
  const projectRoot = npmProjectRootForInstalledPackage(installPath, "@openclaw/codex");
  writeJson(path.join(installPath, "package.json"), { name: "@openclaw/codex" });
  const openAiCodexRoot = path.join(projectRoot, "node_modules", "@openai", "codex");
  writeJson(path.join(openAiCodexRoot, "package.json"), {
    name: "@openai/codex",
    bin: { codex: "bin/codex.js" },
  });
  const codexBin = path.join(openAiCodexRoot, "bin", "codex.js");
  mkdirSync(path.dirname(codexBin), { recursive: true });
  writeFileSync(codexBin, "#!/usr/bin/env node\n", { mode: 0o755 });
  chmodSync(codexBin, 0o755);
  writeJson(path.join(stateDir, "openclaw.json"), {
    agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    models: { providers: { openai: { agentRuntime: { id: "codex" } } } },
    plugins: {
      installs: {
        codex: {
          installPath,
          source: "npm",
          spec: "npm:@openclaw/codex",
        },
      },
    },
  });
  writeJson("/tmp/openclaw-codex-inspect.json", {
    plugin: { id: "codex", status: "loaded", agentHarnessIds: ["codex"] },
  });
  writeJson("/tmp/openclaw-plugins-list.json", {
    plugins: [{ id: "codex", enabled: true, status: "loaded" }],
  });
  writeAuthProfileStoreSqlite(path.join(stateDir, "agents", "main", "agent"));
}

describe("Codex install helpers", () => {
  it("resolves package roots and package manifests inside managed npm installs", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-install-utils-");
    const packageRoot = path.join(
      root,
      "state",
      "npm",
      "projects",
      "codex",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const projectRoot = npmProjectRootForInstalledPackage(packageRoot, "@openclaw/codex");
    const dependencyPackage = path.join(
      projectRoot,
      "node_modules",
      "@openai",
      "codex",
      "package.json",
    );
    writeJson(dependencyPackage, { name: "@openai/codex" });

    expect(projectRoot).toBe(path.join(root, "state", "npm", "projects", "codex"));
    expect(findPackageJson("@openai/codex", [packageRoot, projectRoot])).toBe(dependencyPackage);
    expect(() =>
      assertPathInside(projectRoot, dependencyPackage, "codex dependency"),
    ).not.toThrow();
    expect(() => assertPathInside(projectRoot, os.tmpdir(), "outside path")).toThrow(
      "outside path resolved outside",
    );
  });

  it("accepts a complete on-demand Codex npm install fixture", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-");
    createCodexInstallFixture(root);

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects on-demand fixtures missing the managed @openai/codex dependency", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-missing-");
    createCodexInstallFixture(root);
    rmSync(path.join(root, "state", "npm", "projects", "codex", "node_modules", "@openai"), {
      force: true,
      recursive: true,
    });

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing @openai/codex dependency under managed npm root");
  });

  it("rejects on-demand fixtures missing the managed Codex executable", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-missing-bin-");
    createCodexInstallFixture(root);
    rmSync(
      path.join(
        root,
        "state",
        "npm",
        "projects",
        "codex",
        "node_modules",
        "@openai",
        "codex",
        "bin",
      ),
      { force: true, recursive: true },
    );

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing managed Codex binary:");
  });
});

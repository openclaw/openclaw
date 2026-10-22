import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSON5 from "json5";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeHookFixture } from "./hook-fixture.test-support.js";
import { installHooksFromPath } from "./install.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hookName = "qa-lifecycle-recorder";
const hookMarker = "QA_HOOK_LIFECYCLE_OK";

afterEach(clearInternalHooks);

async function runHooksCli(args: string[], env: NodeJS.ProcessEnv) {
  try {
    return await execFileAsync(process.execPath, ["openclaw.mjs", "hooks", ...args], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 90_000,
    });
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${failed.message}\nstdout:\n${failed.stdout ?? ""}\nstderr:\n${failed.stderr ?? ""}`,
      { cause: error },
    );
  }
}

it("installs, discovers, toggles, and dispatches an authored hook pack", async () => {
  const rootDir = tempDirs.make("openclaw-hooks-lifecycle-e2e-");
  const homeDir = path.join(rootDir, "home");
  const stateDir = path.join(rootDir, "state");
  const workspaceDir = path.join(rootDir, "workspace");
  const managedHooksDir = path.join(stateDir, "hooks");
  const bundledHooksDir = path.join(rootDir, "bundled-hooks");
  const packageRoot = path.join(rootDir, "archive-root");
  const packageDir = path.join(packageRoot, "package");
  const hookDir = path.join(packageDir, "hooks", hookName);
  const archivePath = path.join(rootDir, "qa-lifecycle-hooks.tgz");
  const configPath = path.join(stateDir, "openclaw.json");

  await Promise.all(
    [homeDir, stateDir, workspaceDir, bundledHooksDir, packageDir].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  const initialConfig: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    hooks: { internal: { enabled: true } },
  };
  await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/qa-lifecycle-hooks",
      version: "1.0.0",
      openclaw: { hooks: [`./hooks/${hookName}`] },
    }),
    "utf8",
  );
  writeHookFixture(
    hookDir,
    `---\nname: ${hookName}\ndescription: Records a Gateway startup lifecycle event\nmetadata: {"openclaw":{"events":["gateway:startup"]}}\n---\n\n# QA lifecycle recorder\n`,
    `export default async function recordLifecycle(event) { event.messages.push("${hookMarker}"); }\n`,
    "handler.js",
  );
  await tar.c({ cwd: packageRoot, file: archivePath, gzip: true }, ["package"]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
    VITEST: "",
  };

  const options = { bundledHooksDir, managedHooksDir };
  const install = await installHooksFromPath({
    config: initialConfig,
    hooksDir: managedHooksDir,
    path: archivePath,
  });
  expect(install).toMatchObject({
    ok: true,
    hookPackId: "qa-lifecycle-hooks",
    hooks: [hookName],
    packageKind: "hook-only",
  });
  if (!install.ok) {
    throw new Error(install.error);
  }

  await expect(
    fs.readFile(path.join(install.targetDir, "hooks", hookName, "HOOK.md"), "utf8"),
  ).resolves.toContain("gateway:startup");

  const discovered = loadWorkspaceHookEntries(workspaceDir, {
    ...options,
    config: initialConfig,
  });
  expect(discovered).toEqual([
    expect.objectContaining({
      hook: expect.objectContaining({ name: hookName, source: "openclaw-managed" }),
      metadata: expect.objectContaining({ events: ["gateway:startup"] }),
    }),
  ]);

  for (const enabled of [false, true]) {
    const result = await runHooksCli([enabled ? "enable" : "disable", hookName], env);
    expect(result.stdout).toContain(hookName);
    const config: OpenClawConfig = JSON5.parse(await fs.readFile(configPath, "utf8"));
    expect(config.hooks?.internal?.entries?.[hookName]?.enabled).toBe(enabled);
    clearInternalHooks();
    const prepared = await prepareInternalHooks(config, workspaceDir, options);
    expect(prepared.loadedCount).toBe(enabled ? 1 : 0);
    prepared.commit();
    const event = createInternalHookEvent("gateway", "startup", "gateway:startup", {
      cfg: config,
      workspaceDir,
    });
    await triggerInternalHook(event);
    expect(event.messages.includes(hookMarker)).toBe(enabled);
  }
}, 180_000);

// Plugin Lifecycle Probe tests cover QA Lab plugin lifecycle evidence.
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { readPluginInstallRecords } from "../../../../scripts/e2e/lib/plugin-index-sqlite.mjs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-lifecycle-probe-"));
  tempDirs.push(dir);
  return dir;
}

type ProbeEnv = Pick<NodeJS.ProcessEnv, "HOME" | "OPENCLAW_CONFIG_PATH" | "OPENCLAW_STATE_DIR">;

function stateDir(env: ProbeEnv = process.env) {
  return env.OPENCLAW_STATE_DIR || path.join(env.HOME ?? os.homedir(), ".openclaw");
}

function configPath(env: ProbeEnv = process.env) {
  return env.OPENCLAW_CONFIG_PATH || path.join(stateDir(env), "openclaw.json");
}

function readJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readRequiredJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read JSON from ${file}: ${message}`, { cause: error });
  }
}

function records(env: ProbeEnv = process.env) {
  return readPluginInstallRecords({
    configPath: configPath(env),
    stateDir: stateDir(env),
  }) as Record<string, Record<string, unknown>>;
}

function recordFor(pluginId: string, env: ProbeEnv = process.env) {
  return records(env)[pluginId];
}

function config(env: ProbeEnv = process.env) {
  return readJson(configPath(env));
}

function requiredConfig(env: ProbeEnv = process.env) {
  return readRequiredJson(configPath(env));
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertVersion(pluginId: string, version: string, env: ProbeEnv = process.env) {
  const record = recordFor(pluginId, env);
  assertProbe(record, `install record missing for ${pluginId}`);
  assertProbe(record.source === "npm", `expected npm source for ${pluginId}, got ${record.source}`);
  assertProbe(
    record.resolvedVersion === version || record.version === version,
    `expected ${pluginId} record version ${version}, got ${JSON.stringify(record)}`,
  );
  assertProbe(record.installPath, `install path missing for ${pluginId}`);
  const packageJson = readJson(path.join(String(record.installPath), "package.json"));
  assertProbe(
    packageJson.version === version,
    `expected installed package version ${version}, got ${packageJson.version}`,
  );
}

function assertNpmProjectRoot(pluginId: string, packageName: string, env: ProbeEnv = process.env) {
  const record = recordFor(pluginId, env);
  assertProbe(record?.installPath, `install path missing for ${pluginId}`);
  const installPath = String(record.installPath);
  const relative = path.relative(path.join(stateDir(env), "npm", "projects"), installPath);
  assertProbe(
    !relative.startsWith("..") && !path.isAbsolute(relative),
    `install path outside npm projects: ${installPath}`,
  );
  const segments = relative.split(path.sep);
  const packageSegments = packageName.split("/");
  assertProbe(
    segments.length === 2 + packageSegments.length,
    `unexpected npm project install path: ${installPath}`,
  );
  assertProbe(Boolean(segments[0]), `missing npm project directory: ${installPath}`);
  assertProbe(
    segments[1] === "node_modules",
    `missing project node_modules segment: ${installPath}`,
  );
  for (let index = 0; index < packageSegments.length; index++) {
    assertProbe(
      segments[index + 2] === packageSegments[index],
      `package path mismatch: ${installPath}`,
    );
  }
  assertProbe(
    !fs.existsSync(path.join(stateDir(env), "npm", "node_modules", ...packageSegments)),
    `legacy flat npm install path exists for ${packageName}`,
  );
}

function assertInspectLoaded(pluginId: string, inspectPath: string | undefined) {
  assertProbe(inspectPath, "inspect JSON path is required");
  const inspect = readRequiredJson(inspectPath);
  const plugin = inspect.plugin as
    | { enabled?: boolean; id?: string; status?: string }
    | null
    | undefined;
  assertProbe(
    plugin?.id === pluginId,
    `expected inspected plugin id ${pluginId}, got ${plugin?.id}`,
  );
  assertProbe(plugin.enabled === true, `expected ${pluginId} inspect enabled=true`);
  assertProbe(
    plugin.status === "loaded",
    `expected ${pluginId} inspect status loaded, got ${plugin.status}`,
  );
}

function assertEnabled(pluginId: string, expectedRaw: string, env: ProbeEnv = process.env) {
  const expected = expectedRaw === "true";
  const cfg = config(env) as {
    plugins?: { entries?: Record<string, { enabled?: boolean }> };
  };
  const entry = cfg.plugins?.entries?.[pluginId];
  assertProbe(entry?.enabled === expected, `expected ${pluginId} enabled=${expected}`);
}

function installPath(pluginId: string, env: ProbeEnv = process.env) {
  const record = recordFor(pluginId, env);
  assertProbe(record?.installPath, `install path missing for ${pluginId}`);
  return String(record.installPath);
}

function assertUninstalled(pluginId: string, env: ProbeEnv = process.env) {
  const cfg = requiredConfig(env) as {
    plugins?: {
      allow?: string[];
      deny?: string[];
      entries?: Record<string, unknown>;
      load?: { paths?: unknown[] };
    };
  };
  const record = recordFor(pluginId, env);
  assertProbe(!record, `install record still present for ${pluginId}`);
  assertProbe(
    !cfg.plugins?.entries?.[pluginId],
    `plugin config entry still present for ${pluginId}`,
  );
  assertProbe(
    !(cfg.plugins?.allow ?? []).includes(pluginId),
    `allowlist still contains ${pluginId}`,
  );
  assertProbe(!(cfg.plugins?.deny ?? []).includes(pluginId), `denylist still contains ${pluginId}`);
  const loadPaths = cfg.plugins?.load?.paths ?? [];
  assertProbe(
    !loadPaths.some((entry) => String(entry).includes(pluginId)),
    `load path still references ${pluginId}: ${loadPaths.join(", ")}`,
  );
}

export async function runPluginLifecycleProbeCommand(
  args: readonly string[],
  env: ProbeEnv = process.env,
) {
  const [command, pluginId, arg] = args;
  assertProbe(pluginId, "plugin id is required");
  switch (command) {
    case "assert-version":
      assertProbe(arg, "expected version is required");
      assertVersion(pluginId, arg, env);
      return "";
    case "assert-npm-project-root":
      assertProbe(arg, "package name is required");
      assertNpmProjectRoot(pluginId, arg, env);
      return "";
    case "assert-inspect-loaded":
      assertInspectLoaded(pluginId, arg);
      return "";
    case "assert-enabled":
      assertProbe(arg, "expected enabled value is required");
      assertEnabled(pluginId, arg, env);
      return "";
    case "install-path":
      return installPath(pluginId, env);
    case "assert-uninstalled":
      assertUninstalled(pluginId, env);
      return "";
    default:
      throw new Error(`unknown plugin lifecycle matrix probe command: ${command ?? "<missing>"}`);
  }
}

const isProbeCli = process.argv[2] === "--probe";

if (isProbeCli) {
  try {
    const output = await runPluginLifecycleProbeCommand(process.argv.slice(3));
    if (output) {
      process.stdout.write(output);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const { afterEach, describe, expect, it } = await import("vitest");

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("plugin lifecycle matrix probe", () => {
    it("accepts inspect JSON for an enabled loaded plugin", async () => {
      const dir = makeTempDir();
      const inspectPath = path.join(dir, "inspect.json");
      writeFileSync(
        inspectPath,
        `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "loaded" } })}\n`,
        "utf8",
      );

      await expect(
        runPluginLifecycleProbeCommand(["assert-inspect-loaded", "lifecycle-claw", inspectPath]),
      ).resolves.toBe("");
    });

    it("rejects inspect JSON that does not prove the runtime loaded", async () => {
      const dir = makeTempDir();
      const inspectPath = path.join(dir, "inspect.json");
      writeFileSync(
        inspectPath,
        `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "pending" } })}\n`,
        "utf8",
      );

      await expect(
        runPluginLifecycleProbeCommand(["assert-inspect-loaded", "lifecycle-claw", inspectPath]),
      ).rejects.toThrow("expected lifecycle-claw inspect status loaded, got pending");
    });

    it("rejects missing inspect JSON instead of treating it as an empty object", async () => {
      const dir = makeTempDir();
      const inspectPath = path.join(dir, "missing.json");

      await expect(
        runPluginLifecycleProbeCommand(["assert-inspect-loaded", "lifecycle-claw", inspectPath]),
      ).rejects.toThrow(`failed to read JSON from ${inspectPath}`);
    });

    it("rejects unreadable config during uninstall proof", async () => {
      const dir = makeTempDir();
      const configFile = path.join(dir, ".openclaw", "openclaw.json");
      mkdirSync(path.dirname(configFile), { recursive: true });
      writeFileSync(configFile, "{ malformed\n", "utf8");

      await expect(
        runPluginLifecycleProbeCommand(["assert-uninstalled", "lifecycle-claw"], {
          HOME: dir,
          OPENCLAW_CONFIG_PATH: configFile,
        }),
      ).rejects.toThrow(`failed to read JSON from ${configFile}`);
    });
  });
}

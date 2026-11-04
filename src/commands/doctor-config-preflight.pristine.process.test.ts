import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  runIsolatedModuleScript,
} from "./doctor-config-preflight.process.test-support.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
function createRuntime(root: string, entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) {
  const prepared = resolveRuntimeWorkerUrl(entry);
  const compiled = prepared.pathname.endsWith(".js");
  const runtimeRoot = compiled
    ? createBuiltRuntime(root, fileURLToPath(new URL("../", prepared)))
    : createSourceRuntime(root);
  const sourceUrl = (relative: string) =>
    pathToFileURL(path.join(runtimeRoot, "src", relative)).href;
  const runtimeUrl = (target: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
    resolveRuntimeWorkerUrl({
      ...target,
      ...(compiled
        ? { root: runtimeRoot }
        : { currentModuleUrl: sourceUrl("commands/doctor-config-runtime.test-support.ts") }),
    }).href;
  const processEntrypointsUrl = compiled
    ? pathToFileURL(
        path.join(runtimeRoot, "dist/legacy-finalizer/src/infra/runtime-process-entrypoints.js"),
      ).href
    : null;
  return { runtimeRoot, sourceUrl, runtimeUrl, processEntrypointsUrl };
}
function childEnv(values: NodeJS.ProcessEnv, omitted: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ...values };
  for (const key of ["NODE_ENV", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID", ...omitted]) {
    delete env[key];
  }
  return env;
}
async function run(runtimeRoot: string, env: NodeJS.ProcessEnv, script: string) {
  const result = await runIsolatedModuleScript(env, script, { runtimeRoot, timeoutMs: 60_000 });
  const lines = result.stdout.split("\n").filter((line) => line.startsWith("__RESULT__"));
  expect(lines, `${result.stderr}\n${result.stdout}`).toHaveLength(1);
  return JSON.parse(lines[0]!.slice("__RESULT__".length));
}

it("leaves config and state absent on repeated readiness checks", async () => {
  const root = await fs.promises.realpath(tempDirs.make("openclaw-configless-checkpoint-"));
  const { runtimeRoot, runtimeUrl } = createRuntime(root, doctorConfigRuntimeEntrypoints.startup);
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const env = childEnv(
    {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    },
    ["OPENCLAW_HOME"],
  );

  const script = `
      const { runStartupConfigPreflight } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.startup))});
      const { hasActiveStartupMigrationLease } = await import(${JSON.stringify(runtimeUrl(doctorConfigRuntimeEntrypoints.checkpoint))});
      const result = await runStartupConfigPreflight({ gateway: false, observe: false });
      console.log("__RESULT__" + JSON.stringify({
        activeLease: hasActiveStartupMigrationLease({ env: process.env }),
        configExists: result.snapshot.exists,
      }));
    `;
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await run(runtimeRoot, env, script)).toEqual({
      activeLease: false,
      configExists: false,
    });
    expect([configPath, stateDir].map((target) => fs.existsSync(target))).toEqual([false, false]);
  }
}, 150_000);
describe("CLI readiness after early config observation", () => {
  let runtime: ReturnType<typeof createRuntime>;
  let runtimeTempDir: string;

  beforeAll(() => {
    const root = fs.realpathSync(tempDirs.make("openclaw-cli-pristine-runtime-"));
    runtime = createRuntime(root, doctorConfigRuntimeEntrypoints.preflight);
    runtimeTempDir = path.join(root, "tmp");
    fs.mkdirSync(runtimeTempDir);
  });

  it.each([false, true])(
    "preserves current config and observed health (state already exists: %s)",
    async (existingState) => {
      const { runtimeRoot, sourceUrl, processEntrypointsUrl } = runtime;
      const root = fs.realpathSync(tempDirs.make("openclaw-cli-pristine-observation-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const timelinePath = path.join(root, "timeline.jsonl");
      const configRaw = JSON.stringify({
        gateway: { mode: "local", port: 19876, auth: { mode: "token", token: "test-token" } },
        agents: { defaults: { workspace: path.join(root, "workspace") } },
        logging: { file: path.join(root, "openclaw.log") },
        plugins: { enabled: false },
      } satisfies OpenClawConfig);
      fs.writeFileSync(configPath, configRaw);
      const env = childEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DIAGNOSTICS: "1",
          OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
          OPENCLAW_HIDE_BANNER: "1",
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          XDG_STATE_HOME: path.join(root, "xdg-state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          TMPDIR: runtimeTempDir,
          TMP: runtimeTempDir,
          TEMP: runtimeTempDir,
        },
        [
          "OPENCLAW_PROFILE",
          "OPENCLAW_CONTAINER",
          "OPENCLAW_GATEWAY_URL",
          "OPENCLAW_GATEWAY_TOKEN",
          "OPENCLAW_GATEWAY_PASSWORD",
        ],
      );
      const rpcSource = `
      export * from ${JSON.stringify(sourceUrl("gateway/call.ts"))};
      export async function callGateway(options) {
        if (options.method !== "sessions.resolve") throw new Error("Unexpected RPC: " + options.method);
        globalThis[Symbol.for("openclaw.test.pristineStartupRpcCalls")].push({
          method: options.method, params: options.params, url: options.url ?? null,
          configMode: options.config?.gateway?.mode, configPort: options.config?.gateway?.port,
        });
        return { ok: false, candidates: [
          { key: "agent:main:task:a1166b81-1111-4111-8111-111111111111", displayName: "first" },
          { key: "agent:main:task:a1166b81-2222-4222-8222-222222222222", displayName: "second" },
        ] };
      }
    `;
      // Exercise the real early read and Commander readiness preaction. Only the
      // resolution RPC is synthetic; ambiguity stops before grants or an external client.
      const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { DatabaseSync } from "node:sqlite";
      import { registerHooks } from "node:module";
      const calls = globalThis[Symbol.for("openclaw.test.pristineStartupRpcCalls")] = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const parent = context.parentURL ?? "";
          if (specifier.endsWith("/gateway/call.js") &&
              (parent.endsWith("/cli/session-target.ts") || parent.endsWith("/cli/session-target.js"))) {
            return { shortCircuit: true,
              url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(rpcSource)}) };
          }
          const resolved = nextResolve(specifier, context);
          if (${JSON.stringify(processEntrypointsUrl)} &&
              resolved.url === ${JSON.stringify(sourceUrl("infra/runtime-process-entrypoints.ts"))}) {
            return { ...resolved, url: ${JSON.stringify(processEntrypointsUrl)} };
          }
          return resolved;
        },
      });
      if (${existingState}) {
        const { openOpenClawStateDatabase, closeOpenClawStateDatabase } =
          await import(${JSON.stringify(sourceUrl("state/openclaw-state-db.ts"))});
        openOpenClawStateDatabase({ env: process.env });
        closeOpenClawStateDatabase();
      }
      const databasePath = path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
      const databaseExistedBefore = fs.existsSync(databasePath);
      const { runCli } = await import(${JSON.stringify(sourceUrl("cli/run-main.ts"))});
      process.argv = [process.execPath, "openclaw", "attach", "movies-a1166b81",
        "--url", "ws://127.0.0.1:19877", "--token", "test-token"];
      const message = await runCli(process.argv).catch(error =>
        error instanceof Error ? error.message : String(error));
      const { flushDiagnosticsTimeline } =
        await import(${JSON.stringify(sourceUrl("infra/diagnostics-timeline.ts"))});
      flushDiagnosticsTimeline();
      const events = fs.readFileSync(process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH, "utf8")
        .trim().split("\\n").map(line => JSON.parse(line));
      const stages = events.filter(event => event.type === "span.end" &&
        event.name === "cli.command-startup").map(event => event.attributes?.stage);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      let health;
      try { health = database.prepare("SELECT last_known_good_json FROM config_health_entries WHERE config_path = ?")
        .get(process.env.OPENCLAW_CONFIG_PATH); }
      finally { database.close(); }
      process.stdout.write("__RESULT__" + JSON.stringify({
        message, calls, stages, databaseExistedBefore,
        observedConfigMode: health ? JSON.parse(health.last_known_good_json).gatewayMode : null,
      }) + "\\n");
    `;
      const observed = await run(runtimeRoot, env, script);
      expect(observed.message).toContain("Session reference is ambiguous:");
      expect(observed.message).toContain("first");
      expect(observed.message).toContain("second");
      expect(observed).toMatchObject({
        databaseExistedBefore: existingState,
        observedConfigMode: "local",
      });
      expect(observed.calls).toEqual([
        {
          method: "sessions.resolve",
          params: { shortId: "a1166b81", slugHint: "movies" },
          url: "ws://127.0.0.1:19877",
          configMode: "local",
          configPort: 19876,
        },
      ]);
      expect(observed.stages).toContain("config-ready");
      expect(fs.readFileSync(configPath, "utf8")).toBe(configRaw);
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    },
    75_000,
  );
});

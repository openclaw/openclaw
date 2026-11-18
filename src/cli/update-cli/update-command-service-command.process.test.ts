import { expect, it } from "vitest";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { formatCliProcessFailure, runCliProcessChild } from "../cli-process-child.test-helpers.js";
import { updateServiceRuntimeEntrypoints } from "./update-command-legacy-finalize-entrypoint.test-support.js";

const serviceCommand = resolveRuntimeWorkerUrl(updateServiceRuntimeEntrypoints.command);
const sourceArgs = serviceCommand.pathname.endsWith(".ts") ? ["--import", "./scripts/tsx.mjs"] : [];

it.each([
  "restart",
  "install",
  "restart managed",
  "install managed",
  "missing candidate",
  "unregistered executor",
  "missing executor",
  "restart revoked",
  "install revoked",
  "install slow",
] as const)("handles %s after replacing the updater's module files", async (scenario) => {
  await withOpenClawTestState(
    { prefix: "openclaw-update-command-replacement-", scenario: "minimal", applyEnv: false },
    async (state) => {
      const script = String.raw`
          import assert from "node:assert/strict";
          import { existsSync } from "node:fs";
          import fs from "node:fs/promises";
          import { registerHooks } from "node:module";
          import { mock } from "node:test";
          import path from "node:path";
          import { pathToFileURL } from "node:url";

          const scenario = ${JSON.stringify(scenario)};
          const realSetTimeout = setTimeout;
          const action = scenario.startsWith("install") ? "install" : "restart";
          const root = ${JSON.stringify(state.path("installation"))};
          const dist = path.join(root, "dist");
          const receipt = path.join(root, "candidate.json");
          const release = path.join(root, "release");
          const assertAuthority = () => {
            if (existsSync(receipt)) throw new Error("Update authority revoked during native command");
          };
          const owner = ${JSON.stringify(serviceCommand.href)};
          const moduleUrl = (specifier) => new URL(
            owner.endsWith(".ts") ? specifier.replace(/\.js$/, ".ts") : specifier,
            owner,
          ).href;
          await fs.mkdir(dist, { recursive: true });

          // Preload only shared: recovery preloads would cache the owner before its hook.
          const sharedSource = moduleUrl("./shared.js");
          await import(sharedSource);
          const facade = pathToFileURL(path.join(dist, "old-shared.mjs"));
          await fs.writeFile(facade, "export * from " + JSON.stringify(sharedSource) + ";\n");
          let sharedIntercepted = false;
          registerHooks({
            resolve(specifier, context, nextResolve) {
              const target = context.parentURL === owner ? moduleUrl(specifier) : undefined;
              if (target === sharedSource) {
                sharedIntercepted = true;
                return { url: facade.href, shortCircuit: true };
              }
              return nextResolve(specifier, context);
            },
          });
          const { runUpdatedInstallGatewayCommand } = await import(owner);
          assert.equal(sharedIntercepted, true, "Shared facade was not intercepted before replacement");

          await fs.rm(dist, { recursive: true });
          await fs.mkdir(dist);
          const managedEnv = scenario.endsWith(" managed") ? {
            ...process.env,
            OPENCLAW_SERVICE_MARKER: "openclaw",
            OPENCLAW_SERVICE_KIND: "gateway",
            OPENCLAW_GATEWAY_SERVICE_PID: "1234",
            OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.recovery-fixture",
          } : undefined;
          const params = {
            result: { root, mode: "npm" },
            opts: { json: true, ...(scenario === "missing executor" ? { run: { runId: "original", env: process.env } } : scenario === "unregistered executor" ? {
              run: { runId: "original", env: process.env, executorFence: { assertCurrent: assertAuthority } },
            } : {}) },
            invocationEnv: process.env,
            serviceEnv: managedEnv,
            serviceInstallEnv: managedEnv,
            timeoutMs: scenario === "install slow" ? 120_000 : 10_000,
            assertCurrent() {
              if (scenario.endsWith("revoked")) assertAuthority();
            },
          };
          if (scenario !== "missing candidate") {
            await fs.writeFile(path.join(dist, "index.mjs"), [
              'import fs from "node:fs";',
              'fs.writeFileSync(' + JSON.stringify(receipt) + ', JSON.stringify({',
              '  args: process.argv.slice(2),',
              '  node: process.execPath,',
              '  config: process.env.OPENCLAW_CONFIG_PATH,',
              '  compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE,',
              '  serviceMarker: process.env.OPENCLAW_SERVICE_MARKER,',
              '  serviceKind: process.env.OPENCLAW_SERVICE_KIND,',
              '  servicePid: process.env.OPENCLAW_GATEWAY_SERVICE_PID,',
              '  serviceLabel: process.env.OPENCLAW_LAUNCHD_LABEL,',
              '}));',
              scenario === "install slow" ? 'const timer = setInterval(() => { if (fs.existsSync(' + JSON.stringify(release) + ')) clearInterval(timer); }, 5);' : '',
            ].join("\n"));
          }
          const refusal = {
            "missing candidate": "updated install entrypoint not found under " + root,
            "missing executor": "Native command requires its original update executor.",
            "unregistered executor": "Package recovery requires its admitted executor.",
          }[scenario] ?? (scenario.endsWith("revoked") ? "Update authority revoked during native command" : undefined);
          const run = () => runUpdatedInstallGatewayCommand(params, scenario === "missing candidate" ? "install" : action);
          if (refusal) {
            await assert.rejects(run(), { message: refusal });
            if (scenario.endsWith("executor")) assert.equal(existsSync(receipt), false);
          } else if (scenario === "install slow") {
              mock.timers.enable({ apis: ["setTimeout"] });
              let settled = false;
              const completed = run().then(
                (value) => { settled = true; return value; },
                (error) => { settled = true; return error; },
              );
              while (!existsSync(receipt)) await new Promise(setImmediate);
              mock.timers.tick(61_000);
              await fs.writeFile(release, "done");
              while (!settled) {
                await new Promise((resolve) => realSetTimeout(resolve, 1));
                mock.timers.tick(1);
              }
              mock.timers.reset();
              assert.equal(await completed, "unverified");
            } else {
              assert.equal(await run(), "unverified");
            }
            if (scenario !== "missing candidate" && !scenario.endsWith("executor")) {
              const observed = JSON.parse(await fs.readFile(receipt, "utf8"));
              assert.deepEqual(observed, {
                args: ["gateway", action, action === "restart" ? "--preserve-definition" : "--force", "--json"],
                node: process.execPath,
                config: process.env.OPENCLAW_CONFIG_PATH,
                compileCacheDisabled: "1",
                ...(managedEnv ? { serviceLabel: "ai.openclaw.recovery-fixture" } : {}),
              });
            }
          console.log("UPDATE_COMMAND_AFTER_REPLACEMENT_OK");
        `;
      const result = await runCliProcessChild({
        nodeExecutable: resolveTestNodeExecPath(),
        nodeArgs: [...sourceArgs, "--input-type=module", "--eval", script],
        env: {
          PATH: process.env.PATH,
          ...state.envVars,
          TMPDIR: state.root,
          TMP: state.root,
          TEMP: state.root,
        },
      });
      const failure = formatCliProcessFailure({
        reason: "Update command child failed",
        ...result,
      });
      expect(result, failure).toMatchObject({ signal: null, code: 0 });
      expect(result.stdout, failure).toContain("UPDATE_COMMAND_AFTER_REPLACEMENT_OK");
    },
  );
});

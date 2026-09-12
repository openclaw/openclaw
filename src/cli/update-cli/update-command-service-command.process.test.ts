import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { formatCliProcessFailure, runCliProcessChild } from "../cli-process-child.test-helpers.js";

it.each([
  "restart",
  "install",
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
          const owner = ${JSON.stringify(new URL("./update-command-service-command.ts", import.meta.url).href)};
          await fs.mkdir(dist, { recursive: true });

          // A split build can emit a separate namespace facade even when other
          // imports have already loaded the underlying implementation. Keep the
          // actual helpers cached, then replace only the owner's facade files.
          const facades = new Map();
          for (const specifier of [
            "./shared.js",
            "./update-command-service-recovery.js",
            "../daemon-cli/install.runtime.js",
            "../daemon-cli/install.js",
          ]) {
            const source = new URL(specifier.replace(/\.js$/, ".ts"), owner).href;
            await import(source);
            const facade = path.join(dist, "old-" + facades.size + ".mjs");
            await fs.writeFile(facade, "export * from " + JSON.stringify(source) + ";\n");
            facades.set(specifier, pathToFileURL(facade).href);
          }
          registerHooks({
            resolve(specifier, context, nextResolve) {
              const facade = context.parentURL === owner && facades.get(specifier);
              return facade ? { url: facade, shortCircuit: true } : nextResolve(specifier, context);
            },
          });
          const { runUpdatedInstallGatewayCommand } = await import(owner);

          await fs.rm(dist, { recursive: true });
          await fs.mkdir(dist);
          const params = {
            result: { root, mode: "npm" },
            opts: { json: true, ...(scenario === "missing executor" ? { run: { runId: "original", env: process.env } } : scenario === "unregistered executor" ? {
              run: { runId: "original", env: process.env, executorFence: {
                assertCurrent() { if (existsSync(receipt)) { throw new Error("Update authority revoked during native command"); } },
              } },
            } : {}) },
            invocationEnv: process.env,
            timeoutMs: scenario === "install slow" ? 120_000 : 10_000,
            assertCurrent() {
              if (scenario !== "unregistered executor" && scenario.endsWith("revoked") && existsSync(receipt)) {
                throw new Error("Update authority revoked during native command");
              }
            },
          };
          if (scenario === "missing candidate") {
            await assert.rejects(runUpdatedInstallGatewayCommand(params, "install"), {
              message: "updated install entrypoint not found under " + root,
            });
          } else {
            await fs.writeFile(path.join(dist, "index.mjs"), [
              'import fs from "node:fs";',
              'fs.writeFileSync(' + JSON.stringify(receipt) + ', JSON.stringify({',
              '  args: process.argv.slice(2),',
              '  node: process.execPath,',
              '  config: process.env.OPENCLAW_CONFIG_PATH,',
              '  compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE,',
              '}));',
              scenario === "install slow" ? 'const timer = setInterval(() => { if (fs.existsSync(' + JSON.stringify(release) + ')) clearInterval(timer); }, 5);' : '',
            ].join("\n"));
            if (scenario === "missing executor") {
              await assert.rejects(runUpdatedInstallGatewayCommand(params, action, true), {
                message: "Native command requires its original update executor.",
              });
              assert.equal(existsSync(receipt), false);
            } else if (scenario === "unregistered executor") {
              await assert.rejects(runUpdatedInstallGatewayCommand(params, action, true), {
                message: "Child continuation requires its live executor.",
              });
              assert.equal(existsSync(receipt), false);
            } else if (scenario.endsWith("revoked")) {
              await assert.rejects(runUpdatedInstallGatewayCommand(params, action, true), {
                message: "Update authority revoked during native command",
              });
            } else if (scenario === "install slow") {
              mock.timers.enable({ apis: ["setTimeout"] });
              let settled = false;
              const completed = runUpdatedInstallGatewayCommand(params, action, true).then(
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
              assert.equal(await runUpdatedInstallGatewayCommand(params, action, true), "unverified");
            }
            if (scenario !== "unregistered executor" && scenario !== "missing executor") {
              const observed = JSON.parse(await fs.readFile(receipt, "utf8"));
              assert.deepEqual(observed, {
                args: ["gateway", action, action === "restart" ? "--preserve-definition" : "--force", "--json"],
                node: process.execPath,
                config: process.env.OPENCLAW_CONFIG_PATH,
                compileCacheDisabled: "1",
              });
            }
          }
          console.log("UPDATE_COMMAND_AFTER_REPLACEMENT_OK");
        `;
      const result = await runCliProcessChild({
        nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
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
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(0);
      expect(result.stdout, failure).toContain("UPDATE_COMMAND_AFTER_REPLACEMENT_OK");
    },
  );
});

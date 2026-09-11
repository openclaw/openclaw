import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { formatCliProcessFailure, runCliProcessChild } from "../cli-process-child.test-helpers.js";

it.each([
  "sealed",
  "refused",
  "revoked",
  "owner-revoked",
  "no-handoff",
  "slow-seal",
  "slow-child",
  "short-budget",
] as const)("requires the target runtime's staged handoff before load: %s", async (scenario) => {
  await withOpenClawTestState(
    { prefix: "openclaw-service-load-", scenario: "minimal", applyEnv: false },
    async (state) => {
      const script = String.raw`
          import assert from "node:assert/strict";
          import { existsSync } from "node:fs";
          import fs from "node:fs/promises";
          import path from "node:path";
          import { mock } from "node:test";
          import { pathToFileURL } from "node:url";
          import { runUpdatedInstallGatewayCommand } from ${JSON.stringify(new URL("./update-command-service-command.ts", import.meta.url).href)};
          const scenario = ${JSON.stringify(scenario)};
          const timedSeal = scenario === "slow-seal" || scenario === "short-budget";
          const originalTimeout = AbortSignal.timeout;
          if (timedSeal) {
            mock.timers.enable({ apis: ["setTimeout"] });
            AbortSignal.timeout = (milliseconds) => {
              const controller = new AbortController();
              setTimeout(() => controller.abort(new Error("service owner deadline")), milliseconds);
              return controller.signal;
            };
          }
          const root = ${JSON.stringify(state.path("target"))};
          const staged = path.join(root, "staged");
          const loaded = path.join(root, "loaded");
          const sealed = path.join(root, "sealed");
          const waitModule = ${JSON.stringify(new URL("../daemon-cli/install-load.ts", import.meta.url).href)};
          await fs.mkdir(path.join(root, "dist"), { recursive: true });
          const files = { files: [{ sourcePath: staged, before: null, after: {
            sha256: "a".repeat(64), mode: 384, dev: 1, ino: 2, size: 1, mtimeMs: 1, ctimeMs: 1,
          }}] };
          await fs.writeFile(path.join(root, "dist", "index.mjs"), [
            'import fs from "node:fs/promises";',
            'import { mock } from "node:test";',
            'import { waitForGatewayServiceLoad } from ' + JSON.stringify(waitModule) + ';',
            'await fs.writeFile(' + JSON.stringify(staged) + ', "written");',
            scenario === "no-handoff" ? 'process.exit(0);' : '',
            scenario === "slow-child" ? 'mock.timers.enable({ apis: ["setTimeout"] });' : '',
            'const loading = waitForGatewayServiceLoad(' + JSON.stringify(files) + ');',
            scenario === "slow-child" ? 'mock.timers.tick(61_000); mock.timers.reset();' : '',
            'await loading;',
            'await fs.access(' + JSON.stringify(sealed) + ');',
            'await fs.writeFile(' + JSON.stringify(loaded) + ', process.env.OPENCLAW_CONFIG_PATH);',
            'process.disconnect();',
          ].join("\n"));
          let calls = 0;
          const result = runUpdatedInstallGatewayCommand({
            result: { root, mode: "npm" }, opts: { json: true },
            invocationEnv: { ...process.env, OPENCLAW_CONFIG_PATH: "caller-profile" },
            serviceInstallEnv: { ...process.env, OPENCLAW_CONFIG_PATH: "owned-profile" },
            timeoutMs: scenario === "short-budget" ? 10_000 : 120_000,
            assertCurrent() {
              if (scenario === "owner-revoked" && existsSync(sealed)) { throw new Error("owner revoked"); }
            },
            serviceLoadBoundary: {
              assertCurrent() {
                if (scenario === "revoked" && existsSync(sealed)) { throw new Error("revoked"); }
              },
              async seal(actual, signal) {
                calls++;
                assert.deepEqual(actual, files);
                assert.equal(existsSync(loaded), false);
                signal.throwIfAborted();
                if (scenario === "refused") { throw new Error("unsealed"); }
                if (timedSeal) {
                  try {
                    mock.timers.tick(scenario === "short-budget" ? 11_000 : 61_000);
                    signal.throwIfAborted();
                  } finally {
                    mock.timers.reset();
                    AbortSignal.timeout = originalTimeout;
                  }
                }
                await fs.writeFile(sealed, "sealed");
              },
            },
          }, "install");
          if (["sealed", "slow-seal", "slow-child"].includes(scenario)) {
            assert.equal(await result, "unverified");
            assert.equal(await fs.readFile(loaded, "utf8"), "owned-profile");
          } else {
            await assert.rejects(result, { name: "UpdateServiceLoadBoundaryError" });
            assert.equal(existsSync(loaded), false);
          }
          assert.equal(calls, scenario === "no-handoff" ? 0 : 1);
          console.log("STAGED_LOAD_OK");
        `;
      const result = await runCliProcessChild({
        nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
        env: { PATH: process.env.PATH, ...state.envVars },
      });
      const failure = formatCliProcessFailure({ reason: "Staged-load child failed", ...result });
      expect(result.code, failure).toBe(0);
      expect(result.signal, failure).toBeNull();
      expect(result.stdout, failure).toContain("STAGED_LOAD_OK");
    },
  );
});

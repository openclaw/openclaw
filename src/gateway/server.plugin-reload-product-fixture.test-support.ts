import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { writePrivateUpdateHandoffChildGuard } from "../../test/helpers/private-update-handoff-child-guard.js";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import { runVitestShutdownCommand } from "../../test/helpers/vitest-shutdown-command.js";
import { assertTestHomeSelection } from "../../test/test-home-policy.mts";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

// Shared external-plugin fixture for the reload continuation product entries.
export const PLUGIN = "send-continuation-proof";
export const TOOL = "send_continuation_probe";

export type InputItem = {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  output?: string;
};
export function output(
  body: { input?: InputItem[] },
  name: string,
): Record<string, unknown> | undefined {
  const call = body.input?.findLast((item) => item.type === "function_call" && item.name === name);
  const value = body.input?.find(
    (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
  )?.output;
  return value ? (JSON.parse(value) as Record<string, unknown>) : undefined;
}

// External loader fixture: observable tool/hooks only; no task or reload implementation.
export async function writePlugin(
  root: string,
  hooks: string,
  generationFile: string,
  failReload = false,
) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: PLUGIN, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
  );
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN,
      contracts: { tools: [TOOL] },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(root, "index.cjs"),
    [
      'const fs = require("node:fs");',
      "module.exports = { id: " + JSON.stringify(PLUGIN) + ", register(api) {",
      "const file = " + JSON.stringify(generationFile) + ";",
      'const generation = fs.existsSync(file) ? Number(fs.readFileSync(file,"utf8")) + 1 : 1;',
      "fs.writeFileSync(file, String(generation));",
      ...(failReload
        ? ['if (generation > 1) throw new Error("fixture replacement unavailable");']
        : []),
      'for (const event of ["agent_end","llm_output"]) api.on(event, (data, ctx) => { fs.appendFileSync(' +
        JSON.stringify(hooks) +
        ', JSON.stringify({ event, generation, runId: ctx.runId ?? data.runId }) + "\\n"); });',
      "api.registerTool({ name: " +
        JSON.stringify(TOOL) +
        ', label: "Probe", description: "Observe the plugin generation", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: JSON.stringify({ plugin: ' +
        JSON.stringify(PLUGIN) +
        ", generation }) }] }; } });",
      "} };",
    ].join("\n"),
  );
}

/** Keep both product entries on the same prebound child and shutdown owner. */
export async function definePluginReloadProductTest(
  options: {
    name: string;
    prefix: string;
    testFile: string;
    loadScenarios: () => Promise<unknown>;
    relayOutput?: boolean;
  },
  assertResult: (result: {
    code: number;
    output: string;
    report: JsonTestResults;
    binding: ReturnType<typeof createManagedHandoffTestBinding>;
    handoff: string;
    childPid: number | undefined;
  }) => void,
) {
  const databasePath = process.env.OPENCLAW_TEST_PRIVATE_HANDOFF_PATH;
  if (databasePath) {
    assert.equal(
      Reflect.get(globalThis, Symbol.for("openclaw.test.privateHandoffGuard")),
      databasePath,
    );
    assert.equal(path.resolve(databasePath), databasePath);
    assert.equal(fsSync.realpathSync(path.dirname(databasePath)), path.dirname(databasePath));
    const { resolveSecureTempRoot } = createRequire(import.meta.url)(
      "@openclaw/fs-safe/secure-temp-root",
    ) as typeof import("@openclaw/fs-safe/secure-temp-root");
    assert.equal(
      resolveSecureTempRoot({
        preferredDir: "/tmp/openclaw",
        fallbackPrefix: "openclaw",
        skipPreferredOnWindows: true,
      }),
      path.dirname(databasePath),
    );
    // No Gateway/handoff consumer is imported before this qualification.
    await options.loadScenarios();
    return;
  }
  const lifetime = createFixtureLifetime();
  // Compilation is module preparation; the prebound child owns product effects.
  const nodeExecPath = resolveTestNodeExecPath();
  const fixtureWorkers = createVitestWorkerRun(process.env, undefined, "full", nodeExecPath);
  // A failed fixture drain retains worker claims; dispose only after successful cleanup.
  afterAll(async () => {
    await lifetime.cleanup();
    await fixtureWorkers.dispose();
  });
  try {
    await fixtureWorkers.prepare();
  } catch (error) {
    await fixtureWorkers.dispose();
    throw error;
  }
  it(options.name, async ({ signal }) =>
    lifetime.run(async () => {
      const root = lifetime.createTempDir(options.prefix);
      const handoff = path.join(root, "handoff");
      fsSync.mkdirSync(handoff, { mode: 0o700 });
      const binding = createManagedHandoffTestBinding(handoff);
      const reportPath = path.join(root, "results.json");
      const guard = writePrivateUpdateHandoffChildGuard(binding.databasePath, handoff);
      const home = path.join(root, "home");
      fsSync.mkdirSync(home, { mode: 0o700 });
      const env = withRuntimePreload(
        guard({
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
        }),
        binding.preloadPath,
      );
      assertTestHomeSelection(env, "hermetic");
      // POSIX strict mode and the existing Windows Job owner join descendants,
      // pipes and resource claims. The portable fallback is not an extinction receipt.
      if (process.platform === "win32") {
        const [{ isSupported }, { resolveManagedWindowsJobEntrypointUrl }] = await Promise.all([
          import("@openclaw/proc-safe/windows-job"),
          import("../../scripts/lib/managed-windows-job-entrypoint.mts"),
        ]);
        assert(
          isSupported() && fsSync.existsSync(resolveManagedWindowsJobEntrypointUrl()),
          "Product proof requires the existing native Windows Job owner",
        );
      }
      let capturedOutput = "";
      let childPid: number | undefined;
      const { code } = await lifetime.track(
        runVitestShutdownCommand({
          bin: nodeExecPath,
          workerRun: fixtureWorkers,
          args: [
            "scripts/run-vitest.mjs",
            options.testFile,
            "--reporter=json",
            "--outputFile=" + reportPath,
          ],
          signal,
          cwd: process.cwd(),
          env,
          onReady(child) {
            childPid = child.pid;
            child.stdout?.on("data", (chunk) => {
              capturedOutput += String(chunk);
              if (options.relayOutput) {
                process.stdout.write(chunk);
              }
            });
            child.stderr?.on("data", (chunk) => {
              capturedOutput += String(chunk);
              if (options.relayOutput) {
                process.stderr.write(chunk);
              }
            });
          },
        }),
      );
      const report = JSON.parse(fsSync.readFileSync(reportPath, "utf8")) as JsonTestResults;
      assertResult({ code, output: capturedOutput, report, binding, handoff, childPid });
    }),
  );
}

import { expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mcpImportBoundaryEntrypoints } from "./cli-entrypoint.test-support.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const cliUrl = resolveRuntimeWorkerUrl(mcpImportBoundaryEntrypoints.cli);
const catalogUrl = resolveRuntimeWorkerUrl(mcpImportBoundaryEntrypoints.catalog);
const metadataUrl = resolveRuntimeWorkerUrl(mcpImportBoundaryEntrypoints.metadata);

async function runImportBoundaryChild(forbidden: RegExp, workload: string) {
  return withOpenClawTestState(
    {
      prefix: "openclaw-mcp-import-boundary-",
      scenario: "minimal",
      applyEnv: false,
    },
    async (state) => {
      // A fresh child keeps Vitest's shared module cache from bypassing the guard.
      // The prepared graph preserves src paths and module boundaries for the guard.
      const script = String.raw`
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";

        const forbidden = ${forbidden};
        function assertAllowedImport(url, parentURL) {
          if (forbidden.test(url)) {
            throw new Error("MCP import boundary denied " + url +
              " (importer: " + (parentURL ?? "unknown") + ")");
          }
        }
        registerHooks({
          resolve(specifier, context, nextResolve) {
            const requested = specifier.startsWith(".")
              ? new URL(specifier, context.parentURL ?? import.meta.url).href
              : specifier;
            assertAllowedImport(requested, context.parentURL);
            const resolved = nextResolve(specifier, context);
            assertAllowedImport(resolved.url, context.parentURL);
            return resolved;
          },
        });

        ${workload}
        console.log("MCP_IMPORT_BOUNDARY_OK");
      `;
      const nodeExecutable = resolveTestNodeExecPath();
      const result = await runCliProcessChild({
        nodeExecutable,
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(cliUrl, nodeExecutable).slice(0, -1),
          "--input-type=module",
          "--eval",
          script,
        ],
        // Keep the child environment explicit; state.env includes Vitest and operator flags.
        env: {
          PATH: process.env.PATH,
          ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
          ...state.envVars,
          // TSX's compiler cache belongs to the runner, not the disposable app state.
          TMPDIR: process.env.TMPDIR,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
        },
        timeoutMs: 30_000,
      });
      const failure = formatCliProcessFailure({
        reason: "MCP import boundary child failed",
        ...result,
      });

      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(0);
      expect(result.stdout, failure).toContain("MCP_IMPORT_BOUNDARY_OK");
      return result.stdout;
    },
  );
}

it("keeps MCP client and catalog paths free of plugin tool construction and channel serving", async () => {
  const stdout = await runImportBoundaryChild(
    /\/src\/(?:plugins\/tools|mcp\/channel-server)\.(?:ts|js)(?:[?#].*)?$/u,
    String.raw`
      const { Command } = await import("commander");
      const { registerMcpCli } = await import(${JSON.stringify(cliUrl.href)});
      const program = new Command();
      program.exitOverride();
      registerMcpCli(program);
      assert.equal(await program.parseAsync(["mcp", "reload"], { from: "user" }), program);

      const { buildBundleMcpToolsFromCatalog } = await import(${JSON.stringify(catalogUrl.href)});
      const tools = buildBundleMcpToolsFromCatalog({
        catalog: {
          version: 1,
          generatedAt: 0,
          servers: {
            inventory: {
              serverName: "inventory",
              safeServerName: "inventory",
              launchSummary: "inventory fixture",
              toolCount: 1,
            },
          },
          tools: [{
            serverName: "inventory",
            safeServerName: "inventory",
            toolName: "lookup",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "Look up an inventory item",
          }],
        },
      });
      assert.deepEqual(tools.map((tool) => tool.name), ["inventory__lookup"]);
      await assert.rejects(tools[0].execute("inventory-only", {}, undefined, undefined), {
        message: "bundle-mcp catalog projection cannot execute tools",
      });
    `,
  );
  expect(stdout).toContain("Disposed cached MCP runtimes.");
});

it("keeps registry reads independent of agent tool materialization", async () => {
  await runImportBoundaryChild(
    /\/src\/agents\/agent-bundle-mcp-materialize\.(?:ts|js)(?:[?#].*)?$/u,
    String.raw`
      const { Command } = await import("commander");
      const { registerMcpCli } = await import(${JSON.stringify(cliUrl.href)});
      const program = new Command();
      program.exitOverride();
      registerMcpCli(program);
      for (const command of ["list", "show", "status", "doctor"]) {
        assert.equal(await program.parseAsync(["mcp", command, "--json"], { from: "user" }), program);
      }
    `,
  );
});

it("keeps the metadata owner independent of plugin loading and channel serving", async () => {
  await runImportBoundaryChild(
    /\/src\/(?:plugins\/(?:tools|loader)|mcp\/channel-server)\.(?:ts|js)(?:[?#].*)?$/u,
    String.raw`
      const { getPluginToolMeta } = await import(${JSON.stringify(metadataUrl.href)});
      assert.equal(getPluginToolMeta({}), undefined);
    `,
  );
});

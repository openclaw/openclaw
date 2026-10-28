import { expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mcpImportBoundaryEntrypoints } from "./cli-entrypoint.test-support.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const cliUrl = resolveRuntimeWorkerUrl(mcpImportBoundaryEntrypoints.cli);
const catalogUrl = resolveRuntimeWorkerUrl(mcpImportBoundaryEntrypoints.catalog);
const metadataUrl = resolveRuntimeWorkerUrl(mcpImportBoundaryEntrypoints.metadata);
const registerCli = String.raw`
      const program = new (await import("commander")).Command().exitOverride();
      (await import(${JSON.stringify(cliUrl.href)})).registerMcpCli(program);
`;

async function runImportBoundaryChild(forbidden: RegExp, workload: string) {
  return withOpenClawTestState(
    { prefix: "mcp-import-", scenario: "minimal", applyEnv: false },
    async (state) => {
      // A fresh child keeps Vitest's shared module cache from bypassing the guard.
      const script = String.raw`
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        const forbidden = ${forbidden};
        const assertAllowedImport = (url, parentURL) => assert(!forbidden.test(url),
          "MCP import boundary denied " + url + " (importer: " + (parentURL ?? "unknown") + ")");
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
      const workerArgs = resolveRuntimeWorkerArgv(cliUrl, nodeExecutable).slice(0, -1);
      const { PATH, ESBUILD_WORKER_THREADS, TMPDIR, TMP, TEMP } = process.env;
      const result = await runCliProcessChild({
        nodeExecutable,
        nodeArgs: [...workerArgs, "--input-type=module", "--eval", script],
        // Inherit only runner paths/compiler temp dirs, not Vitest or operator flags.
        env: { PATH, ESBUILD_WORKER_THREADS, ...state.envVars, TMPDIR, TMP, TEMP },
        timeoutMs: 30_000,
      });
      const failure = formatCliProcessFailure({ reason: "MCP import boundary", ...result });

      expect(result, failure).toMatchObject({ signal: null, code: 0 });
      expect(result.stdout, failure).toContain("MCP_IMPORT_BOUNDARY_OK");
    },
  );
}

it.each<[string, RegExp, string]>([
  [
    "client and catalog",
    /\/src\/(?:plugins\/tools|mcp\/channel-server)\.(?:ts|js)(?:[?#].*)?$/u,
    String.raw`
      ${registerCli}
      await program.parseAsync(["mcp", "reload"], { from: "user" });
      const { buildBundleMcpToolsFromCatalog } = await import(${JSON.stringify(catalogUrl.href)});
      const [tool] = buildBundleMcpToolsFromCatalog({ catalog: {
        version: 1, generatedAt: 0, servers: {}, tools: [{
          serverName: "inventory", safeServerName: "inventory", toolName: "lookup",
          inputSchema: { type: "object" }, fallbackDescription: "Look up an item",
        }],
      } });
      await assert.rejects(tool.execute("inventory-only", {}, undefined, undefined), {
        message: "bundle-mcp catalog projection cannot execute tools",
      });
    `,
  ],
  [
    "registry reads",
    /\/src\/agents\/agent-bundle-mcp-materialize\.(?:ts|js)(?:[?#].*)?$/u,
    String.raw`
      ${registerCli}
      for (const command of ["list", "show", "status", "doctor"]) {
        await program.parseAsync(["mcp", command, "--json"], { from: "user" });
      }
    `,
  ],
  [
    "metadata owner",
    /\/src\/(?:plugins\/(?:tools|loader)|mcp\/channel-server)\.(?:ts|js)(?:[?#].*)?$/u,
    String.raw`
      await import(${JSON.stringify(metadataUrl.href)});
    `,
  ],
])("keeps %s imports within their boundary", async (_name, forbidden, workload) => {
  await runImportBoundaryChild(forbidden, workload);
});

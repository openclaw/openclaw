import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runWebSearch } from "./runtime.js";

const pluginId = "sandbox-search-fixture";

describe.each([true, false])(
  "web_search trust with runtime preference %s",
  (preferRuntimeProviders) => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);
    afterEach(() => clearActivePluginRegistry());

    it.each([
      { bundled: false, sandboxed: true, allowed: false },
      { bundled: false, sandboxed: false, allowed: true },
      { bundled: false, sandboxed: undefined, allowed: true },
      { bundled: true, sandboxed: true, allowed: true },
    ])("bundled $bundled / sandboxed $sandboxed", async ({ bundled, sandboxed, allowed }) => {
      const root = tempDirs.make("web-search-sandbox-");
      const workspaceDir = path.join(root, "workspace");
      const bundledDir = path.join(root, "bundled");
      const pluginDir = path.join(
        bundled ? bundledDir : path.join(workspaceDir, ".openclaw", "extensions"),
        pluginId,
      );
      const traceFile = path.join(root, "provider-effects.txt");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.mkdirSync(bundledDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          contracts: { webSearchProviders: [pluginId] },
          configSchema: { type: "object", properties: {} },
        }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "index.cjs"),
        `const trace = (phase) => require("node:fs").appendFileSync(${JSON.stringify(traceFile)}, phase + "\\n");
trace("import");
module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
  trace("register");
  api.registerWebSearchProvider({
    id: ${JSON.stringify(pluginId)}, label: "Fixture", hint: "Fixture", envVars: [],
    placeholder: "", signupUrl: "https://example.invalid", credentialPath: "", requiresCredential: false,
    getCredentialValue: () => undefined, setCredentialValue: () => {},
    createTool() {
      trace("tool");
      return { description: "Search fixture", parameters: {}, execute: async (args) => {
        trace("execute");
        return { query: args.query };
      }};
    },
  });
}};
`,
      );
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
        tools: { web: { search: { provider: pluginId } } },
      };
      setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", workspaceDir);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir },
        async () => {
          const result = runWebSearch({
            config,
            preferInputConfig: true,
            preferRuntimeProviders,
            sandboxed,
            authStore: { version: 1, profiles: {} },
            args: { query: "sandbox trust proof" },
          });
          if (allowed) {
            await expect(result).resolves.toEqual({
              provider: pluginId,
              result: { query: "sandbox trust proof" },
            });
            expect(fs.readFileSync(traceFile, "utf8").trim().split("\n")).toEqual([
              "import",
              "register",
              "tool",
              "execute",
            ]);
          } else {
            await expect(result).rejects.toThrow("bundled or verified official");
            expect(fs.existsSync(traceFile)).toBe(false);
          }
        },
      );
    });
  },
);

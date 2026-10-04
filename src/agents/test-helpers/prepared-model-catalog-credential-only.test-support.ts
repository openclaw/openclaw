/** Adds a credential-only provider whose runtime synthetic-auth hook answers for an undeclared ref. */
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";

export const CREDENTIAL_ONLY_PROVIDER_ID = "worker-catalog-credential-only";
const CREDENTIAL_ONLY_TOKEN = "credential-only-token-not-real";

// Shaped like Anthropic's runtime provider: its prepareSyntheticAuth hook answers for the provider's
// own id, which no manifest declares, and only the stored credential brings it into full discovery.
export function addCredentialOnlyProviderFixture(fixture: {
  root: string;
  agentDir: string;
  config: OpenClawConfig;
}): OpenClawConfig {
  const pluginDir = path.join(fixture.root, "credential-only-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(CREDENTIAL_ONLY_PROVIDER_ID)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(CREDENTIAL_ONLY_PROVIDER_ID)},
      label: "Credential-only fixture",
      auth: [],
      async prepareSyntheticAuth() {
        if (require("node:worker_threads").threadId !== ${threadId}) throw Error("native auth probe entered worker");
        fs.appendFileSync(${JSON.stringify(path.join(fixture.root, "credential-only-auth-owner.txt"))}, "parent\\n");
        return undefined;
      },
      catalog: {
        run(context) {
          return context.resolveProviderApiKey().apiKey === ${JSON.stringify(CREDENTIAL_ONLY_TOKEN)}
            ? { provider: {
                baseUrl: "https://credential-only.invalid/v1",
                api: "openai-completions",
                models: [{ id: "credential-only-model", name: "Credential-only model" }],
              } }
            : null;
        },
      },
    });
  },
};
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: CREDENTIAL_ONLY_PROVIDER_ID,
      providers: [CREDENTIAL_ONLY_PROVIDER_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      modelCatalog: { discovery: { [CREDENTIAL_ONLY_PROVIDER_ID]: "runtime" } },
    }),
    "utf8",
  );
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        [`${CREDENTIAL_ONLY_PROVIDER_ID}:manual`]: {
          type: "token",
          provider: CREDENTIAL_ONLY_PROVIDER_ID,
          token: CREDENTIAL_ONLY_TOKEN,
        },
      },
    },
    fixture.agentDir,
  );
  const plugins = fixture.config.plugins;
  return {
    ...fixture.config,
    plugins: {
      ...plugins,
      allow: [...(plugins?.allow ?? []), CREDENTIAL_ONLY_PROVIDER_ID],
      load: { ...plugins?.load, paths: [...(plugins?.load?.paths ?? []), pluginFile] },
      entries: { ...plugins?.entries, [CREDENTIAL_ONLY_PROVIDER_ID]: { enabled: true } },
    },
  };
}

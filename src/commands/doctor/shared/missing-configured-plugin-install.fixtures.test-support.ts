import fs from "node:fs";
import path from "node:path";
import type { BundledProviderPolicySurface } from "../../../plugins/provider-policy-surface.js";

export function writePluginJson(root: string, file: string, value: unknown) {
  fs.writeFileSync(path.join(root, file), JSON.stringify(value), "utf8");
}

export function openaiPolicySurface(pluginId: string): BundledProviderPolicySurface | null {
  return pluginId === "openai"
    ? {
        normalizeModelCatalogId: ({ modelId }) => modelId,
        resolveModelRoutes: ({ requestTransportOverrides }) => ({
          kind: "routes",
          routes: [
            {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: requestTransportOverrides ?? "none",
              runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
            },
          ],
          defaultRuntimeId: "codex",
        }),
      }
    : null;
}

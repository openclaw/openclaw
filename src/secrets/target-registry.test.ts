/** Tests core secret target registry queries without plugin discovery. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
  resolveSecretPlanTargetByPathCore,
} from "./target-registry.js";

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: () => ({ plugins: [] }),
}));

describe("secret target registry", () => {
  it("preserves dotted provider header keys during discovery", () => {
    const config = {
      models: {
        providers: {
          openai: {
            headers: {
              "X.Trace": { source: "env", provider: "default", id: "TRACE_HEADER" },
            },
            request: {
              headers: {
                "X.Request.Trace": {
                  source: "env",
                  provider: "default",
                  id: "REQUEST_TRACE_HEADER",
                },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const targets = discoverConfigSecretTargetsByIds(
      config,
      new Set(["models.providers.*.headers.*", "models.providers.*.request.headers.*"]),
    );

    expect(targets.map(({ path }) => path).toSorted()).toEqual([
      'models.providers.openai.headers["X.Trace"]',
      'models.providers.openai.request.headers["X.Request.Trace"]',
    ]);
  });

  it("returns null when no config target path matches", () => {
    const target = resolveConfigSecretTargetByPath(["gateway", "auth", "mode"]);

    expect(target).toBeNull();
  });

  it.each([{ prefix: [] }, { prefix: ["agents", "entries", "main"] }])(
    "does not offer string-only memory headers as structured SecretRef apply targets ($prefix)",
    ({ prefix }) => {
      expect(
        resolveConfigSecretTargetByPath([
          ...prefix,
          "memory",
          "search",
          "remote",
          "headers",
          "Authorization",
        ]),
      ).toBeNull();
    },
  );

  it("resolves plan targets by owning config document", () => {
    const configTarget = resolveSecretPlanTargetByPathCore({
      configFile: "openclaw.json",
      pathSegments: ["models", "providers", "openai", "apiKey"],
    });
    const authProfileTarget = resolveSecretPlanTargetByPathCore({
      configFile: "auth-profile-store",
      pathSegments: ["profiles", "openai:default", "key"],
    });

    expect(configTarget?.entry.targetType).toBe("models.providers.apiKey");
    expect(configTarget?.providerId).toBe("openai");
    expect(authProfileTarget?.entry.targetType).toBe("auth-profiles.api_key.key");
  });
});

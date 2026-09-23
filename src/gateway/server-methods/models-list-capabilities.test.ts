import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginManifestDecisionModelSetup,
  PluginManifestSecretInputPath,
} from "../../plugins/manifest-types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { listDecisionModels } from "./models-list-capabilities.js";

const hosted: PluginManifestDecisionModelSetup = {
  kind: "api-key",
  label: "Hosted credential",
  help: "Save a credential without running a paid evaluation.",
  credentialPath: "auth.apiKey",
};
const local: PluginManifestDecisionModelSetup = {
  kind: "local-server",
  label: "Local server",
  help: "Start a server and configure its origin.",
  documentationUrl: "https://example.com/local-setup",
  configuredPath: "baseUrl",
};

function metadata(
  paths: PluginManifestSecretInputPath[] = [
    { path: "auth.apiKey", expected: "string", ownerKind: "capability" },
  ],
) {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "decisions",
        // A nonexistent runtime entry ensures this inventory needs only manifest facts.
        source: "/synthetic/must-not-import-decision-runtime.ts",
        contracts: { decisionProviders: ["fixture"] },
        configContracts: { secretInputs: { paths } },
        decisionModels: [
          {
            provider: "fixture",
            id: "hosted",
            name: "Hosted",
            setup: [{ ...local, whenConfigured: "baseUrl" }, hosted],
          },
          { provider: "fixture", id: "local", name: "Local", setup: [local] },
          {
            provider: "fixture",
            id: "weights",
            name: "Weights",
            setup: [
              {
                kind: "local-model",
                label: "Download weights",
                help: "Prepare model artifacts separately.",
              },
            ],
          },
          { provider: "fixture", id: "manual", name: "Manual" },
        ],
      },
    ],
  });
}

describe("decision model setup discovery", () => {
  it("discovers per-model instructions without importing a runtime or probing endpoints", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected probe"));
    try {
      const models = listDecisionModels({ config: {}, snapshot: metadata() });
      expect(models).toEqual([
        {
          provider: "fixture",
          id: "hosted",
          name: "Hosted",
          pluginId: "decisions",
          readiness: "setup-required",
          setup: {
            ...hosted,
            credentialPath: ["plugins", "entries", "decisions", "config", "auth", "apiKey"],
          },
        },
        {
          provider: "fixture",
          id: "local",
          name: "Local",
          pluginId: "decisions",
          readiness: "setup-required",
          setup: {
            kind: local.kind,
            label: local.label,
            help: local.help,
            documentationUrl: local.documentationUrl,
          },
        },
        {
          provider: "fixture",
          id: "weights",
          name: "Weights",
          pluginId: "decisions",
          readiness: "unknown",
          setup: {
            kind: "local-model",
            label: "Download weights",
            help: "Prepare model artifacts separately.",
          },
        },
        { provider: "fixture", id: "manual", name: "Manual", pluginId: "decisions" },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("preserves a local override for hosted labels without exposing or consuming their credential", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          decisions: {
            config: {
              baseUrl: "http://127.0.0.1:8009",
              auth: { apiKey: { source: "store", provider: "default", id: "EXAMPLE_API_KEY" } },
            },
          },
        },
      },
    };
    const models = listDecisionModels({ config, snapshot: metadata() });
    expect(models.slice(0, 2).map(({ setup, readiness }) => ({ setup, readiness }))).toEqual([
      {
        setup: {
          kind: local.kind,
          label: local.label,
          help: local.help,
          documentationUrl: local.documentationUrl,
        },
        readiness: "setup-required",
      },
      {
        setup: {
          kind: local.kind,
          label: local.label,
          help: local.help,
          documentationUrl: local.documentationUrl,
        },
        readiness: "setup-required",
      },
    ]);
    expect(models[2]?.readiness).toBe("unknown");
    expect(JSON.stringify(models)).not.toContain("EXAMPLE_API_KEY");
    expect(config.agents).toBeUndefined();
  });

  it.each([undefined, null, "", "   ", false])(
    "does not treat an absent local setting (%j) as configured",
    (baseUrl) => {
      const config: OpenClawConfig = {
        plugins: { entries: { decisions: { config: { baseUrl } } } },
      };
      const models = listDecisionModels({ config, snapshot: metadata() });
      expect(models[0]?.setup?.kind).toBe("api-key");
      expect(models[1]?.readiness).toBe("setup-required");
    },
  );

  it.each<PluginManifestSecretInputPath[]>([
    [],
    [{ path: "auth.apiKey", ownerKind: "route" }],
    [{ path: "auth.apiKey" }],
    [{ path: "auth.apiKey", ownerKind: "capability" }],
    [{ path: "auth.*", ownerKind: "capability" }],
    [{ path: "other.apiKey", ownerKind: "capability" }],
  ])(
    "does not expose a write target without its exact capability-secret declaration: %j",
    (...paths) => {
      const [model] = listDecisionModels({ config: {}, snapshot: metadata(paths) });
      expect(model?.setup?.kind).toBe("api-key");
      expect(model?.setup).not.toHaveProperty("credentialPath");
    },
  );

  it.each<OpenClawConfig["plugins"]>([
    { enabled: false },
    { entries: { decisions: { enabled: false } } },
    { deny: ["decisions"] },
  ])("keeps disabled decision providers unavailable despite setup metadata: %j", (plugins) => {
    expect(listDecisionModels({ config: { plugins }, snapshot: metadata() })).toEqual([]);
  });
});

it("reads concrete array markers without mistaking a configured local mode for hosted setup", () => {
  const snapshot = metadata();
  const model = snapshot.plugins[0]?.decisionModels?.[0];
  if (!model) {
    throw new Error("Missing decision fixture");
  }
  model.setup = [
    { ...local, whenConfigured: "endpoints[0].url", configuredPath: "endpoints[0].url" },
    hosted,
  ];
  const models = listDecisionModels({
    snapshot,
    config: {
      plugins: {
        entries: { decisions: { config: { endpoints: [{ url: "http://127.0.0.1:8009" }] } } },
      },
    },
  });
  expect(models[0]?.setup?.kind).toBe("local-server");
  expect(models[0]?.readiness).toBe("setup-required");
});

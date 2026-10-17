import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolvePluginDoctorProviderRenames } from "../../../plugins/doctor-contract-registry.js";
import type * as DoctorContractRegistry from "../../../plugins/doctor-contract-registry.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "./config-flow-steps.js";
import { applyProviderRenames } from "./provider-rename.js";

vi.mock("../../../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DoctorContractRegistry>()),
  resolvePluginDoctorProviderRenames: vi.fn<
    typeof DoctorContractRegistry.resolvePluginDoctorProviderRenames
  >(() => []),
}));

function pairedSnapshot(authored: OpenClawConfig, resolved: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: "/fixture/openclaw.json",
    exists: true,
    raw: JSON.stringify(authored),
    parsed: authored,
    authoredConfig: authored,
    sourceConfigBeforeMigrations: resolved,
    sourceConfig: resolved,
    resolved,
    config: resolved,
    runtimeConfig: resolved,
    valid: true,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("Doctor planning reference intent", () => {
  it("preserves an explicitly activated reference at an unchanged path", () => {
    const candidate = { browser: { executablePath: "${BROWSER_BIN}" } };
    const source = prepareDoctorConfigReferenceSource(
      pairedSnapshot({ browser: { executablePath: "$${BROWSER_BIN}" } }, candidate),
    );
    expect(restoreDoctorConfigEnvRefs(candidate, source, [["browser", "executablePath"]])).toEqual(
      candidate,
    );
    expect(restoreDoctorConfigEnvRefs(candidate, source)).toEqual({
      browser: { executablePath: "$${BROWSER_BIN}" },
    });
  });

  it("preserves an explicitly activated reference at a migrated destination", () => {
    const source = prepareDoctorConfigReferenceSource(
      pairedSnapshot(
        {
          agents: { defaults: { memorySearch: { remote: { apiKey: "$${MEMORY_KEY}" } } } },
        } as OpenClawConfig,
        {
          agents: { defaults: { memorySearch: { remote: { apiKey: "${MEMORY_KEY}" } } } },
        } as OpenClawConfig,
      ),
    );
    const candidate = { memory: { search: { remote: { apiKey: "${MEMORY_KEY}" } } } };
    expect(
      restoreDoctorConfigEnvRefs(candidate, source, [["memory", "search", "remote", "apiKey"]]),
    ).toEqual(candidate);
    expect(restoreDoctorConfigEnvRefs(candidate, source).memory?.search?.remote?.apiKey).toBe(
      "$${MEMORY_KEY}",
    );
  });

  it("preserves moved provider templates when the routing URL is environment-backed", () => {
    const renames = [{ from: "ollama", to: "ollama-cloud", baseUrl: "https://ollama.com" }];
    const authored: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "${OLLAMA_BASE_URL}",
            apiKey: "${OLLAMA_API_KEY}",
            models: [],
          },
        },
      },
      agents: { defaults: { model: "ollama/example" } },
    };
    const resolved = structuredClone(authored);
    resolved.models!.providers!.ollama!.baseUrl = "https://ollama.com/api";
    resolved.models!.providers!.ollama!.apiKey = "synthetic-rotating-key";
    const source = prepareDoctorConfigReferenceSource(pairedSnapshot(authored, resolved));
    vi.mocked(resolvePluginDoctorProviderRenames).mockReturnValueOnce(renames);
    const preflight = restoreDoctorConfigEnvRefs(resolved, source);
    expect(preflight).toEqual(authored);
    const candidate = applyProviderRenames(resolved, renames).config;
    vi.mocked(resolvePluginDoctorProviderRenames).mockReturnValueOnce(renames);

    const restored = restoreDoctorConfigEnvRefs(candidate, source);

    expect(restored.models?.providers).toEqual({
      "ollama-cloud": authored.models!.providers!.ollama,
    });
    expect(restored.agents?.defaults?.model).toBe("ollama-cloud/example");
    expect(JSON.stringify(restored)).not.toContain("synthetic-rotating-key");
    expect(source?.authored).toEqual(authored);
  });
});

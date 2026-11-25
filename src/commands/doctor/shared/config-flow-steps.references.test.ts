import { describe, expect, it, vi } from "vitest";
import { createSnapshot } from "../../../config/mutate.test-support.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolvePluginDoctorProviderRenames } from "../../../plugins/doctor-contract-registry.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "./config-flow-steps.js";
import { applyProviderRenames } from "./provider-rename.js";

vi.mock("../../../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/doctor-contract-registry.js")>()),
  resolvePluginDoctorProviderRenames: vi.fn<typeof resolvePluginDoctorProviderRenames>(() => []),
}));

function referenceSource(authored: OpenClawConfig, resolved: OpenClawConfig) {
  return prepareDoctorConfigReferenceSource({
    ...createSnapshot({ hash: "fixture", sourceConfig: resolved, parsed: authored }),
    authoredConfig: authored,
    sourceConfigBeforeMigrations: resolved,
  });
}

function legacyMemory(apiKey: string): OpenClawConfig {
  return { agents: { defaults: { memorySearch: { remote: { apiKey } } } } } as OpenClawConfig;
}

describe("Doctor planning reference intent", () => {
  it("preserves an explicitly activated reference at an unchanged path", () => {
    const candidate = { browser: { executablePath: "${BROWSER_BIN}" } };
    const source = referenceSource({ browser: { executablePath: "$${BROWSER_BIN}" } }, candidate);
    expect(restoreDoctorConfigEnvRefs(candidate, source, [["browser", "executablePath"]])).toEqual(
      candidate,
    );
    expect(restoreDoctorConfigEnvRefs(candidate, source)).toEqual({
      browser: { executablePath: "$${BROWSER_BIN}" },
    });
  });

  it("preserves an explicitly activated reference at a migrated destination", () => {
    const source = referenceSource(legacyMemory("$${MEMORY_KEY}"), legacyMemory("${MEMORY_KEY}"));
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
    const ollama = { baseUrl: "${OLLAMA_BASE_URL}", apiKey: "${OLLAMA_API_KEY}", models: [] };
    const authored: OpenClawConfig = {
      models: { providers: { ollama } },
      agents: { defaults: { model: "ollama/example" } },
    };
    const resolved = structuredClone(authored);
    resolved.models!.providers!.ollama!.baseUrl = "https://ollama.com/api";
    resolved.models!.providers!.ollama!.apiKey = "synthetic-rotating-key";
    const source = referenceSource(authored, resolved);
    vi.mocked(resolvePluginDoctorProviderRenames).mockReturnValueOnce(renames);
    expect(restoreDoctorConfigEnvRefs(resolved, source)).toEqual(authored);
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

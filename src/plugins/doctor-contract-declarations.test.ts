import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { coercePluginDoctorContractModule } from "./doctor-contract-module.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry-build.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";

const DOCTOR_CONTRACT_SURFACES = [
  "configRepair",
  "resolveSessionStoreAgentIds",
  "sessionRouteStateOwners",
  "stateMigrations",
] as const satisfies readonly (keyof PluginManifestDoctorContract)[];

const sourceManifestEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
};
const records = () => loadBundledPluginManifestRegistry({ env: sourceManifestEnv }).plugins;
const artifact = (record: ReturnType<typeof records>[number]) =>
  resolvePluginDoctorContractArtifact({ ...record, sourcePreferred: true })?.modulePath;
// Use Vitest's transform once per artifact; production loading has its own tests.
async function contract(artifactPath: string) {
  return coercePluginDoctorContractModule(
    await vi.importActual<Parameters<typeof coercePluginDoctorContractModule>[0]>(artifactPath),
  );
}

describe("provider rename descriptors", () => {
  it("accepts descriptor-only config repairs and default exports", () => {
    const providerRenames = [{ from: "old", to: "new", baseUrl: "https://models.example/api" }];
    for (const mod of [{ providerRenames }, { default: { providerRenames } }]) {
      const result = coercePluginDoctorContractModule({ providerRenames: undefined, ...mod });
      expect(result.providerRenames).toEqual(providerRenames);
      expect(result.summary.configRepair).toBe(true);
    }
  });

  it.each([
    { from: "old/model", to: "new", baseUrl: "https://models.example" },
    { from: "old", to: "old", baseUrl: "https://models.example" },
    { from: "old", to: "new", baseUrl: "not a URL" },
  ])("rejects malformed or ambiguous descriptors: %j", (descriptor) => {
    expect(() => coercePluginDoctorContractModule({ providerRenames: [descriptor] })).toThrow();
  });
});

describe("bundled plugin doctor contract declarations", () => {
  it("matches every resolvable artifact's coerced doctor surfaces", async () => {
    await Promise.all(
      records().map(async (record) => {
        const artifactPath = artifact(record);
        if (!artifactPath) {
          return;
        }
        const declaration = expectDefined(record.doctorContract, record.id);
        const { summary } = await contract(artifactPath);
        for (const surface of DOCTOR_CONTRACT_SURFACES) {
          const value = declaration[surface];
          const declared =
            surface === "sessionRouteStateOwners" && record.sessionRouteStateOwners !== undefined
              ? false
              : value === true || (surface === "stateMigrations" && Array.isArray(value));
          expect(summary[surface], `${record.id}:${surface}`).toBe(declared);
        }
      }),
    );
  }, 600_000);

  it("declares every state migration identity and phase in module order", async () => {
    await Promise.all(
      records().map(async (record) => {
        const declaration = record.doctorContract?.stateMigrations;
        if (!Array.isArray(declaration)) {
          return;
        }
        const artifactPath = expectDefined(artifact(record), `${record.id}: missing artifact`);
        const actual = (await contract(artifactPath)).stateMigrations.map((migration) =>
          Object.assign(
            { id: migration.id },
            migration.doctorOnly === true ? { doctorOnly: true as const } : {},
            migration.phase ? { phase: migration.phase } : {},
          ),
        );
        expect(JSON.stringify(actual), record.id).toBe(JSON.stringify(declaration));
      }),
    );
  }, 600_000);
});

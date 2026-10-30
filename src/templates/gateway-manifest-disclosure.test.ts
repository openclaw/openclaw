import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildGatewayTemplateAddPlan, projectGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import { projectTemplateManifestDisclosure } from "./gateway-manifest-disclosure.js";
import { readTemplateManifestFile } from "./reader.js";
import type { TemplateReadResult } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

async function verifiedSource(name: string): Promise<Extract<TemplateReadResult, { ok: true }>> {
  const loaded = await readTemplateManifestFile(
    path.resolve("src/templates/fixtures/workspace-agent.template.json"),
  );
  if (!loaded.ok) {
    throw new Error("The workspace agent fixture must be readable.");
  }
  return {
    ...loaded,
    source: {
      ...loaded.source,
      kind: "package",
      name,
      version: "1.0.0",
      integrityKind: "artifact",
      integrity: `sha256:${"a".repeat(64)}`,
      byteLength: 123,
    },
  };
}

describe("Template manifest disclosure", () => {
  it.each(["@maker/workspace-agent", "workspace-agent", "@openclaw/workspace-agent"])(
    "includes the verified %s manifest in the real Add plan projection",
    async (name) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-template-disclosure-"));
      const source = await verifiedSource(name);
      const config = { agents: { entries: {} } };
      const plan = await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
      const projected = projectGatewayTemplateAddPlan(
        plan,
        source,
        {
          riskAcknowledgementRequired: false,
          trustRecord: {
            clawhubTrustDisposition: "clean",
            clawhubTrustCheckedAt: "2026-10-15T00:00:00.000Z",
          },
        },
        config,
      );

      expect(projected.blockers).toEqual([]);
      expect(projected.manifestDisclosure?.source).toEqual({
        packageName: name,
        version: "1.0.0",
        integrity: source.source.integrity,
        byteLength: 123,
      });
      expect(JSON.parse(projected.manifestDisclosure!.manifestJson)).toEqual(source.manifest);
    },
  );

  it.each(["@maker/../private", "@Maker/workspace-agent", "@maker/workspace-agent@latest"])(
    "rejects noncanonical identity %s",
    async (name) => {
      const source = await verifiedSource(name);
      expect(() => projectTemplateManifestDisclosure(source, source.source)).toThrow(
        "source identity cannot be disclosed safely",
      );
    },
  );

  it.each([
    { name: "@other/workspace-agent" },
    { version: "2.0.0" },
    { integrity: `sha256:${"b".repeat(64)}` },
  ])("rejects a changed reviewed coordinate: %j", async (changed) => {
    const source = await verifiedSource("@maker/workspace-agent");
    expect(() =>
      projectTemplateManifestDisclosure(source, { ...source.source, ...changed }),
    ).toThrow("source identity cannot be disclosed safely");
  });
});

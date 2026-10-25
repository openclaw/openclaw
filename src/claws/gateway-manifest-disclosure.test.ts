import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildGatewayClawAddPlan, projectGatewayClawAddPlan } from "./gateway-add-plan.js";
import { projectClawManifestDisclosure } from "./gateway-manifest-disclosure.js";
import { readClawManifestFile } from "./reader.js";
import type { ClawReadResult } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

async function verifiedSource(name: string): Promise<Extract<ClawReadResult, { ok: true }>> {
  const loaded = await readClawManifestFile(
    path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
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

describe("Claw manifest disclosure", () => {
  it.each(["@maker/workspace-agent", "workspace-agent", "@openclaw/workspace-agent"])(
    "includes the verified %s manifest in the real Add plan projection",
    async (name) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-claw-disclosure-"));
      const source = await verifiedSource(name);
      const config = { agents: { entries: {} } };
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      const projected = projectGatewayClawAddPlan(
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
      expect(() => projectClawManifestDisclosure(source, source.source)).toThrow(
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
    expect(() => projectClawManifestDisclosure(source, { ...source.source, ...changed })).toThrow(
      "source identity cannot be disclosed safely",
    );
  });
});

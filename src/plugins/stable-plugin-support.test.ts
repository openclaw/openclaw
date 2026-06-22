import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import checkedInStablePluginSupportManifest from "../../release/stable-plugin-support.json" with { type: "json" };
import { PluginInstallRecordShape } from "../config/zod-schema.installs.js";
import {
  computeStablePluginSupportDigest,
  type StablePluginSupportManifest,
  validateStablePluginSupportManifest,
} from "./stable-plugin-support.js";

type TestManifest = Record<string, unknown> & {
  coveredPlugins: Record<string, unknown>[];
};

function cloneManifest(): TestManifest {
  return JSON.parse(JSON.stringify(checkedInStablePluginSupportManifest)) as TestManifest;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => reverseObjectKeys(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toReversed()
        .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
    );
  }
  return value;
}

describe("stable plugin support manifest", () => {
  it("validates the first stable covered package set and digest", () => {
    const result = validateStablePluginSupportManifest(checkedInStablePluginSupportManifest, {
      repoRoot: path.resolve(__dirname, "../.."),
    });

    expect(result.coveredPackages).toEqual([
      "@openclaw/codex",
      "@openclaw/discord",
      "@openclaw/slack",
    ]);
    expect(result.coveredPackages).not.toContain("@openclaw/telegram");
    expect(result.coveredPackages).not.toContain("@openclaw/openai-provider");
    expect(result.stablePluginSupportSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.targetsByPackageName.get("@openclaw/slack")?.targetNpmSpec).toBe(
      "@openclaw/slack@2026.6.33",
    );
  });

  it("computes a deterministic digest independent of object key order", () => {
    expect(
      computeStablePluginSupportDigest(
        checkedInStablePluginSupportManifest as StablePluginSupportManifest,
      ),
    ).toBe(
      computeStablePluginSupportDigest(
        reverseObjectKeys(checkedInStablePluginSupportManifest) as StablePluginSupportManifest,
      ),
    );
  });

  it("rejects unsorted or incomplete covered packages", () => {
    const manifest = cloneManifest();
    manifest.coveredPlugins = [manifest.coveredPlugins[1], manifest.coveredPlugins[0]];

    expect(() => validateStablePluginSupportManifest(manifest)).toThrow(
      /coveredPlugins must be exactly/u,
    );
  });

  it("rejects support-state proof fields stored in the manifest", () => {
    const manifest = cloneManifest();
    manifest.supportState = "ready";
    const entry = manifest.coveredPlugins[0];
    entry.requiredProof = ["package-acceptance"];

    expect(() => validateStablePluginSupportManifest(manifest)).toThrow(/supportState/u);
    expect(() => validateStablePluginSupportManifest(manifest)).toThrow(/requiredProof/u);
  });

  it("rejects non-exact targets and wrong stable branch", () => {
    const manifest = cloneManifest();
    manifest.coveredPlugins[0] = {
      ...manifest.coveredPlugins[0],
      targetNpmSpec: "@openclaw/codex@latest",
      targetBranch: "main",
    };

    expect(() => validateStablePluginSupportManifest(manifest)).toThrow(/targetNpmSpec/u);
    expect(() => validateStablePluginSupportManifest(manifest)).toThrow(/targetBranch/u);
  });

  it("accepts stable patch targets on the first stable line", () => {
    const manifest = cloneManifest();
    manifest.coveredPlugins = manifest.coveredPlugins.map((entry) => ({
      ...entry,
      targetVersion: "2026.6.34",
      targetNpmSpec: `${entry.packageName}@2026.6.34`,
    }));

    expect(validateStablePluginSupportManifest(manifest).coveredPackages).toEqual([
      "@openclaw/codex",
      "@openclaw/discord",
      "@openclaw/slack",
    ]);
  });

  it("accepts install intent provenance fields in plugin install records", () => {
    const schema = z.object(PluginInstallRecordShape);

    expect(
      schema.parse({
        source: "npm",
        spec: "@openclaw/slack",
        resolvedSpec: "@openclaw/slack@2026.6.33",
        installIntentProvenance: "prior_default_intent_system_pin",
        installIntentProvenanceMigration: {
          id: "stable-plugin-install-intent-v1",
          source: "doctor:stable-plugin-install-intent",
          migratedAt: "2026-06-19T00:00:00.000Z",
          decision: "prior_default_intent_system_pin",
          evidence: {
            spec: "@openclaw/slack",
            resolvedSpec: "@openclaw/slack@2026.6.33",
            trustedSourceLinkedOfficialInstall: true,
          },
        },
      }),
    ).toMatchObject({
      installIntentProvenance: "prior_default_intent_system_pin",
    });
  });
});

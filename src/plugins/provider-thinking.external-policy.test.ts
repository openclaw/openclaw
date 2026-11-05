// Verifies cold thinking policy resolution for trusted external providers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { externalProviderPolicyRegistry } from "./provider-external-policy.test-support.js";

const fixtureState = vi.hoisted(() => ({ pluginRoot: "" }));
const envSnapshot = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
]);
const emptyBundledPluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-empty-plugins-"));
const externalPluginRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "openclaw-provider-policy-external-"),
);
fs.writeFileSync(
  path.join(externalPluginRoot, "provider-policy-api.js"),
  [
    "export function resolveThinkingProfile({ modelId }) {",
    '  return modelId === "full"',
    '    ? { levels: [{ id: "off" }, { id: "high" }, { id: "max" }], defaultLevel: "off" }',
    '    : { levels: [{ id: "off" }, { id: "low", label: "on" }], defaultLevel: "off" };',
    "}",
    "",
  ].join("\n"),
  "utf8",
);
fixtureState.pluginRoot = externalPluginRoot;
process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = emptyBundledPluginsDir;
process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

vi.mock("./current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => ({
    manifestRegistry: externalProviderPolicyRegistry(fixtureState.pluginRoot),
  }),
}));

const { isThinkingLevelSupported, listThinkingLevels, resolveThinkingDefaultForModel } =
  await import("../auto-reply/thinking.js");

afterAll(() => {
  envSnapshot.restore();
  fs.rmSync(emptyBundledPluginsDir, { recursive: true, force: true });
  fs.rmSync(externalPluginRoot, { recursive: true, force: true });
});

describe("trusted external provider thinking policy", () => {
  it("resolves a full profile without activating the provider runtime", () => {
    expect(listThinkingLevels("fixture-provider", "full")).toEqual(["off", "high", "max"]);
    expect(
      isThinkingLevelSupported({
        provider: "fixture-provider",
        model: "full",
        level: "max",
      }),
    ).toBe(true);
    expect(resolveThinkingDefaultForModel({ provider: "fixture-provider", model: "full" })).toBe(
      "off",
    );
  });

  it("keeps the fixture legacy model on its binary profile", () => {
    expect(listThinkingLevels("fixture-provider", "legacy")).toEqual(["off", "low"]);
    expect(
      isThinkingLevelSupported({
        provider: "fixture-provider",
        model: "legacy",
        level: "high",
      }),
    ).toBe(false);
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("discovers only decision models owned by the manifest without executing its runtime", () => {
  const root = tempDirs.make("manifest-decision-models-");
  fs.writeFileSync(path.join(root, "index.js"), "throw new Error('runtime must stay cold');");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { decisionProviders: ["fixture"] },
      decisionModels: [
        {
          provider: " fixture ",
          id: " fast ",
          name: " Fast decisions ",
          capabilities: {
            questionTypes: ["boolean", "choice", "score"],
            maxQuestions: 32,
            maxChoiceAlternatives: 64,
            maxScoreLevels: 64,
            maxInputTokens: 512,
            inputTokenScope: "encoded-question",
            requiresBooleanCriteria: true,
            confidence: "none",
          },
        },
        { provider: "fixture", id: "fast", name: "Duplicate" },
        { provider: "other", id: "foreign", name: "Unowned" },
        { provider: "fixture", id: "missing-name" },
        {
          provider: "fixture",
          id: "hosted",
          name: "Hosted",
          setup: [
            {
              kind: "api-key",
              label: "Fixture",
              help: "Add your API key",
              credentialPath: "apiKey",
            },
            { kind: "api-key", label: "Unsafe", help: "Ignored", credentialPath: "__proto__.key" },
          ],
        },
      ],
    }),
  );
  const result = loadPluginManifest(root);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  expect(result.manifest.decisionModels).toEqual([
    {
      provider: "fixture",
      id: "fast",
      name: "Fast decisions",
      capabilities: {
        questionTypes: ["boolean", "choice", "score"],
        maxQuestions: 32,
        maxChoiceAlternatives: 64,
        maxScoreLevels: 64,
        maxInputTokens: 512,
        inputTokenScope: "encoded-question",
        requiresBooleanCriteria: true,
        confidence: "none",
      },
    },
    {
      provider: "fixture",
      id: "hosted",
      name: "Hosted",
      setup: [
        { kind: "api-key", label: "Fixture", help: "Add your API key", credentialPath: "apiKey" },
      ],
    },
  ]);
  expect(result.manifest.providers ?? []).toEqual([]);
});

it("bounds provider metadata before discovery can expose it to tool diagnostics", () => {
  const root = tempDirs.make("manifest-decision-capabilities-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { decisionProviders: ["fixture"] },
      decisionModels: [
        {
          provider: "fixture",
          id: "bounded",
          name: "Bounded",
          capabilities: {
            questionTypes: ["boolean", "boolean"],
            maxQuestions: -1,
            maxChoiceAlternatives: 1.5,
            maxScoreLevels: Number.MAX_SAFE_INTEGER + 1,
            maxInputTokens: "private-provider-diagnostic",
            confidence: "private-provider-diagnostic",
            inputTokenScope: "private-provider-diagnostic",
            requiresBooleanCriteria: "true",
          },
        },
        {
          provider: "fixture",
          id: "invalid",
          name: "Invalid",
          capabilities: { questionTypes: ["private-provider-diagnostic"] },
        },
      ],
    }),
  );
  const result = loadPluginManifest(root);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  expect(result.manifest.decisionModels).toEqual([
    {
      provider: "fixture",
      id: "bounded",
      name: "Bounded",
      capabilities: { questionTypes: ["boolean"] },
    },
    { provider: "fixture", id: "invalid", name: "Invalid" },
  ]);
});

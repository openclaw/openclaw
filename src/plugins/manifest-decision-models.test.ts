import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
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
      decisionTasks: [
        { id: "fixture/route", title: " Routing ", description: " Choose a route " },
        { id: "fixture/route", title: "Duplicate" },
        { id: "other/route", title: "Foreign task" },
        { id: "fixture/nested/route", title: "Different entry owner" },
        { id: "decision_evaluate", title: "Core impersonation" },
        { id: "fixture/missing-title" },
        { id: "fixture/oversize-title", title: "x".repeat(129) },
        { id: "fixture/short", title: "Short", description: "x".repeat(1025) },
      ],
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
  ]);
  expect(result.manifest.providers ?? []).toEqual([]);
  expect(result.manifest.decisionTasks).toEqual([
    { id: "fixture/route", title: "Routing", description: "Choose a route" },
    { id: "other/route", title: "Foreign task" },
    { id: "fixture/nested/route", title: "Different entry owner" },
    { id: "decision_evaluate", title: "Core impersonation" },
    { id: "fixture/short", title: "Short" },
  ]);
});

it.each([
  { name: "single-entry", entries: ["index"], expected: [{ id: "pack", taskId: "pack/route" }] },
  {
    name: "multi-entry",
    entries: ["one", "two"],
    expected: [
      { id: "pack/one", taskId: "pack/one/route" },
      { id: "pack/two", taskId: "pack/two/route" },
    ],
  },
])("binds $name task declarations to exact effective record owners", ({ entries, expected }) => {
  const root = tempDirs.make("manifest-decision-tasks-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "pack",
      configSchema: { type: "object" },
      decisionTasks: [
        { id: "pack/route", title: "Routing" },
        { id: "pack/one/route", title: "Routing" },
        { id: "pack/two/route", title: "Routing" },
        { id: "pack/one/nested/route", title: "Unowned nested task" },
        { id: "foreign/route", title: "Foreign task" },
        { id: "decision_evaluate", title: "Core impersonation" },
      ],
    }),
  );
  const candidates = entries.map((entry) => {
    const id = entries.length === 1 ? "pack" : `pack/${entry}`;
    const source = path.join(root, `${entry}.js`);
    fs.writeFileSync(source, "throw new Error('runtime must stay cold');");
    return {
      idHint: id,
      ...(entries.length === 1 ? {} : { effectivePluginId: id }),
      source,
      rootDir: root,
      origin: "bundled" as const,
    };
  });
  const registry = loadPluginManifestRegistryCore({ candidates, installRecords: {} });
  expect(registry.diagnostics).toEqual([]);
  expect(registry.plugins.map(({ id, decisionTasks }) => ({ id, decisionTasks }))).toEqual(
    expected.map(({ id, taskId }) => ({
      id,
      decisionTasks: [{ id: taskId, title: "Routing" }],
    })),
  );
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

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { minimatch } from "minimatch";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashControlUiTranslationText,
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
} from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import {
  createControlUiLocaleSyncPlan,
  flattenTranslations,
} from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  CACHE_SAVE_V5,
  CACHE_V5,
  readWorkflow,
  runGit,
  runWorkflowShellScript,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const workflow = readWorkflow(".github/workflows/control-ui-locale-refresh.yml");
const steps: WorkflowStep[] = workflow.jobs.refresh.steps;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const memoryPaths = [
  "ui/src/i18n/.i18n/sv.tm.jsonl",
  "extensions/example/browser/i18n/.i18n/sv.tm.jsonl",
];

function stepNamed(name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error("Missing workflow step: " + name);
  }
  return step;
}

function evaluate(value: unknown, context: Record<string, unknown>): unknown {
  return runInNewContext(String(value).replace(/^\$\{\{|\}\}$/gu, ""), context);
}

function fingerprint(files: Record<string, string>, locale = "sv"): string {
  return String(
    evaluate(stepNamed("Resolve locale memory cache").env?.MEMORY_INPUTS, {
      matrix: { locale },
      format: (pattern: string, value: string) => pattern.replaceAll("{0}", value),
      hashFiles: (...patterns: string[]) => {
        const hash = createHash("sha256");
        for (const file of Object.keys(files).toSorted()) {
          if (patterns.some((pattern) => minimatch(file, pattern, { dot: true }))) {
            hash.update(createHash("sha256").update(files[file]!).digest());
          }
        }
        return hash.digest("hex");
      },
    }),
  );
}

function planAt(root: string, file: string, sourceFlat: Map<string, string>, force = false) {
  const translationMemory = loadControlUiTranslationMemory(path.join(root, file));
  return createControlUiLocaleSyncPlan({
    allowTranslate: true,
    cacheKeyFor: (key, hash) => key + ":" + hash,
    entry: { locale: "sv", exportName: "sv", fileName: "sv.ts", languageKey: "sv" },
    existingFlat: flattenTranslations(
      materializeControlUiLocaleCatalog(sourceFlat, translationMemory),
    ),
    force,
    hashText: hashControlUiTranslationText,
    previousMeta: null,
    sourceFlat,
    sourceHash: JSON.stringify([...sourceFlat]),
    sourcePath: "fixture/en.ts",
    translationMemory,
  });
}

function completePlan(plan: ReturnType<typeof planAt>, translations: [string, string][]) {
  plan.recordTranslations(plan.pending, new Map(translations), {
    sourceLocale: "en",
    updatedAt: () => "2026-10-16T00:00:00Z",
  });
  return plan.render({
    defaultGlossary: [],
    glossary: [],
    generatedAt: "2026-10-16T00:00:00Z",
    workflow: 1,
  });
}

function writeMemory(root: string, file: string, content: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

describe("Control UI locale refresh reuse", () => {
  it("retains completed locale work after source advancement without accepting stale text", () => {
    const restore = stepNamed("Restore completed locale memory");
    const save = stepNamed("Save completed locale memory");
    expect(restore.uses).toBe(CACHE_V5);
    expect(save.uses).toBe(CACHE_SAVE_V5);
    expect(restore.with?.path).toBe(save.with?.path);
    const patterns = String(restore.with?.path)
      .replaceAll("${{ matrix.locale }}", "sv")
      .trim()
      .split("\n");
    expect(
      [
        ...memoryPaths,
        "ui/src/i18n/.i18n/sv.meta.json",
        "ui/src/i18n/locales/en.ts",
        "extensions/example/browser/index.ts",
      ].filter((file) => patterns.some((pattern) => minimatch(file, pattern, { dot: true }))),
    ).toEqual(memoryPaths);
    expect(steps.indexOf(restore)).toBeLessThan(
      steps.indexOf(stepNamed("Refresh locale translations")),
    );
    expect(steps.indexOf(save)).toBeGreaterThan(
      steps.indexOf(stepNamed("Prepare locale artifact")),
    );
    expect(steps.indexOf(save)).toBeLessThan(steps.indexOf(stepNamed("Upload locale artifact")));

    const root = tempDirs.make("locale-reuse-");
    const files = Object.fromEntries(memoryPaths.map((file) => [file, ""]));
    const initialFingerprint = fingerprint(files);
    const original = new Map([
      ["keep", "Keep"],
      ["edit", "Old {count}"],
      ["remove", "Removed"],
    ]);
    for (const file of memoryPaths) {
      const first = planAt(root, file, original);
      expect(first.pending.map(({ key }) => key)).toEqual(["keep", "edit", "remove"]);
      const completed = completePlan(first, [
        ["keep", "Behåll"],
        ["edit", "Gammal {count}"],
        ["remove", "Borttagen"],
      ]);
      // Actions persists only the declared memory files; the next main checkout
      // has the same canonical TM baseline, not the previous run's metadata.
      writeMemory(root, file, completed.translationMemory);
      const nextSource = new Map([
        ["keep", "Keep"],
        ["edit", "New {name}"],
        ["add", "Added"],
      ]);
      files["ui/src/i18n/locales/en.ts"] = JSON.stringify([...nextSource]);
      expect(fingerprint(files)).toBe(initialFingerprint);
      const next = planAt(root, file, nextSource);
      expect(next.pending.map(({ key }) => key)).toEqual(["edit", "add"]);
      const result = completePlan(next, [
        ["edit", "Ny {name}"],
        ["add", "Tillagd"],
      ]);
      expect([...result.nextFlat]).toEqual([
        ["keep", "Behåll"],
        ["edit", "Ny {name}"],
        ["add", "Tillagd"],
      ]);
      expect(result.fallbackCount).toBe(0);
      expect(result.translationMemory).not.toContain("Borttagen");
      expect(planAt(root, file, nextSource, true).pending.map(({ key }) => key)).toEqual([
        "keep",
        "edit",
        "add",
      ]);
    }
  });

  it("invalidates reuse when canonical translations, fallback state, terminology or generation policy change", () => {
    const inputs = [
      ...memoryPaths,
      "ui/src/i18n/.i18n/sv.meta.json",
      "extensions/example/browser/i18n/.i18n/sv.meta.json",
      "ui/src/i18n/.i18n/glossary.sv.json",
      "scripts/control-ui-i18n.ts",
      "scripts/lib/control-ui-i18n-catalog-values.ts",
      "scripts/lib/control-ui-i18n-sync-plan.ts",
      "scripts/lib/control-ui-i18n-config.ts",
      "scripts/lib/control-ui-i18n-config.json",
      "scripts/lib/control-ui-plugin-i18n-catalog.ts",
      ".github/workflows/control-ui-locale-refresh.yml",
    ];
    const files = Object.fromEntries(inputs.map((file) => [file, file]));
    const baseline = fingerprint(files);
    for (const file of inputs) {
      expect(fingerprint({ ...files, [file]: "updated" }), file).not.toBe(baseline);
    }
    expect(fingerprint({ ...files, "ui/src/i18n/.i18n/fr.tm.jsonl": "another locale" })).toBe(
      baseline,
    );
    const restore = stepNamed("Restore completed locale memory");
    const save = stepNamed("Save completed locale memory");
    expect(restore.with?.["restore-keys"]).toBe("${{ steps.tm_cache_key.outputs.prefix }}-");
    expect(save.with?.key).toBe(restore.with?.key);
    // Unique immutable attempts let the newest successful incremental run replace
    // the seed; an exact immutable baseline key would strand subsequent progress.
    expect(String(save.with?.key)).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
  });

  it.skipIf(process.platform === "win32")(
    "rejects fallback workers before saving or handing off their patch",
    () => {
      const root = tempDirs.make("locale-artifact-");
      const runnerTemp = tempDirs.make("locale-runner-");
      runGit(root, ["init", "--quiet"]);
      const metadata = memoryPaths.map((file) => file.replace(".tm.jsonl", ".meta.json"));
      for (const file of memoryPaths) {
        writeMemory(root, file, "verified-memory\n");
      }
      for (const file of metadata) {
        writeMemory(root, file, JSON.stringify({ fallbackKeys: [] }));
      }
      const script = String(stepNamed("Prepare locale artifact").run);
      const run = () =>
        runWorkflowShellScript(script, {
          cwd: root,
          env: { ...process.env, LOCALE: "sv", RUNNER_TEMP: runnerTemp },
          linuxWorkflow: true,
        });
      for (const file of metadata) {
        writeMemory(root, file, JSON.stringify({ fallbackKeys: ["missing"] }));
        expect(run().status, file).not.toBe(0);
        expect(runGit(root, ["diff", "--cached", "--name-only"])).toBe("");
        writeMemory(root, file, JSON.stringify({ fallbackKeys: [] }));
      }
      expect(run().status).toBe(0);
      const patch = readFileSync(path.join(runnerTemp, "control-ui-locale-sv/sv.patch"), "utf8");
      for (const file of [...memoryPaths, ...metadata]) {
        expect(patch).toContain(file);
      }
    },
  );

  it.each([
    ["openclaw/openclaw", "refs/heads/main", false, true, true, true],
    ["openclaw/openclaw", "refs/heads/main", true, true, false, true],
    ["openclaw/openclaw", "refs/heads/main", false, false, false, false],
    ["openclaw/openclaw", "refs/tags/v1", false, true, false, false],
    ["openclaw/openclaw", "refs/pull/1/merge", false, true, false, false],
    ["fork/openclaw", "refs/heads/main", false, true, false, false],
  ])(
    "restricts cache admission: %s %s force=%s success=%s",
    (repository, ref, fullRefresh, success, canRestore, canSave) => {
      const context = {
        github: { repository, ref },
        inputs: { full_refresh: fullRefresh },
        success: () => success,
      };
      expect(evaluate(stepNamed("Restore completed locale memory").if, context)).toBe(canRestore);
      expect(evaluate(stepNamed("Save completed locale memory").if, context)).toBe(canSave);
    },
  );
});

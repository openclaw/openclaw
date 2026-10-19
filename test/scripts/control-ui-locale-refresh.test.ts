import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packControlUiLocaleArtifact,
  restoreControlUiLocaleArtifacts,
} from "../../scripts/control-ui-locale-artifacts.ts";
import {
  hashControlUiTranslationText,
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
} from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import {
  createControlUiLocaleSyncPlan,
  flattenTranslations,
} from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readWorkflow, runGit, type WorkflowStep } from "./ci-workflow.test-support.js";
import { prepareGeneratedPublisherFixture } from "./generated-publisher.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const locales = CONTROL_UI_LOCALE_ENTRIES.map((entry) => entry.locale);
const assetRoots = ["ui/src/i18n/.i18n", "extensions/example/browser/i18n/.i18n"];
const original = new Map([
  ["keep", "Keep"],
  ["edit", "Old {count}"],
  ["remove", "Removed"],
]);
const current = new Map([
  ["keep", "Keep"],
  ["edit", "New {name}"],
  ["add", "Added"],
]);
const workflow = readWorkflow(".github/workflows/control-ui-locale-refresh.yml");

function put(root: string, file: string, value: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), value);
}

function commit(root: string, message: string) {
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

function plan(root: string, assets: string, locale: string, sourceFlat = original, force = false) {
  const entry = CONTROL_UI_LOCALE_ENTRIES.find((candidate) => candidate.locale === locale)!;
  const memory = loadControlUiTranslationMemory(path.join(root, assets, locale + ".tm.jsonl"));
  return createControlUiLocaleSyncPlan({
    allowTranslate: true,
    cacheKeyFor: (key, hash) => key + ":" + hash,
    entry,
    existingFlat: flattenTranslations(materializeControlUiLocaleCatalog(sourceFlat, memory)),
    force,
    hashText: hashControlUiTranslationText,
    previousMeta: JSON.parse(readFileSync(path.join(root, assets, locale + ".meta.json"), "utf8")),
    sourceFlat,
    sourceHash: JSON.stringify([...sourceFlat]),
    sourcePath: "ui/src/i18n/locales/en.ts",
    translationMemory: memory,
  });
}

function translate(root: string, assets: string, locale: string, sourceFlat = original) {
  const planned = plan(root, assets, locale, sourceFlat);
  planned.recordTranslations(
    planned.pending,
    new Map([
      ["keep", "Behåll"],
      ["edit", sourceFlat === original ? "Gammal {count}" : "Ny {name}"],
      ["remove", "Borttagen"],
      ["add", "Tillagd"],
    ]),
    { sourceLocale: "en", updatedAt: () => "2026-10-19T00:00:00Z" },
  );
  const result = planned.render({
    defaultGlossary: [],
    glossary: [],
    generatedAt: "2026-10-19T00:00:00Z",
    workflow: 1,
  });
  put(root, assets + "/" + locale + ".tm.jsonl", result.translationMemory);
  put(root, assets + "/" + locale + ".meta.json", result.meta);
  expect(result.fallbackCount).toBe(0);
  return planned.pending.map(({ key }) => key);
}

async function createFixture(publisher = false) {
  const directory = tempDirs.make("locale-artifacts-");
  const parent = tempDirs.make("locale-reconciliation-");
  const publication = publisher
    ? prepareGeneratedPublisherFixture(parent, null, { noGeneratedChange: true, autoMerge: true })
    : undefined;
  const root = publication?.worktree ?? parent;
  if (!publication) {
    runGit(root, ["init", "--quiet", "--initial-branch=main"]);
  }
  runGit(root, ["config", "user.name", "Locale Fixture"]);
  runGit(root, ["config", "user.email", "locale@example.invalid"]);
  put(root, "package.json", JSON.stringify({ type: "module" }));
  put(root, "extensions/example/openclaw.plugin.json", '{"id":"example"}');
  put(
    root,
    "extensions/example/package.json",
    JSON.stringify({
      name: "@openclaw/example",
      type: "module",
      openclaw: {
        controlUi: "./browser/index.ts",
        build: { bundledDist: false },
        release: { publishToNpm: true },
      },
    }),
  );
  put(root, "extensions/example/browser/index.ts", "export {};\n");
  put(
    root,
    "extensions/example/browser/i18n/locales/en.ts",
    'export default { title: "Plugin" };\n',
  );
  put(root, "scripts/control-ui-i18n.ts", "generator policy\n");
  put(root, "source/input.txt", JSON.stringify([...original]));
  for (const locale of locales) {
    put(root, "ui/src/i18n/.i18n/glossary." + locale + ".json", "[]\n");
    for (const assets of assetRoots) {
      put(root, assets + "/" + locale + ".tm.jsonl", "");
      put(
        root,
        assets + "/" + locale + ".meta.json",
        JSON.stringify({
          locale,
          fallbackKeys: [],
          generatedAt: "before",
          sourceHash: "before",
          totalKeys: 0,
          translatedKeys: 0,
          workflow: 1,
        }),
      );
    }
  }
  // Reproduce a newly added locale, not a full 21-locale cold publication.
  for (const locale of locales.filter((candidate) => candidate !== "sv")) {
    for (const assets of assetRoots) {
      translate(root, assets, locale);
    }
  }
  const sourceCommit = commit(root, "canonical baseline");
  if (publication) {
    runGit(root, ["push", "--quiet", "origin", "main"]);
  }
  const identity = { sourceCommit, runId: "123", runAttempt: "1" };
  for (const locale of locales) {
    for (const assets of assetRoots) {
      translate(root, assets, locale);
    }
    await packControlUiLocaleArtifact({ root, directory, locale, identity });
  }
  // A new finalizer checkout has canonical metadata and memory, never workers' files.
  runGit(root, ["restore", "--worktree", "--", ...assetRoots]);
  return {
    root,
    directory,
    identity,
    publication,
    restore: () => restoreControlUiLocaleArtifacts({ root, directory, locales, identity }),
  };
}

function publish(fixture: NonNullable<Awaited<ReturnType<typeof createFixture>>["publication"]>) {
  const action = readWorkflow(".github/actions/publish-generated-pr/action.yml");
  const script = action.runs.steps.find(
    (step: WorkflowStep) => step.name === "Publish generated pull request",
  ).run;
  const result = spawnSync("bash", ["-c", script], {
    cwd: fixture.worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      ...fixture.env,
      GENERATED_PATHS: assetRoots.join("\n"),
      INVALIDATION_PATHS: "source/input.txt",
      CI_GIT_OWNER: path.resolve(".github/actions/git-owner/owner.py"),
      PUBLISH_ACTION_PATH: path.resolve(".github/actions/publish-generated-pr"),
    },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return fixture.inspect(result.stdout + result.stderr);
}

describe("same-run locale finalization", () => {
  it.skipIf(process.platform === "win32").each([false, true])(
    "reuses completed memory on fresh main and preserves terminal deferral (moves again=%s)",
    async (movesAgain) => {
      const f = await createFixture(true);
      put(f.root, "source/input.txt", JSON.stringify([...current]));
      const latest = commit(f.root, "source changed during workers");
      runGit(f.root, ["push", "--quiet", "origin", "main"]);
      expect(await f.restore()).toEqual({ sourceCommit: latest, invalidated: [] });
      for (const assets of assetRoots) {
        expect(translate(f.root, assets, "sv", current)).toEqual(["edit", "add"]);
        const memory = readFileSync(path.join(f.root, assets, "sv.tm.jsonl"), "utf8");
        expect(memory).toContain("Behåll");
        expect(memory).toContain("Ny {name}");
        expect(memory).not.toContain("Borttagen");
      }
      if (movesAgain) {
        const updater = tempDirs.make("locale-newer-main-");
        runGit(updater, ["clone", "--quiet", f.publication!.env.FAKE_ORIGIN, "."]);
        runGit(updater, ["config", "user.name", "Locale Fixture"]);
        runGit(updater, ["config", "user.email", "locale@example.invalid"]);
        put(updater, "source/input.txt", "new source after catch-up");
        commit(updater, "source moved again");
        runGit(updater, ["push", "--quiet", "origin", "main"]);
      }
      const outcome = publish(f.publication!);
      expect(outcome.branchExists).toBe(!movesAgain);
      if (movesAgain) {
        expect(outcome.summary).toContain(
          "Deferred stale generated output because generator inputs changed on main.",
        );
        expect(outcome.mergeCalls).toBe("");
      } else {
        expect(outcome.mergeCalls).toContain("--auto --squash --match-head-commit");
        expect(
          runGit(f.root, [
            "--git-dir",
            f.publication!.env.FAKE_ORIGIN,
            "show",
            "refs/heads/automation/locale:ui/src/i18n/.i18n/sv.tm.jsonl",
          ]),
        ).toContain("Ny {name}");
      }
    },
  );

  it("runs the workflow restore CLI with the bound attempt and exposes its fresh source", async () => {
    const f = await createFixture();
    put(f.root, "source/input.txt", JSON.stringify([...current]));
    const fresh = commit(f.root, "fresh finalizer checkout");
    const output = path.join(f.directory, "github-output");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        path.resolve("scripts/control-ui-locale-artifacts.ts"),
        "restore",
        f.directory,
      ],
      {
        cwd: f.root,
        encoding: "utf8",
        env: {
          ...process.env,
          LOCALE_SOURCE_COMMIT: f.identity.sourceCommit,
          LOCALE_SOURCE_LOCALES: JSON.stringify(locales),
          GITHUB_RUN_ID: f.identity.runId,
          GITHUB_RUN_ATTEMPT: f.identity.runAttempt,
          GITHUB_OUTPUT: output,
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("sha=" + fresh + "\ninvalidated=[]\n");
    expect(plan(f.root, assetRoots[0]!, "sv", current).pending.map(({ key }) => key)).toEqual([
      "edit",
      "add",
    ]);
  });

  it("retains completed workers when only the finalizer is retried in the same run", async () => {
    const f = await createFixture();
    await expect(
      restoreControlUiLocaleArtifacts({
        root: f.root,
        directory: f.directory,
        locales,
        identity: { ...f.identity, runAttempt: "2" },
      }),
    ).resolves.toEqual({ sourceCommit: f.identity.sourceCommit, invalidated: [] });
    expect(plan(f.root, assetRoots[0]!, "sv").pending).toEqual([]);
  });

  it("rejects a replacement history before importing matching artifact envelopes", async () => {
    const f = await createFixture();
    runGit(f.root, ["checkout", "--quiet", "--orphan", "replacement"]);
    commit(f.root, "unrelated canonical history");
    await expect(f.restore()).rejects.toThrow();
    expect(runGit(f.root, ["status", "--porcelain"])).toBe("");
  });

  it.each(["canonical", "metadata", "glossary", "policy", "ownership"])(
    "discards worker memory when %s changes without overwriting canonical inputs",
    async (change) => {
      const f = await createFixture();
      if (change === "canonical") {
        translate(f.root, assetRoots[0]!, "sv");
        const file = "ui/src/i18n/.i18n/sv.tm.jsonl";
        put(
          f.root,
          file,
          readFileSync(path.join(f.root, file), "utf8").replace("Behåll", "Korrigerad"),
        );
      } else if (change === "metadata") {
        put(
          f.root,
          "ui/src/i18n/.i18n/sv.meta.json",
          JSON.stringify({
            locale: "sv",
            fallbackKeys: ["keep"],
            generatedAt: "corrected",
            sourceHash: "before",
            totalKeys: 3,
            translatedKeys: 2,
            workflow: 1,
          }),
        );
      } else if (change === "glossary") {
        put(
          f.root,
          "ui/src/i18n/.i18n/glossary.sv.json",
          '[{"source":"Keep","target":"Korrigerad"}]',
        );
      } else if (change === "policy") {
        put(f.root, "scripts/control-ui-i18n.ts", "new generator policy");
      } else {
        put(
          f.root,
          "extensions/example/package.json",
          '{"name":"@openclaw/example","openclaw":{"build":{"bundledDist":false},"release":{"publishToNpm":true}}}',
        );
      }
      commit(f.root, "canonical correction");
      const before = readFileSync(path.join(f.root, assetRoots[0]!, "sv.tm.jsonl"), "utf8");
      const result = await f.restore();
      expect(result.invalidated).toEqual(
        change === "policy" || change === "ownership" ? locales : ["sv"],
      );
      expect(readFileSync(path.join(f.root, assetRoots[0]!, "sv.tm.jsonl"), "utf8")).toBe(before);
      if (change === "canonical") {
        expect(plan(f.root, assetRoots[0]!, "sv").pending).toEqual([]);
      }
      expect(
        plan(f.root, assetRoots[0]!, "sv", original, true).pending.map(({ key }) => key),
      ).toEqual(["keep", "edit", "remove"]);
    },
  );

  it.each(["source", "run", "attempt", "path", "duplicate", "fallback", "missing"])(
    "rejects %s artifact fan-in before any memory write",
    async (fault) => {
      const f = await createFixture();
      const target = path.join(f.directory, "sv.json");
      const artifact = JSON.parse(readFileSync(target, "utf8"));
      if (fault === "source") {
        artifact.sourceCommit = "a".repeat(40);
      }
      if (fault === "run") {
        artifact.runId = "999";
      }
      if (fault === "attempt") {
        artifact.runAttempt = "2";
      }
      if (fault === "path") {
        artifact.memories[1].path = "extensions/example/../../.github/workflows/evil.yml";
      }
      if (fault === "duplicate") {
        artifact.memories.push(artifact.memories[0]);
      }
      if (fault === "fallback") {
        artifact.memories[1].metadata.fallbackKeys = ["missing"];
      }
      if (fault === "missing") {
        artifact.memories = [];
      }
      writeFileSync(target, JSON.stringify(artifact));
      await expect(f.restore()).rejects.toThrow(/artifact/iu);
      expect(runGit(f.root, ["status", "--porcelain"])).toBe("");
      expect(existsSync(path.join(f.root, ".github/workflows/evil.yml"))).toBe(false);
    },
  );

  it("refuses producer fallbacks and a checkout outside the bound source", async () => {
    const f = await createFixture();
    const metadata = path.join(f.root, assetRoots[1]!, "sv.meta.json");
    const parsed = JSON.parse(readFileSync(metadata, "utf8"));
    parsed.fallbackKeys = ["missing"];
    writeFileSync(metadata, JSON.stringify(parsed));
    await expect(packControlUiLocaleArtifact({ ...f, locale: "sv" })).rejects.toThrow(
      "fallback-containing",
    );
    await expect(
      packControlUiLocaleArtifact({
        ...f,
        locale: "sv",
        identity: { ...f.identity, sourceCommit: "b".repeat(40) },
      }),
    ).rejects.toThrow("checkout differs");
  });

  it("uses only same-run transport and the unchanged terminal publisher", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const finalize: WorkflowStep[] = workflow.jobs.finalize.steps;
    expect(finalize.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe(
      "${{ github.event.repository.default_branch }}",
    );
    const download = finalize.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
    expect(download.with).not.toHaveProperty("github-token");
    expect(download.with).not.toHaveProperty("run-id");
    expect(download.with).not.toHaveProperty("repository");
    expect(finalize.at(-1)?.uses).toBe("./.github/actions/publish-generated-pr");
    for (const job of [workflow.jobs.refresh, workflow.jobs.finalize]) {
      expect(
        (job.steps as WorkflowStep[]).some((step) => step.uses?.startsWith("actions/cache")),
      ).toBe(false);
    }
  });
});

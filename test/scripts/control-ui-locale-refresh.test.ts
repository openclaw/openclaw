import { afterEach, expect, it } from "vitest";
import {
  packControlUiLocaleArtifact,
  restoreControlUiLocaleArtifacts,
} from "../../scripts/control-ui-locale-artifacts.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readWorkflow, type WorkflowStep } from "./ci-workflow.test-support.js";
import { fixtureGit } from "./release-publish.test-support.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const locales = CONTROL_UI_LOCALE_ENTRIES.map((entry) => entry.locale);
const assetRoots = ["ui/src/i18n/.i18n", "extensions/example/browser/i18n/.i18n"];
const core = assetRoots[0]!;
const svMemory = core + "/sv.tm.jsonl";
const svMetadata = core + "/sv.meta.json";
// Transport preserves opaque bytes; the finalizer suite proves translation semantics.
const workerMemory = (locale: string) => JSON.stringify({ locale, translated: "Behåll" }) + "\n";
const workflow = readWorkflow(".github/workflows/control-ui-locale-refresh.yml");
type Artifact = Record<"sourceCommit" | "runId" | "runAttempt", string> & {
  memories: Array<{ path: string; metadata: { fallbackKeys: string[] } }>;
};
const corruptions: Array<[string, (artifact: Artifact) => void]> = [
  ["source", (a) => Object.assign(a, { sourceCommit: "a".repeat(40) })],
  ["attempt", (a) => Object.assign(a, { runAttempt: "2" })],
  ["duplicate", (a) => a.memories.push(a.memories[0]!)],
  ["missing", (a) => Object.assign(a, { memories: [] })],
];

const metadata = (locale: string, overrides = {}) => ({
  locale,
  fallbackKeys: [],
  totalKeys: 0,
  translatedKeys: 0,
  ...overrides,
});

async function createFixture() {
  const directory = tempDirs.make("locale-artifacts-");
  const files = fixtureFiles(tempDirs.make("locale-reconciliation-"));
  const { root, write, json } = files;
  const git = fixtureGit(root, "Locale Fixture", "locale@example.invalid");
  const commit = () => {
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--initial-branch=main");
  json("package.json", { type: "module" });
  json("extensions/example/openclaw.plugin.json", { id: "example" });
  json("extensions/example/package.json", {
    name: "@openclaw/example",
    type: "module",
    openclaw: {
      controlUi: "./browser/index.ts",
      build: { bundledDist: false },
      release: { publishToNpm: true },
    },
  });
  write("extensions/example/browser/index.ts", "export {};\n");
  write("extensions/example/browser/i18n/locales/en.ts", 'export default { title: "Plugin" };\n');
  write("scripts/control-ui-i18n.ts", "generator policy\n");
  for (const locale of locales) {
    write("ui/src/i18n/.i18n/glossary." + locale + ".json", "[]\n");
    for (const assets of assetRoots) {
      write(assets + "/" + locale + ".tm.jsonl", "");
      json(assets + "/" + locale + ".meta.json", metadata(locale));
    }
  }
  const sourceCommit = commit();
  const identity = { sourceCommit, runId: "123", runAttempt: "1" };
  for (const locale of locales) {
    for (const assets of assetRoots) {
      write(assets + "/" + locale + ".tm.jsonl", workerMemory(locale));
      json(
        assets + "/" + locale + ".meta.json",
        metadata(locale, { totalKeys: 1, translatedKeys: 1 }),
      );
    }
    await packControlUiLocaleArtifact({ root, directory, locale, identity });
  }
  // A new finalizer checkout has canonical metadata and memory, never workers' files.
  git("restore", "--worktree", "--", ...assetRoots);
  return {
    ...files,
    git,
    commit,
    identity,
    artifacts: fixtureFiles(directory),
    pack: (selected = identity) =>
      packControlUiLocaleArtifact({ root, directory, locale: "sv", identity: selected }),
    restore: (runAttempt = identity.runAttempt) =>
      restoreControlUiLocaleArtifacts({
        root,
        directory,
        locales,
        identity: { ...identity, runAttempt },
      }),
  };
}

it("retains completed workers when only the finalizer is retried in the same run", async () => {
  const f = await createFixture();
  await expect(f.restore("2")).resolves.toEqual({
    sourceCommit: f.identity.sourceCommit,
    invalidated: [],
  });
  for (const assets of assetRoots) {
    expect(f.read(assets + "/sv.tm.jsonl")).toBe(workerMemory("sv"));
  }
});

it("rejects a replacement history before importing matching artifact envelopes", async () => {
  const f = await createFixture();
  f.git("checkout", "--quiet", "--orphan", "replacement");
  f.commit();
  await expect(f.restore()).rejects.toThrow();
  expect(f.git("status", "--porcelain")).toBe("");
});

it.each(["metadata", "policy", "ownership"])(
  "discards worker memory when %s changes without overwriting canonical inputs",
  async (change) => {
    const f = await createFixture();
    if (change === "metadata") {
      f.json(svMetadata, metadata("sv", { fallbackKeys: ["keep"] }));
    } else if (change === "policy") {
      f.write("scripts/control-ui-i18n.ts", "new generator policy");
    } else {
      f.json("extensions/example/package.json", {
        name: "@openclaw/example",
        openclaw: { build: { bundledDist: false }, release: { publishToNpm: true } },
      });
    }
    f.commit();
    const before = f.read(svMemory);
    const result = await f.restore();
    expect(result.invalidated).toEqual(
      change === "policy" || change === "ownership" ? locales : ["sv"],
    );
    expect(f.read(svMemory)).toBe(before);
  },
);

it.each(corruptions)(
  "rejects %s artifact fan-in before any memory write",
  async (_fault, corrupt) => {
    const f = await createFixture();
    const artifact: Artifact = JSON.parse(f.artifacts.read("sv.json"));
    corrupt(artifact);
    f.artifacts.json("sv.json", artifact);
    await expect(f.restore()).rejects.toThrow(/artifact/iu);
    expect(f.git("status", "--porcelain")).toBe("");
  },
);

it("refuses producer fallbacks and a checkout outside the bound source", async () => {
  const f = await createFixture();
  f.json(assetRoots[1] + "/sv.meta.json", metadata("sv", { fallbackKeys: ["missing"] }));
  await expect(f.pack()).rejects.toThrow("fallback-containing");
  await expect(f.pack({ ...f.identity, sourceCommit: "b".repeat(40) })).rejects.toThrow(
    "checkout differs",
  );
});

it("keeps locale transport read-only and restricted to the current run", () => {
  expect(workflow.permissions).toEqual({ contents: "read" });
  const finalize: WorkflowStep[] = workflow.jobs.finalize.steps;
  const download = finalize.find((step) => step.uses?.startsWith("actions/download-artifact@"))!;
  expect(
    Object.keys(download.with ?? {}).filter((key) =>
      ["github-token", "run-id", "repository"].includes(key),
    ),
  ).toEqual([]);
  for (const job of Object.values(workflow.jobs) as { steps: WorkflowStep[] }[]) {
    expect(
      (job.steps as WorkflowStep[]).some((step) => step.uses?.startsWith("actions/cache")),
    ).toBe(false);
  }
});

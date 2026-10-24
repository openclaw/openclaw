import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  packControlUiLocaleArtifact,
  restoreControlUiLocaleArtifacts,
} from "../../scripts/control-ui-locale-artifacts.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readWorkflow, runGit, type WorkflowStep } from "./ci-workflow.test-support.js";

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

function put(root: string, file: string, value: unknown) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
}
const read = (root: string, file: string) => readFileSync(path.join(root, file), "utf8");
const metadata = (locale: string, overrides = {}) => ({
  locale,
  fallbackKeys: [],
  totalKeys: 0,
  translatedKeys: 0,
  ...overrides,
});

function commit(root: string, message: string) {
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

async function createFixture() {
  const directory = tempDirs.make("locale-artifacts-");
  const root = tempDirs.make("locale-reconciliation-");
  runGit(root, ["init", "--quiet", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Locale Fixture"]);
  runGit(root, ["config", "user.email", "locale@example.invalid"]);
  put(root, "package.json", { type: "module" });
  put(root, "extensions/example/openclaw.plugin.json", { id: "example" });
  put(root, "extensions/example/package.json", {
    name: "@openclaw/example",
    type: "module",
    openclaw: {
      controlUi: "./browser/index.ts",
      build: { bundledDist: false },
      release: { publishToNpm: true },
    },
  });
  put(root, "extensions/example/browser/index.ts", "export {};\n");
  put(
    root,
    "extensions/example/browser/i18n/locales/en.ts",
    'export default { title: "Plugin" };\n',
  );
  put(root, "scripts/control-ui-i18n.ts", "generator policy\n");
  for (const locale of locales) {
    put(root, "ui/src/i18n/.i18n/glossary." + locale + ".json", "[]\n");
    for (const assets of assetRoots) {
      put(root, assets + "/" + locale + ".tm.jsonl", "");
      put(root, assets + "/" + locale + ".meta.json", metadata(locale));
    }
  }
  const sourceCommit = commit(root, "canonical baseline");
  const identity = { sourceCommit, runId: "123", runAttempt: "1" };
  for (const locale of locales) {
    for (const assets of assetRoots) {
      put(root, assets + "/" + locale + ".tm.jsonl", workerMemory(locale));
      put(
        root,
        assets + "/" + locale + ".meta.json",
        metadata(locale, { totalKeys: 1, translatedKeys: 1 }),
      );
    }
    await packControlUiLocaleArtifact({ root, directory, locale, identity });
  }
  // A new finalizer checkout has canonical metadata and memory, never workers' files.
  runGit(root, ["restore", "--worktree", "--", ...assetRoots]);
  return {
    root,
    directory,
    identity,
    restore: () => restoreControlUiLocaleArtifacts({ root, directory, locales, identity }),
  };
}

it("retains completed workers when only the finalizer is retried in the same run", async () => {
  const f = await createFixture();
  await expect(
    restoreControlUiLocaleArtifacts({
      ...f,
      locales,
      identity: { ...f.identity, runAttempt: "2" },
    }),
  ).resolves.toEqual({ sourceCommit: f.identity.sourceCommit, invalidated: [] });
  for (const assets of assetRoots) {
    expect(read(f.root, assets + "/sv.tm.jsonl")).toBe(workerMemory("sv"));
  }
});

it("rejects a replacement history before importing matching artifact envelopes", async () => {
  const f = await createFixture();
  runGit(f.root, ["checkout", "--quiet", "--orphan", "replacement"]);
  commit(f.root, "unrelated canonical history");
  await expect(f.restore()).rejects.toThrow();
  expect(runGit(f.root, ["status", "--porcelain"])).toBe("");
});

it.each(["metadata", "policy", "ownership"])(
  "discards worker memory when %s changes without overwriting canonical inputs",
  async (change) => {
    const f = await createFixture();
    if (change === "metadata") {
      put(f.root, svMetadata, metadata("sv", { fallbackKeys: ["keep"] }));
    } else if (change === "policy") {
      put(f.root, "scripts/control-ui-i18n.ts", "new generator policy");
    } else {
      put(f.root, "extensions/example/package.json", {
        name: "@openclaw/example",
        openclaw: { build: { bundledDist: false }, release: { publishToNpm: true } },
      });
    }
    commit(f.root, "canonical correction");
    const before = read(f.root, svMemory);
    const result = await f.restore();
    expect(result.invalidated).toEqual(
      change === "policy" || change === "ownership" ? locales : ["sv"],
    );
    expect(read(f.root, svMemory)).toBe(before);
  },
);

it.each(corruptions)(
  "rejects %s artifact fan-in before any memory write",
  async (_fault, corrupt) => {
    const f = await createFixture();
    const target = path.join(f.directory, "sv.json");
    const artifact: Artifact = JSON.parse(readFileSync(target, "utf8"));
    corrupt(artifact);
    writeFileSync(target, JSON.stringify(artifact));
    await expect(f.restore()).rejects.toThrow(/artifact/iu);
    expect(runGit(f.root, ["status", "--porcelain"])).toBe("");
  },
);

it("refuses producer fallbacks and a checkout outside the bound source", async () => {
  const f = await createFixture();
  put(f.root, assetRoots[1] + "/sv.meta.json", metadata("sv", { fallbackKeys: ["missing"] }));
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

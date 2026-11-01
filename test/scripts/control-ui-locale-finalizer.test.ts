import { afterAll, beforeAll, expect, test } from "vitest";
import { createLocaleFinalizerHarness } from "./control-ui-locale-finalizer.test-support.js";

const it = test.skipIf(process.platform === "win32");
const harness = createLocaleFinalizerHarness();
if (process.platform !== "win32") {
  beforeAll(() => harness.prepare());
  afterAll(() => harness.cleanup());
}
type Result = Awaited<ReturnType<typeof harness.run>>;
const id = (key: string) => "localeWorkflowProof." + key;
const delta = ["edit", "add"].map(id);
const translated = (r: Result, key: string, locale = "sv") =>
  r.memory(locale).find((entry) => entry.segment_id === id(key))?.translated;
const noEffects = (r: Result) =>
  expect(r).toMatchObject({ workerRequests: [], providerRequests: [], publicationCalls: [] });
const validated = (r: Result) => {
  expect(r.failure).toBe("");
};
const copies = {
  keep: "worker::Keep locale proof",
  edit: "finalizer::New locale proof {name}",
  add: "finalizer::Latest locale proof",
};
it.each([false, true])("re-pins main and defers only if it moves again: %s", async (movesAgain) => {
  const r = await harness.run({
    publish: true,
    advanceDuringCheckout: true,
    advanceAfterCatchup: movesAgain,
  });
  validated(r);
  expect(r).toMatchObject({ sourceAtSetup: r.fresh, admittedSource: r.fresh });
  expect(r.workerRequests).toHaveLength(1);
  expect(r.workerRequests[0]?.ids).toEqual(["keep", "edit", "remove"].map(id));
  expect(r.providerRequests).toHaveLength(22);
  expect(r.providerRequests[0]?.proof).toEqual({
    [id("edit")]: "New locale proof {name}",
    [id("add")]: "Latest locale proof",
  });
  for (const request of r.providerRequests) {
    expect(request.ids).toEqual(delta);
  }
  for (const [key, value] of Object.entries(copies)) {
    expect(translated(r, key)).toBe(value);
  }
  expect(translated(r, "remove")).toBeUndefined();
  expect(r.publication.branchExists, r.publication.summary).toBe(!movesAgain);
  expect(r.publicationCalls.some((call) => call.startsWith("pr create "))).toBe(!movesAgain);
  expect(r.publication.mainHead).toBe(movesAgain ? r.later : r.fresh);
  if (movesAgain) {
    expect(r.publication.summary).toContain(
      "Deferred stale generated output because generator inputs changed on main.",
    );
    expect(r.publication.mergeCalls).toBe("");
  } else {
    expect(r.publication.mergeCalls).toContain("--auto --squash --match-head-commit");
    const entries = r.publishedMemory("sv").filter((entry) => entry.segment_id.startsWith(id("")));
    expect(
      Object.fromEntries(entries.map((entry) => [entry.segment_id, entry.translated])),
    ).toEqual(Object.fromEntries(Object.entries(copies).map(([key, value]) => [id(key), value])));
  }
});

it.each([
  [undefined, copies.keep, false],
  ["glossary", "finalizer::Keep locale proof", true],
] as const)(
  "preserves full-refresh worker compatibility: %s",
  async (change, expected, retranslatesKeep) => {
    const r = await harness.run({ fullRefresh: true, change });
    validated(r);
    expect(r.workerRequests.flatMap((request) => request.ids)).toContain(id("keep"));
    expect(r.providerRequests.flatMap((request) => request.ids).includes(id("keep"))).toBe(
      retranslatesKeep,
    );
    expect(translated(r, "keep")).toBe(expected);
    // Forced replay must not overwrite this compatible sibling.
    expect(translated(r, "keep", "fr")).toBe("canonical::Keep locale proof");
  },
);

it("keeps a canonical correction through catch-up", async () => {
  const r = await harness.run({ change: "canonical" });
  validated(r);
  expect(translated(r, "keep")).toBe("Canonical correction");
});

it.each([
  { repository: "fork/openclaw", ref: "refs/heads/main" },
  { repository: "openclaw/openclaw", ref: "refs/heads/topic" },
])("rejects provenance before effects: $repository $ref", async (provenance) => {
  const r = await harness.run({ ...provenance, publish: true });
  noEffects(r);
  expect(r.publication.branchExists).toBe(false);
});

it("propagates failed publisher admission before effects", async () => {
  const r = await harness.run({ preflightAllowed: false, publish: true });
  expect(r.failure).toContain("Repository auto-merge must be enabled");
  noEffects(r);
});

it.each([
  ["foreign-run", "does not belong to this source and workflow attempt"],
  ["path", "invalid or duplicate memory path"],
  ["fallback", "fallback-containing locale artifact"],
] as const)("rejects %s before finalizer effects", async (artifactFault, error) => {
  const r = await harness.run({ artifactFault, publish: true });
  expect(r.workerRequests.length).toBeGreaterThan(0);
  expect(r).toMatchObject({
    providerRequests: [],
    publicationCalls: [],
    publication: { branchExists: false },
  });
  expect(r.failure).toContain(error);
});

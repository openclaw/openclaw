import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createVitestWorkerFixtureGraph } from "../../scripts/lib/vitest-worker-fixture-graph.mts";

it("closes shared and preserved output identities without admitting unrelated fixtures", () => {
  const directory = path.resolve("fixture-output/dist");
  const graph = createVitestWorkerFixtureGraph(directory);
  const preserved = "legacy-finalizer/src/";
  graph.chunk(preserved, "entry.js", [
    "shared.js",
    pathToFileURL(path.join(directory, preserved, "cleanup.js")).href,
    "node:fs",
    "external-package",
  ]);
  graph.chunk(preserved, "shared.js", ["entry.js"]);
  graph.chunk(preserved, "cleanup.js", []);
  graph.chunk("", "state/worker.js", ["worker-shared.js"]);
  graph.chunk("", "worker-shared.js", []);
  graph.chunk("", "unrelated-test.js", []);
  graph.chunk("", "shared.js", []);
  graph.asset("../node-host-launcher.mjs");
  graph.asset("assets/font.ttf");
  graph.asset("entry.js.map");
  expect(graph.select([preserved + "entry.js", "state/worker.js"])).toEqual([
    "../node-host-launcher.mjs",
    "assets/font.ttf",
    preserved + "cleanup.js",
    preserved + "entry.js",
    preserved + "shared.js",
    "state/worker.js",
    "worker-shared.js",
  ]);
});

it("uses the final standalone output when a later build replaces an entry", () => {
  const graph = createVitestWorkerFixtureGraph(path.resolve("fixture-output/dist"));
  graph.chunk("", "worker.js", ["old-shared.js"]);
  graph.chunk("", "old-shared.js", []);
  graph.chunk("", "worker.js", ["new-shared.js"]);
  graph.chunk("", "new-shared.js", []);
  expect(graph.select(["worker.js"])).toEqual(["new-shared.js", "worker.js"]);
});

it("rejects missing declared roots and missing internal absolute or relative edges", () => {
  const directory = path.resolve("fixture-output/dist");
  const graph = createVitestWorkerFixtureGraph(directory);
  expect(() => graph.select(["missing-root.js"])).toThrow("Fixture compiler output missing");
  graph.chunk("", "entry.js", ["./missing.js"]);
  expect(() => graph.select(["entry.js"])).toThrow("missing.js");
  graph.chunk("", "entry.js", [pathToFileURL(path.join(directory, "missing.js")).href]);
  expect(() => graph.select(["entry.js"])).toThrow("missing.js");
});

it("preserves external absolute dependency owners", () => {
  const directory = path.resolve("fixture-output/dist");
  const graph = createVitestWorkerFixtureGraph(directory);
  graph.chunk("", "entry.js", [pathToFileURL(path.resolve("installed-dependency/index.js")).href]);
  expect(graph.select(["entry.js"])).toEqual(["entry.js"]);
});

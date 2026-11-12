import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { cliRetainedCompositionRouteSubstitution } from "../../src/cli/cli-entrypoint.test-support.js";
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

it("cuts only substituted outgoing edges, retaining other namespaces, roots and shared imports", () => {
  const directory = path.resolve("fixture-output/dist");
  const graph = createVitestWorkerFixtureGraph(directory);
  const route = cliRetainedCompositionRouteSubstitution.outputPath;
  graph.chunk("", "entry.js", [pathToFileURL(path.join(directory, route)).href, "cli/route.js"]);
  graph.chunk("", route, ["unused.js", "shared.js"]);
  graph.chunk("", "unused.js", ["nested.js"]);
  graph.chunk("", "nested.js", []);
  graph.chunk("", "cli/route.js", ["live.js"]);
  graph.chunk("", "live.js", []);
  graph.chunk("", "worker.js", ["shared.js"]);
  graph.chunk("", "shared.js", []);
  graph.asset("../node-host-launcher.mjs");
  graph.asset("assets/font.ttf");
  const roots = ["entry.js", "worker.js"];
  const originalFiles = [
    "../node-host-launcher.mjs",
    "assets/font.ttf",
    "cli/route.js",
    "entry.js",
    route,
    "live.js",
    "nested.js",
    "shared.js",
    "unused.js",
    "worker.js",
  ];
  expect(graph.select(roots)).toEqual(originalFiles);
  expect(graph.select(roots, [route])).toEqual([
    "../node-host-launcher.mjs",
    "assets/font.ttf",
    "cli/route.js",
    "entry.js",
    route,
    "live.js",
    "shared.js",
    "worker.js",
  ]);
  // Declaring a root independently retains it even when the route also imported it.
  expect(graph.select([...roots, "unused.js"], [route])).toEqual(originalFiles);
  expect(graph.select([route], [route])).toEqual([
    "../node-host-launcher.mjs",
    "assets/font.ttf",
    route,
  ]);
});

it("rejects a missing substitution output instead of silently retaining its old closure", () => {
  const graph = createVitestWorkerFixtureGraph(path.resolve("fixture-output/dist"));
  graph.chunk("", "entry.js", []);
  expect(() => graph.select(["entry.js"], ["missing-route.js"])).toThrow(
    "Fixture substitution output missing: missing-route.js",
  );
});

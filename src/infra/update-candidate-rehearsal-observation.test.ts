import path from "node:path";
import { expect, it } from "vitest";
import { resolveUpdateCandidateStatePath } from "./update-candidate-paths.js";
import { projectUpdateCandidateStateObservation } from "./update-candidate-state-observation.js";

it("preserves actual shared and external family versions through the writer's exact mappings", () => {
  const live = "/live-profile";
  const privateRoot = "/private-rehearsal";
  const shared = path.join(live, "state/openclaw.sqlite");
  const external = "/external-agent/custom.sqlite";
  const privateShared = path.join(privateRoot, "state/openclaw.sqlite");
  // The writer projects the directory, not the whole database filename.
  const privateExternal = path.join(
    resolveUpdateCandidateStatePath(live, privateRoot, path.dirname(external)),
    path.basename(external),
  );
  const source = [
    { path: shared, userVersion: 7, contentVersion: 6 },
    { path: external, userVersion: 4 },
  ];
  const observed = projectUpdateCandidateStateObservation(
    privateRoot,
    [
      { sourcePath: shared, privatePath: privateShared },
      { sourcePath: external, privatePath: privateExternal },
    ],
    source,
    [
      { path: privateExternal, userVersion: 8 },
      { path: privateShared, userVersion: 9, contentVersion: 8 },
    ],
  );
  expect(observed.sourceStateVersions).toEqual(source);
  expect(observed.stateVersions).toEqual([
    { path: shared, userVersion: 9, contentVersion: 8 },
    { path: external, userVersion: 8 },
  ]);
});
it("publishes every raw source alias from its one physical observed copy", () => {
  const versions = [
    { path: "/live/agent.sqlite", userVersion: 1 },
    { path: "/live/link/../agent.sqlite", userVersion: 1 },
  ];
  expect(
    projectUpdateCandidateStateObservation(
      "/private",
      versions.map((entry) => ({
        sourcePath: entry.path,
        privatePath: "/private/physical.sqlite",
      })),
      versions,
      [{ path: "/private/physical.sqlite", userVersion: 2 }],
    ).stateVersions,
  ).toEqual(versions.map((entry) => ({ path: entry.path, userVersion: 2 })));
});
it("retains an observed missing family without inferring an unobserved absence", () => {
  const mapping = [{ sourcePath: "/live/missing.sqlite", privatePath: "/private/missing.sqlite" }];
  const source = [{ path: "/live/missing.sqlite", userVersion: null }];
  expect(
    projectUpdateCandidateStateObservation("/private", mapping, source, [
      { path: "/private/missing.sqlite", userVersion: null },
    ]).stateVersions,
  ).toEqual(source);
  expect(() => projectUpdateCandidateStateObservation("/private", mapping, source, [])).toThrow(
    "every retained private database",
  );
});
it("refuses unknown post-migration databases or a mapping outside the private root", () => {
  const source = [{ path: "/live/state.sqlite", userVersion: 1 }];
  expect(() =>
    projectUpdateCandidateStateObservation(
      "/private",
      [{ sourcePath: source[0]!.path, privatePath: "/private/state.sqlite" }],
      source,
      [{ path: "/private/unknown.sqlite", userVersion: 2 }],
    ),
  ).toThrow("unmapped");
  expect(() =>
    projectUpdateCandidateStateObservation(
      "/private",
      [{ sourcePath: source[0]!.path, privatePath: "/live/state.sqlite" }],
      source,
      [{ path: "/live/state.sqlite", userVersion: 2 }],
    ),
  ).toThrow("escaped");
});

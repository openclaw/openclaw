import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { resolveStatePortRoots, statePortProvider } from "./state-port.js";

const stateDir = path.resolve("/synthetic/selected");
const home = path.resolve("/synthetic/home");
const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_STATE_DIR: "/unselected",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};

it.each<{
  label: string;
  config: OpenClawConfig;
  roots: string[];
}>([
  { label: "selected and retained default", config: {}, roots: [] },
  {
    label: "disabled custom store",
    config: {
      plugins: { entries: { "voice-call": { enabled: false, config: { store: "~/calls" } } } },
    },
    roots: [path.join(home, "calls")],
  },
  {
    label: "both configured package aliases",
    config: {
      plugins: {
        enabled: false,
        entries: {
          "voice-call": { config: { store: path.join(home, "first") } },
          "@openclaw/voice-call": { config: { store: path.join(home, "second") } },
        },
      },
    },
    roots: [path.join(home, "first"), path.join(home, "second")],
  },
  {
    label: "duplicate custom store and excluded Matrix account roots",
    config: {
      plugins: {
        entries: {
          "voice-call": { config: { store: path.join(stateDir, "voice-calls") } },
        },
      },
      channels: {
        matrix: {
          homeserver: "https://matrix.example.test",
          accounts: {
            main: { userId: "@main:example.test" },
            retained: { enabled: false, userId: "@retained:example.test" },
          },
        },
      },
    },
    roots: [],
  },
])("discovers $label with the optional plugin absent", ({ config, roots }) => {
  expect(resolveStatePortRoots({ config, stateDir, env })).toEqual(
    [stateDir, path.join(stateDir, "voice-calls"), ...roots].map((root) =>
      path.join(root, "state", "openclaw.sqlite"),
    ),
  );
});

it.each(
  [24, 25, 26].flatMap((version) => [
    { version, profiles: false },
    { version, profiles: true },
  ]),
)(
  "selects only present fragment catalogs for v$version with profiles=$profiles",
  async ({ version, profiles }) => {
    const descriptor = await statePortProvider.loadDescriptor(undefined, version);
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(descriptor.sqlite);
    if (profiles) {
      source.exec(
        descriptor.fragments!.find((fragment) => fragment.id === "user_profiles")!.sqlite,
      );
    }
    const admitted = await admitDatabasePortDescriptor(
      { engine: "sqlite", db: source },
      descriptor,
    );
    expect(admitted.activeFragments).toEqual(profiles ? ["user_profiles"] : []);
    const tables = source
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    expect(
      admitted.expectedCatalog.filter((fact) => fact.kind === "table").map((fact) => fact.table),
    ).toEqual(expect.arrayContaining(tables));
    expect(admitted.expectedCatalog.filter((fact) => fact.kind === "table")).toHaveLength(
      tables.length,
    );
    for (const table of ["acp_replay_events", "skill_usage"]) {
      expect(
        admitted.expectedCatalog.filter((fact) => fact.table === table && fact.kind === "indexes"),
      ).toEqual([
        {
          table,
          kind: "indexes",
          value: source.prepare(`PRAGMA index_list(${table})`).all().length,
        },
      ]);
    }
  },
);

import { afterEach, expect, it } from "vitest";
import {
  withDatabaseEngineSelection as withSelection,
  getDatabaseEngineInput as getInput,
  getDatabaseEngineSelection as getSelection,
  installDatabaseEngineSelection as install,
  type DatabaseEngineSelection as Selection,
} from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";

const sqliteEngines: Selection["effectiveEngines"] = {
  state: "sqlite",
  agent: "sqlite",
  workboard: "sqlite",
  logbook: "sqlite",
  "team-reports": "sqlite",
  quarantine: "sqlite",
  "managed-update": "sqlite",
  "package-activation": "sqlite",
};
const postgres = { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" };
const selection = (family?: keyof Selection["effectiveEngines"], input = postgres): Selection => ({
  effectiveEngines: { ...sqliteEngines, ...(family ? { [family]: "postgres" } : {}) },
  ...(family ? { postgres: input } : {}),
});
afterEach(resetDatabaseEngineSelectionForTest);

it.each([undefined, "state"] as const)(
  "publishes an immutable, idempotent selection: %s",
  async (family) => {
    const readLater = () => Promise.resolve().then(getSelection);
    expect(getSelection()).toBeUndefined();
    const pending = readLater();
    install(selection(family));
    const selected = getSelection();
    expect(selected).toEqual(selection(family));
    expect(await pending).toBe(selected);
    expect(await readLater()).toBe(selected);
    expect([getInput("state"), getInput("agent"), getInput("workboard")]).toEqual([
      family ? postgres : undefined,
      undefined,
      undefined,
    ]);
    expect([selected, selected?.effectiveEngines, selected?.postgres].map(Object.isFrozen)).toEqual(
      [true, true, true],
    );
    install(selection(family, { ...postgres }));
    expect(getSelection()).toBe(selected);
  },
);

it.each([
  [selection(), selection("workboard")],
  [
    selection("state"),
    selection("state", { ...postgres, connection: "postgresql://localhost/other" }),
  ],
  [selection("state"), selection("state", { ...postgres, schemaPrefix: "other" })],
  [selection("state"), selection("workboard")],
])(
  "refuses replacing the installed engine, family, connection or namespace %#",
  (before, after) => {
    install(before);
    expect(() => install(after)).toThrow(/conflicts with the installed process selection.*restart/);
    expect(getSelection()).toBe(before);
  },
);

it("scopes the family map across awaits without replacing the boot selection", async () => {
  const boot = selection("state");
  install(boot);
  await withSelection(selection("agent"), async () => {
    await Promise.resolve();
    expect([getInput("state"), getInput("agent")]).toEqual([undefined, postgres]);
  });
  expect(getSelection()).toBe(boot);
  expect([getInput("state"), getInput("agent")]).toEqual([postgres, undefined]);
});

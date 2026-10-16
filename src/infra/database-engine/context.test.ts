import { afterEach, expect, it } from "vitest";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";

afterEach(resetDatabaseEngineSelectionForTest);

it("isolates an offline target selection across awaits without replacing boot selection", async () => {
  const input = { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" };
  installDatabaseEngineSelection({ input });
  await withDatabaseEngineSelection({ input: undefined }, async () => {
    await Promise.resolve();
    expect(getDatabaseEngineSelection()).toEqual({ input: undefined });
  });
  expect(getDatabaseEngineSelection()).toEqual({ input });
});

it("publishes one immutable selection to existing and new async callers", async () => {
  const readLater = async () => {
    await Promise.resolve();
    return getDatabaseEngineSelection();
  };
  const pending = readLater();
  const input = { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" };
  installDatabaseEngineSelection({ input });
  const selected = getDatabaseEngineSelection();
  expect(await pending).toBe(selected);
  expect(await readLater()).toBe(selected);
  expect(selected?.input).toEqual(input);
  expect(Object.isFrozen(input)).toBe(true);
  expect(Object.isFrozen(selected)).toBe(true);
  installDatabaseEngineSelection({ input: { ...input } });
  expect(getDatabaseEngineSelection()).toBe(selected);
});

it("keeps an explicit SQLite selection and refuses a different engine", () => {
  expect(getDatabaseEngineSelection()).toBeUndefined();
  installDatabaseEngineSelection({ input: undefined });
  const selected = getDatabaseEngineSelection();
  expect(selected).toEqual({ input: undefined });
  installDatabaseEngineSelection({ input: undefined });
  expect(() =>
    installDatabaseEngineSelection({
      input: { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" },
    }),
  ).toThrow("conflicts with the installed process selection");
  expect(getDatabaseEngineSelection()).toBe(selected);
});

it.each([
  { connection: "postgresql://localhost/other", schemaPrefix: "test" },
  { connection: "postgresql://localhost/synthetic", schemaPrefix: "other" },
  undefined,
])("refuses to replace PostgreSQL connection or namespace: %j", (input) => {
  installDatabaseEngineSelection({
    input: { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" },
  });
  const selected = getDatabaseEngineSelection();
  expect(() => installDatabaseEngineSelection({ input })).toThrow(
    "conflicts with the installed process selection",
  );
  expect(getDatabaseEngineSelection()).toBe(selected);
});

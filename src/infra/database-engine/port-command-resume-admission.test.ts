import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import "./database-suite-workers.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { seedPortSqlite } from "./port-command.integration.test-support.js";
import { executeDatabasePortTask } from "./port-command.worker.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const admit = vi.hoisted(() => vi.fn());
vi.mock("./port-provider-descriptor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./port-provider-descriptor.js")>();
  return {
    ...actual,
    loadDatabasePortDescriptor: async (
      ...args: Parameters<typeof actual.loadDatabasePortDescriptor>
    ) => ({ ...(await actual.loadDatabasePortDescriptor(...args)), admit }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const assertCurrent = () => {};
const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

it("reruns descriptor admission when resuming a verified staging target", async () => {
  const directory = tempDirs.make("port-resume-admission-");
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");
  seedPortSqlite(
    sourcePath,
    `${metadata.sqlite};
    INSERT INTO workboard_schema_migrations VALUES ('schema-${metadata.version}', 1);
    INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', 'private', 1, 1)`,
  );
  const task = {
    operation: "stage" as const,
    sourcePath,
    targetPath,
    to: "sqlite" as const,
    namespace: "unused",
    storeId: randomUUID(),
    config: {},
  };
  const run = (resume = false) => executeDatabasePortTask({ ...task, resume }, assertCurrent);

  admit.mockRejectedValue(new Error("synthetic descriptor refusal"));
  await expect(run()).rejects.toThrow("synthetic descriptor refusal");
  const anchor = await hash(targetPath);
  assert(anchor);

  const resumed = await run(true).catch((error: unknown) => error);
  expect(resumed).toBeInstanceOf(Error);
  expect(String(resumed)).toContain("synthetic descriptor refusal");
  expect(admit).toHaveBeenCalledTimes(2);
  expect(await hash(targetPath)).toBe(anchor);

  admit.mockResolvedValue(undefined);
  await expect(run(true)).resolves.toMatchObject({ verification: expect.any(Object) });
  expect(admit).toHaveBeenCalledTimes(3);
  expect(await hash(targetPath)).toBe(anchor);
});

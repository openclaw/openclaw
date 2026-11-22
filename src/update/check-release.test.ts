import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-schema-versions.js";
import { checkRelease } from "./check-release.js";

let root: string;
let env: NodeJS.ProcessEnv;
let configPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-check-release-"));
  env = {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_HOME: root,
    HOME: root,
    USERPROFILE: root,
  };
  configPath = path.join(root, "openclaw.json");
  await fs.copyFile("test/fixtures/config-corpus/enabled-only.json", configPath);
  await fs.mkdir(path.join(root, "state"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("checks the repository config fixture on old-schema state without migrating or writing artifacts", async () => {
  const file = path.join(root, "state", "openclaw.sqlite");
  const db = openNodeSqliteDatabase(file);
  // An older store need not have any current tables for metadata discovery.
  db.exec("PRAGMA user_version=1");
  db.close();
  const before = await fs.readFile(file);
  const configBefore = await fs.readFile(configPath);
  const filesBefore = listDirectoryTreeStrictSync(root);
  const result = await checkRelease({ env, configPath });
  expect(result).toMatchObject({ ok: true });
  expect(result.surfaces).toContainEqual({ plugin: "openai", surface: "manifest" });
  expect(await fs.readFile(file)).toEqual(before);
  expect(await fs.readFile(configPath)).toEqual(configBefore);
  expect(listDirectoryTreeStrictSync(root)).toEqual(filesBefore);
});

it.each(["state", "agent"] as const)(
  "refuses a newer %s schema by reading its file directly",
  async (kind) => {
    const dir =
      kind === "state" ? path.join(root, "state") : path.join(root, "agents", "main", "agent");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, kind === "state" ? "openclaw.sqlite" : "openclaw-agent.sqlite");
    const db = openNodeSqliteDatabase(file);
    db.exec(
      `PRAGMA user_version=${(kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION) + 1}`,
    );
    db.close();
    const before = await fs.readFile(file);
    expect(await checkRelease({ env, configPath })).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`${kind}-schema-newer`),
    });
    expect(await fs.readFile(file)).toEqual(before);
  },
);

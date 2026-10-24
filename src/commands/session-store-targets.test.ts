import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { resolveCommandSessionStoreTargets } from "./session-store-targets.js";

const resolveSessionStoreTargetsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveSessionStoreTargets: resolveSessionStoreTargetsMock,
}));

function createDatabase(pathname: string, table: string): void {
  const database = new DatabaseSync(pathname);
  if (table === "schema_meta") {
    database.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT
      );
      INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
      VALUES ('primary', 'agent', 0, 'main');
    `);
  } else {
    database.exec(`CREATE TABLE ${table} (meta_key TEXT PRIMARY KEY)`);
  }
  database.close();
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.clearAllMocks());
const storePathFor = (name: string) => path.join(tempDirs.make("session-target-"), name);
const resolve = (opts: Parameters<typeof resolveCommandSessionStoreTargets>[0]["opts"] = {}) =>
  resolveCommandSessionStoreTargets({ cfg: {}, opts });
const mockTarget = (storePath: string) =>
  resolveSessionStoreTargetsMock.mockReturnValue([{ agentId: "main", storePath }]);

it("returns targets from the shared config helper", () => {
  mockTarget("/tmp/main-sessions.json");
  expect(resolve()).toEqual([{ agentId: "main", storePath: "/tmp/main-sessions.json" }]);
  expect(resolveSessionStoreTargetsMock).toHaveBeenCalledWith({}, {});
});

it.each([
  new AgentSelectionRequiredError(["main", "analyst"]),
  new Error("Unknown agent id: ghost"),
])("routes $message through its CLI failure owner", (error) => {
  resolveSessionStoreTargetsMock.mockImplementation(() => {
    throw error;
  });
  const selectionRequired = error instanceof AgentSelectionRequiredError;
  expect(() => resolve(selectionRequired ? {} : { agent: "ghost" })).toThrow(
    selectionRequired
      ? expect.objectContaining({
          name: "AgentSelectionRequiredError",
          agentIds: ["main", "analyst"],
          message: expect.stringContaining(
            "session-store selection has no explicit owner. Pass --agent <id> to select one agent, or --all-agents",
          ),
        })
      : ExpectedCliError,
  );
});

it.each(["missing", "suffixless", "directory", "non-database", "foreign-database"] as const)(
  "rejects a %s explicit store through the CLI failure owner",
  (storeKind) => {
    const storePath = storePathFor(
      storeKind === "suffixless" ? "requested-store" : `${storeKind}.sqlite`,
    );
    const resolvedPath = storeKind === "suffixless" ? `${storePath}.sqlite` : storePath;
    if (storeKind === "suffixless" || storeKind === "directory") {
      fs.mkdirSync(storePath);
    } else if (storeKind === "non-database") {
      fs.writeFileSync(storePath, "not a db");
    } else if (storeKind === "foreign-database") {
      createDatabase(storePath, "unrelated");
    }
    mockTarget(storePath);
    expect(() => resolve({ store: storePath })).toThrow(
      expect.objectContaining({
        name: "ExpectedCliError",
        message: expect.stringMatching(
          /resolved SQLite target exists|not a session store|not a regular file/iu,
        ),
        humanOutput: expect.stringContaining(resolvedPath),
        machineOutput: expect.stringContaining(resolvedPath),
      }),
    );
  },
);

it.each([
  ["legacy JSON locator", "sessions.json", "openclaw-agent.main.sqlite"],
  ["suffixless locator", "offline-store", "offline-store.main.sqlite"],
])("accepts an existing SQLite target resolved from a %s", (_name, locator, target) => {
  const storePath = storePathFor(locator);
  createDatabase(path.join(path.dirname(storePath), target), "schema_meta");
  mockTarget(storePath);
  expect(resolve({ store: storePath })).toEqual([{ agentId: "main", storePath }]);
});

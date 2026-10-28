import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { stateOwnerEnv } from "./cli-process-fixture.test-support.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const lock = (env: NodeJS.ProcessEnv, port?: number) =>
  acquireGatewayLock({ env, port, allowInTests: true, timeoutMs: 0 });
const createFixture = (root: string) =>
  createCliProcessFixture(root, stateOwnerEnv(root), localStateOwnerFixtureEntrypoint);

let root: string;
let owner: GatewayLockHandle | null;
let claim: TestPortClaim;
let config: string;
let fixture: ReturnType<typeof createFixture>;

beforeAll(async () => {
  root = roots.make("openclaw-agent-roster-owner-");
  fixture = createFixture(root);
  claim = await acquireTestPortBlock({ offsets: [0] });
  config = JSON.stringify({
    agents: { ownership: "explicit", defaults: { skipBootstrap: true }, entries: { main: {} } },
    gateway: { mode: "local", port: claim.port },
  });
  await fs.writeFile(fixture.configPath, config);
  openOpenClawStateDatabase({ env: fixture.env });
  await closeOpenClawStateDatabaseAsync();
  owner = await lock(fixture.env, claim.port);
  expect(owner).not.toBeNull();
});
afterAll(async () => {
  await owner?.release();
  await claim.release();
});

it.each([
  ["advanced creation", "agents add advanced --role researcher --workspace WORKSPACE --json"],
  ["team creation", "agents team create --workspace-root WORKSPACE --non-interactive --json"],
  ["detach", "agents detach traveler --force --json"],
])("refuses live %s before creating state", async (name, args) => {
  const workspace = path.join(root, `uncreated-${name.replaceAll(" ", "-")}`);
  const result = await fixture.run(
    args.split(" ").map((arg) => (arg === "WORKSPACE" ? workspace : arg)),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toContain("exclusive offline state ownership");
  expect(result.stderr).toContain("stop the Gateway");
  expect(await fs.readFile(fixture.configPath, "utf8")).toBe(config);
  await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});

it("creates the roster and workspace after the Gateway releases ownership", async () => {
  await owner?.release();
  owner = null;
  const workspace = path.join(root, "offline-workspace");
  const result = await fixture.run([
    ..."agents add offline --workspace".split(" "),
    workspace,
    "--non-interactive",
    "--json",
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ agentId: "offline", workspace });
  const next = await fixture.run(["agents", "list", "--json"]);
  expect(next.code, next.stderr).toBe(0);
  expect(JSON.parse(next.stdout)).toContainEqual(
    expect.objectContaining({ id: "offline", workspace }),
  );
  expect((await fs.stat(workspace)).isDirectory()).toBe(true);
  const successor = await lock(fixture.env);
  expect(successor).not.toBeNull();
  await successor?.release();
});

it("completes offline onboarding and releases ownership for Gateway startup", async () => {
  const offline = createFixture(roots.make("openclaw-onboard-offline-"));
  const workspace = path.join(offline.env.HOME, "workspace");
  const result = await offline.run([
    ..."onboard --non-interactive --accept-risk --agent-name first --workspace".split(" "),
    workspace,
    ..."--auth-choice skip --skip-skills --skip-channels --skip-ui --skip-health --json".split(" "),
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect((await fs.stat(workspace)).isDirectory()).toBe(true);
  const saved = JSON.parse(await fs.readFile(offline.configPath, "utf8"));
  expect(saved.agents.entries.first).toBeDefined();
  const successor = await lock(offline.env);
  expect(successor).not.toBeNull();
  await successor?.release();
});

it.each(["fresh", "persisted-session", "detach-retiring", "retiring", "missing-journal"] as const)(
  "recovers only an existing preserve-store detach (%s)",
  async (phase) => {
    const root = roots.make("openclaw-offline-detach-");
    const offline = createCliProcessFixture(root, stateOwnerEnv(root));
    const agentDir = path.join(offline.env.OPENCLAW_STATE_DIR, "agents/traveler/agent");
    const workspace = path.join(offline.env.HOME, "traveler-workspace");
    const before = {
      agents: {
        ownership: "explicit",
        defaults: { skipBootstrap: true },
        entries: { keeper: {}, traveler: { workspace } },
      },
    };
    await offline.writeConfig(before);
    const database = openOpenClawStateDatabase({ env: offline.env });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const marker = path.join(workspace, "IDENTITY.md");
    await fs.writeFile(marker, "Retained traveler identity.\n");
    if (phase === "persisted-session") {
      runOpenClawAgentWriteTransaction(
        (agent) =>
          writeSessionEntry(agent, "agent:traveler:handoff", {
            sessionId: "synthetic-retained-session",
            updatedAt: 1,
          }),
        { agentId: "traveler", env: offline.env },
      );
      await closeOpenClawAgentDatabasesAsync();
    } else if (phase === "missing-journal") {
      database.db.exec("DROP TABLE agent_deletion_journal");
    } else if (phase !== "fresh") {
      beginAgentDeletionJournal(
        {
          agentId: "traveler",
          operationId: "synthetic-interrupted-detach",
          agentDir,
          workspaceDir: workspace,
          sessionsDir: path.join(offline.env.OPENCLAW_STATE_DIR, "agents/traveler/sessions"),
          phase,
          deleteFiles: false,
        },
        { env: offline.env },
      );
    }
    await closeOpenClawStateDatabaseAsync();
    const result = await offline.run(["agents", "detach", "traveler", "--force", "--json"]);
    const saved = JSON.parse(await fs.readFile(offline.configPath, "utf8"));
    expect(await fs.readFile(marker, "utf8")).toBe("Retained traveler identity.\n");
    if (phase === "fresh" || phase === "persisted-session" || phase === "detach-retiring") {
      const diagnostic = JSON.stringify({
        ...result,
        journal: readAgentDeletionJournal("traveler", { env: offline.env }),
        config: saved,
      });
      expect(result.code, diagnostic).toBe(0);
      expect(result.stdout.trim(), diagnostic).not.toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        agentId: "traveler",
        detached: true,
        storePreserved: true,
      });
      expect(saved.agents.entries.traveler).toBeUndefined();
      expect(readAgentDeletionJournal("traveler", { env: offline.env })).toMatchObject({
        phase: "detach-retiring",
        cleanupCompleted: true,
        deleteFiles: false,
      });
    } else {
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining(
            phase === "retiring" ? "finish agents.delete" : "Agent deletion journal missing",
          ),
        },
      });
      expect(saved).toEqual(before);
      if (phase === "missing-journal") {
        expect(() => readAgentDeletionJournal("traveler", { env: offline.env })).toThrow(
          "Agent deletion journal missing",
        );
      } else {
        expect(readAgentDeletionJournal("traveler", { env: offline.env })).toMatchObject({
          operationId: "synthetic-interrupted-detach",
          phase: "retiring",
          cleanupCompleted: false,
        });
      }
    }
    await closeOpenClawStateDatabaseAsync();
  },
);

import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type * as GatewayCallModule from "../gateway/call.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import type { GatewayRequestOptions } from "../gateway/server-methods/types.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { buildProgram } from "./program/build-program.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GatewayCallModule>()),
  callGateway: transport.call,
}));

const skill =
  "---\nname: release-notes\ndescription: Draft release notes from merged PRs\n---\nUse the merged changelog.\n";
const support = "Check the release tag before publishing.\n";
const version = "20260929T010203004Z-archive";
const changeId = "11111111-1111-4111-8111-111111111111";
const originalArgv = process.argv;
const originalTitle = process.title;
const originalExitCode = process.exitCode;

function disconnected() {
  return new GatewayTransportError({
    kind: "closed",
    code: 1006,
    reason: "reply lost",
    message: "gateway closed (1006): reply lost",
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "",
    },
  });
}

async function runProgram(args: string[]): Promise<string> {
  process.argv = ["node", "openclaw", "skills", "workshop", ...args];
  let stdout = "";
  const capture = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  try {
    await withConsoleLogsRoutedToStderrForJson(
      process.argv,
      () => buildProgram().parseAsync(process.argv),
      { restoreChanges: true },
    );
    return stdout;
  } finally {
    capture.mockRestore();
  }
}

function expectArchivedReleaseNotes(archived: string, format: "text" | "json") {
  if (format === "json") {
    expect(JSON.parse(archived)).toMatchObject({
      change: {
        agentId: "writer",
        skillName: "release-notes",
        action: "archive",
        actor: "user",
        summary: "archived: superseded",
        versionId: expect.stringMatching(/^\d{8}T\d{9}Z-archive$/),
      },
    });
  } else {
    expect(archived).toBe(
      "Archived release-notes. Undo with: openclaw skills workshop restore release-notes --agent writer\n",
    );
  }
}

async function dispatch(config: OpenClawConfig, method: string, params: unknown) {
  let payload: unknown;
  let failure: unknown;
  let replied = false;
  await handleGatewayRequest({
    req: { type: "req", id: "workshop-cli-contract", method, params },
    client: {
      connId: "workshop-cli-contract",
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => config,
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestOptions["context"],
    respond: (ok, result, error) => {
      replied = true;
      if (ok) {
        payload = result;
      } else {
        failure = error;
      }
    },
  });
  expect(replied).toBe(true);
  expect(failure).toBeUndefined();
  return payload;
}

async function claimState(
  role: "gateway" | "sqlite-maintenance" = "sqlite-maintenance",
): Promise<GatewayLockHandle> {
  const lock = await acquireGatewayLock({ allowInTests: true, role });
  if (!lock) {
    throw new Error("Workshop fixture did not acquire isolated state custody");
  }
  return lock;
}

async function fixture(run: (state: OpenClawTestState, config: OpenClawConfig) => Promise<void>) {
  await withOpenClawTestState(
    {
      label: "workshop-cli-contract",
      env: {
        OPENCLAW_HIDE_BANNER: "1",
        OPENCLAW_PATH_BOOTSTRAPPED: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        NODE_NO_WARNINGS: "1",
      },
    },
    async (state) => {
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: state.path("main-workspace") },
            writer: { workspace: state.workspaceDir },
          },
        },
        skills: { load: { watch: false }, workshop: { autonomous: { mode: "off" } } },
      };
      await state.writeConfig(config);
      for (const [agent, content] of [
        ["main", "Default agent must not be selected.\n"],
        ["writer", skill],
      ] as const) {
        const root = path.join(state.agentDir(agent), "workshop-skills", "release-notes");
        await fs.mkdir(path.join(root, "references"), { recursive: true });
        await fs.writeFile(path.join(root, "SKILL.md"), content);
        await fs.writeFile(path.join(root, "references", "release.md"), support);
      }
      const archived = path.join(
        state.agentDir("writer"),
        "workshop-skills",
        ".archive",
        "old-deploy",
        version,
      );
      await fs.mkdir(archived, { recursive: true });
      await fs.writeFile(
        path.join(archived, "SKILL.md"),
        skill.replaceAll("release-notes", "old-deploy"),
      );
      const seedLock = await claimState();
      try {
        seedLock.run(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            db.exec(`CREATE TABLE IF NOT EXISTS skill_workshop_changes (
            cursor_id INTEGER NOT NULL,
            change_id TEXT NOT NULL PRIMARY KEY,
            agent_id TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('create', 'patch', 'write_file', 'remove_file', 'archive', 'restore')),
            actor TEXT NOT NULL CHECK (actor IN ('agent', 'review', 'curator', 'user')),
            summary TEXT NOT NULL,
            version_id TEXT,
            session_key TEXT,
            run_id TEXT,
            created_at_ms INTEGER NOT NULL
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS skill_workshop_changes_cursor_id_idx
            ON skill_workshop_changes(cursor_id);
          CREATE INDEX IF NOT EXISTS idx_skill_workshop_changes_agent_time
            ON skill_workshop_changes(agent_id, created_at_ms);`);
            db.prepare(`INSERT INTO skill_workshop_changes
            (cursor_id, change_id, agent_id, skill_name, action, actor, summary, version_id, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              1,
              changeId,
              "writer",
              "old-deploy",
              "archive",
              "user",
              "archived: superseded",
              version,
              1_790_643_723_004,
            );
          }),
        );
      } finally {
        await seedLock.release();
      }
      try {
        await run(state, config);
      } finally {
        await closeSkillsWatchers(true);
        await closeStateDatabaseForTest();
      }
    },
  );
}

async function persistedChanges(state: OpenClawTestState) {
  await closeSkillsWatchers(true);
  await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
  await closeStateDatabaseForTest();
  const database = new DatabaseSync(state.statePath("state", "openclaw.sqlite"));
  try {
    database.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    return database
      .prepare(`SELECT agent_id, skill_name, action, actor, summary, version_id
      FROM skill_workshop_changes ORDER BY cursor_id`)
      .all();
  } finally {
    database.close();
  }
}

afterEach(() => {
  transport.call.mockReset();
  process.argv = originalArgv;
  process.title = originalTitle;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("openclaw skills workshop persisted CLI contract", () => {
  it.each(["text", "json"] as const)(
    "lists, reads and filters changes through the real dispatcher (%s)",
    async (format) => {
      await fixture(async (state, config) => {
        const lock = await claimState("gateway");
        transport.call.mockImplementation(({ method, params }) =>
          lock.run(() => dispatch(config, method, params)),
        );
        const output = format === "json" ? ["--json"] : [];
        try {
          const listed = await runProgram(["--agent", "writer", "list", ...output]);
          if (format === "json") {
            expect(JSON.parse(listed)).toMatchObject({
              agentId: "writer",
              mode: "off",
              root: path.join(state.agentDir("writer"), "workshop-skills"),
              skills: [
                {
                  name: "release-notes",
                  description: "Draft release notes from merged PRs",
                  files: ["SKILL.md", "references/release.md"],
                },
              ],
              archived: [
                { name: "old-deploy", live: false, versions: [{ id: version, action: "archive" }] },
              ],
            });
          } else {
            expect(listed).toContain("Agent: writer  Mode: off");
            expect(listed).toContain("Draft release notes from merged PRs");
            expect(listed).toContain("Archived:\nold-deploy  versions=1\n");
            expect(listed).not.toContain("Default agent");
          }
          const changes = await runProgram([
            "changes",
            "--agent",
            "writer",
            "--limit",
            "1",
            ...output,
          ]);
          if (format === "json") {
            expect(JSON.parse(changes)).toMatchObject({
              changes: [
                {
                  id: changeId,
                  agentId: "writer",
                  skillName: "old-deploy",
                  action: "archive",
                  actor: "user",
                  summary: "archived: superseded",
                  versionId: version,
                },
              ],
            });
            expect(JSON.parse(changes).changes).toHaveLength(1);
          } else {
            expect(changes).toContain(
              `  user  archive  old-deploy  archived: superseded  version=${version}\n`,
            );
          }
          const shown = await runProgram([
            "show",
            "release-notes",
            "--agent",
            "writer",
            "--file",
            "references/release.md",
            ...output,
          ]);
          expect(format === "json" ? JSON.parse(shown) : shown).toEqual(
            format === "json"
              ? {
                  name: "release-notes",
                  filePath: "references/release.md",
                  content: support,
                  files: ["SKILL.md", "references/release.md"],
                }
              : support,
          );
          const saved = await runProgram([
            "show",
            "old-deploy",
            "--agent",
            "writer",
            "--version",
            version,
            ...output,
          ]);
          expect(format === "json" ? JSON.parse(saved).content : saved).toBe(
            skill.replaceAll("release-notes", "old-deploy"),
          );
          expect(transport.call.mock.calls.map(([request]) => request.method)).toEqual([
            "skills.workshop.list",
            "skills.workshop.changes",
            "skills.workshop.read",
            "skills.workshop.read",
          ]);
        } finally {
          await lock.release();
        }
      });
    },
  );

  it.each(["text", "json"] as const)(
    "reads persisted local state when the Gateway is unavailable (%s)",
    async (format) => {
      await fixture(async () => {
        transport.call.mockRejectedValue(disconnected());
        const output = format === "json" ? ["--json"] : [];
        const listed = await runProgram(["list", "--agent", "writer", ...output]);
        expect(format === "json" ? JSON.parse(listed).skills[0].name : listed).toContain(
          "release-notes",
        );
        const changes = await runProgram([
          "changes",
          "--agent",
          "writer",
          "--limit",
          "1",
          ...output,
        ]);
        expect(format === "json" ? JSON.parse(changes).changes[0].id : changes).toContain(
          format === "json" ? changeId : "archived: superseded",
        );
        const shown = await runProgram(["show", "release-notes", "--agent", "writer", ...output]);
        expect(format === "json" ? JSON.parse(shown).content : shown).toBe(skill);
        expect(transport.call).toHaveBeenCalledTimes(3);
      });
    },
  );

  it.each(["text", "json"] as const)(
    "archives as user offline, prints a restore hint, and restores the saved tree (%s)",
    async (format) => {
      await fixture(async (state) => {
        transport.call.mockRejectedValue(disconnected());
        const output = format === "json" ? ["--json"] : [];
        const archived = await runProgram([
          "archive",
          "release-notes",
          "--agent",
          "writer",
          "--reason",
          "superseded",
          ...output,
        ]);
        expectArchivedReleaseNotes(archived, format);
        const live = path.join(state.agentDir("writer"), "workshop-skills", "release-notes");
        await expect(fs.stat(live)).rejects.toMatchObject({ code: "ENOENT" });
        const rows = await persistedChanges(state);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({
          agent_id: "writer",
          skill_name: "release-notes",
          action: "archive",
          actor: "user",
          summary: "archived: superseded",
        });
        const restored = await runProgram([
          "restore",
          "release-notes",
          "--agent",
          "writer",
          "--version",
          String(rows[1]?.version_id),
          ...output,
        ]);
        expect(format === "json" ? JSON.parse(restored) : restored).toEqual(
          format === "json"
            ? {
                change: expect.objectContaining({
                  agentId: "writer",
                  skillName: "release-notes",
                  action: "restore",
                  actor: "user",
                  summary: "restored from archive",
                }),
              }
            : "Restored release-notes.\n",
        );
        expect(await fs.readFile(path.join(live, "SKILL.md"), "utf8")).toBe(skill);
        expect(await fs.readFile(path.join(live, "references", "release.md"), "utf8")).toBe(
          support,
        );
        expect(await persistedChanges(state)).toHaveLength(3);
        expect(transport.call).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["text", "json"] as const)(
    "archives and restores through the available Gateway (%s)",
    async (format) => {
      await fixture(async (state, config) => {
        const lock = await claimState("gateway");
        transport.call.mockImplementation(({ method, params }) =>
          lock.run(() => dispatch(config, method, params)),
        );
        const output = format === "json" ? ["--json"] : [];
        const live = path.join(state.agentDir("writer"), "workshop-skills", "release-notes");
        try {
          const archived = await runProgram([
            "archive",
            "release-notes",
            "--agent",
            "writer",
            "--reason",
            "superseded",
            ...output,
          ]);
          expectArchivedReleaseNotes(archived, format);
          await expect(fs.stat(live)).rejects.toMatchObject({ code: "ENOENT" });
          const restored = await runProgram([
            "restore",
            "release-notes",
            "--agent",
            "writer",
            ...output,
          ]);
          if (format === "json") {
            expect(JSON.parse(restored)).toMatchObject({
              change: {
                agentId: "writer",
                skillName: "release-notes",
                action: "restore",
                actor: "user",
                summary: "restored from archive",
              },
            });
          } else {
            expect(restored).toBe("Restored release-notes.\n");
          }
          expect(await fs.readFile(path.join(live, "SKILL.md"), "utf8")).toBe(skill);
          expect(await fs.readFile(path.join(live, "references", "release.md"), "utf8")).toBe(
            support,
          );
          expect(transport.call.mock.calls.map(([request]) => request.method)).toEqual([
            "skills.workshop.archive",
            "skills.workshop.restore",
          ]);
        } finally {
          await lock.release();
        }
        const rows = await persistedChanges(state);
        expect(rows).toHaveLength(3);
        expect(rows.slice(1)).toEqual([
          expect.objectContaining({
            agent_id: "writer",
            skill_name: "release-notes",
            action: "archive",
            actor: "user",
          }),
          expect.objectContaining({
            agent_id: "writer",
            skill_name: "release-notes",
            action: "restore",
            actor: "user",
          }),
        ]);
      });
    },
  );

  it("does not replay a committed restore locally after the Gateway loses its reply and releases custody", async () => {
    await fixture(async (state, config) => {
      const lock = await claimState("gateway");
      transport.call.mockImplementation(async ({ method, params }) => {
        await lock.run(() => dispatch(config, method, params));
        await lock.release();
        throw disconnected();
      });
      try {
        await expect(
          runProgram(["restore", "old-deploy", "--agent", "writer", "--json"]),
        ).rejects.toThrow("gateway closed (1006): reply lost");
      } finally {
        await lock.release();
      }
      expect(transport.call).toHaveBeenCalledTimes(1);
      expect(
        await fs.readFile(
          path.join(state.agentDir("writer"), "workshop-skills", "old-deploy", "SKILL.md"),
          "utf8",
        ),
      ).toBe(skill.replaceAll("release-notes", "old-deploy"));
      const rows = await persistedChanges(state);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        agent_id: "writer",
        skill_name: "old-deploy",
        action: "restore",
        actor: "user",
        summary: "restored from archive",
      });
      expect(rows[1]?.version_id).toBeNull();
      expect(
        await fs.readdir(
          path.join(state.agentDir("writer"), "workshop-skills", ".archive", "old-deploy"),
        ),
      ).toEqual([version]);
    });
  });
});

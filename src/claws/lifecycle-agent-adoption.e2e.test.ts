import { access, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  readTranscriptExportSnapshotReadOnlySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";

describe("configured agent adoption built CLI e2e", () => {
  it("manages declared state while retaining the pre-Claws history on remove", async () => {
    const instance = await createOpenClawTestInstance({
      name: "claws-agent-adopt",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_EXPERIMENTAL_CLAWS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    await runQaGatewayFixture(
      async () => {
        const { stateDir, configPath } = instance;
        const runBuiltOpenClaw = async (args: string[]) => {
          const result = await instance.cli(args);
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
          return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
        };
        const workspace = join(stateDir, "existing-workspace");
        await mkdir(join(workspace, "reference"), { recursive: true });
        for (const path of ["SOUL.md", "HEARTBEAT.md", "reference/policy.md"]) {
          await copyFile(join("src/claws/fixtures/workspace", path), join(workspace, path));
        }
        const canonicalWorkspace = await realpath(workspace);
        const agentDir = join(stateDir, "agents", "workspace-agent");
        const agentDatabase = resolveOpenClawAgentSqlitePath({
          agentId: "workspace-agent",
          env: instance.env,
        });
        const sessionStorePath = join(agentDir, "sessions", "sessions.json");
        const sessionKey = "agent:workspace-agent:pre-claws";
        const sessionId = "pre-claws-session";
        // The instance does not apply its environment to this fixture's process.
        const sessionScope = {
          agentId: "workspace-agent",
          env: instance.env,
          sessionKey,
          storePath: sessionStorePath,
        };
        const stateSentinel = join(agentDir, "pre-claws-state.txt");
        const transcriptSentinel = join(agentDir, "sessions", "pre-claws-transcript.jsonl");
        const undeclared = join(workspace, "operator-notes.md");
        await mkdir(join(agentDir, "sessions"), { recursive: true });
        await upsertSessionEntryCore(sessionScope, { sessionId, updatedAt: 1 });
        const transcriptEvent = {
          id: "pre-claws-event",
          marker: "pre-claws-history",
          timestamp: "1970-01-01T00:00:00.001Z",
          type: "metadata",
        };
        await appendTranscriptEvent({ ...sessionScope, sessionId }, transcriptEvent);
        await writeFile(stateSentinel, "pre-claws-agent-state\n", "utf8");
        await writeFile(transcriptSentinel, "pre-claws-transcript-sentinel\n", "utf8");
        await writeFile(undeclared, "operator-owned\n", "utf8");
        const adoptedConfig = {
          name: "Workspace Agent",
          identity: { name: "Workspace" },
          workspace: canonicalWorkspace,
        };
        await instance.state.writeConfig({
          ...JSON.parse(await readFile(configPath, "utf8")),
          agents: {
            ownership: "explicit",
            defaults: {
              heartbeat: { agentId: "main" },
              systemAgent: { agentId: "main" },
            },
            entries: {
              main: {},
              "workspace-agent": adoptedConfig,
            },
          },
          talk: { agentId: "main" },
        });
        expect(readAgentDatabaseDeletionSnapshot(instance.env)).toMatchObject({
          retainedDeletions: { status: "empty" },
          registeredAgentDatabases: expect.arrayContaining([
            expect.objectContaining({ agentId: "workspace-agent", path: agentDatabase }),
          ]),
        });
        expect(loadSessionEntry(sessionScope)).toMatchObject({ sessionId });
        await expect(
          loadTranscriptEvents({
            ...sessionScope,
            sessionId,
          }),
        ).resolves.toContainEqual(transcriptEvent);
        closeOpenClawAgentDatabasesForTest();

        const source = "src/claws/fixtures/workspace-agent.claw.json";
        const preview = await runBuiltOpenClaw([
          "claws",
          "add",
          source,
          "--workspace",
          workspace,
          "--adopt-existing-agent",
          "--dry-run",
          "--json",
        ]);
        expect(preview).toMatchObject({
          blockers: [],
          actions: expect.arrayContaining([
            expect.objectContaining({ kind: "agent", action: "adopt" }),
            expect.objectContaining({ kind: "workspace", action: "adopt" }),
          ]),
        });
        const added = await runBuiltOpenClaw([
          "claws",
          "add",
          source,
          "--workspace",
          workspace,
          "--adopt-existing-agent",
          "--yes",
          "--plan-integrity",
          String(preview.planIntegrity),
          "--json",
        ]);
        expect(added).toMatchObject({
          status: "complete",
          agent: { finalId: "workspace-agent" },
          installRecord: {
            agentOrigin: "adopted",
            schemaVersion: "openclaw.clawInstallRecord.v3",
          },
        });
        expect(
          JSON.parse(await readFile(configPath, "utf8")).agents.entries["workspace-agent"],
        ).toEqual(adoptedConfig);

        const status = await runBuiltOpenClaw(["claws", "status", "workspace-agent", "--json"]);
        expect(status).toMatchObject({
          records: [
            {
              agentOrigin: "adopted",
              agentState: "present",
              install: { agentId: "workspace-agent", agentOrigin: "adopted" },
            },
          ],
        });

        const updatePlan = await runBuiltOpenClaw([
          "claws",
          "update",
          "workspace-agent",
          "--dry-run",
          "--json",
        ]);
        const updated = await runBuiltOpenClaw([
          "claws",
          "update",
          "workspace-agent",
          "--yes",
          "--plan-integrity",
          String(updatePlan.planIntegrity),
          "--json",
        ]);
        expect(updated).toMatchObject({
          status: "complete",
          installRecord: { agentOrigin: "adopted" },
        });
        expect(
          JSON.parse(await readFile(configPath, "utf8")).agents.entries["workspace-agent"],
        ).toEqual(adoptedConfig);

        await instance.startGateway();
        const removePlan = await runBuiltOpenClaw([
          "claws",
          "remove",
          "workspace-agent",
          "--dry-run",
          "--json",
        ]);
        expect(removePlan).toMatchObject({
          blockers: [],
          actions: expect.arrayContaining([
            expect.objectContaining({ kind: "agentState", action: "retain" }),
            expect.objectContaining({ kind: "sessionIndex", action: "retain" }),
            expect.objectContaining({ kind: "sessionTranscripts", action: "retain" }),
          ]),
        });
        const removed = await runBuiltOpenClaw([
          "claws",
          "remove",
          "workspace-agent",
          "--yes",
          "--plan-integrity",
          String(removePlan.planIntegrity),
          "--json",
        ]);
        expect(removed).toMatchObject({ status: "complete", agentRemoved: true });

        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.agents.entries["workspace-agent"]).toBeUndefined();
        await expect(access(join(workspace, "SOUL.md"))).rejects.toThrow();
        await expect(access(agentDatabase)).resolves.toBeUndefined();
        // Retained history remains readable without reclaiming the deleted writable identity.
        expect(loadSessionEntryReadOnly(sessionScope)).toMatchObject({ sessionId });
        const retainedTranscript = readTranscriptExportSnapshotReadOnlySync({
          ...sessionScope,
          sessionId,
        });
        expect(retainedTranscript?.sessionKey).toBe(sessionKey);
        expect(retainedTranscript?.events).toContainEqual(transcriptEvent);
        expect(() => loadSessionEntry(sessionScope)).toThrow(
          "OpenClaw agent database is unavailable while agent workspace-agent is deleted.",
        );
        await expect(readFile(stateSentinel, "utf8")).resolves.toBe("pre-claws-agent-state\n");
        await expect(readFile(transcriptSentinel, "utf8")).resolves.toBe(
          "pre-claws-transcript-sentinel\n",
        );
        await expect(readFile(undeclared, "utf8")).resolves.toBe("operator-owned\n");
      },
      () => closeOpenClawAgentDatabasesForTest(),
      () => instance.cleanup(),
    );
  });
});

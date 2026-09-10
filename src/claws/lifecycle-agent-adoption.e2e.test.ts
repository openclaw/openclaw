import { access, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed);
}

describe("configured agent adoption built CLI e2e", () => {
  it("manages declared state while retaining the pre-Claws history on remove", async () => {
    const workspace = tempDirs.make("openclaw-claws-agent-adopt-e2e-");
    await mkdir(join(workspace, "reference"), { recursive: true });
    for (const path of ["SOUL.md", "HEARTBEAT.md", "reference/policy.md"]) {
      await copyFile(join("src/claws/fixtures/workspace", path), join(workspace, path));
    }
    const canonicalWorkspace = await realpath(workspace);

    const instance = await createOpenClawTestInstance({
      name: "claws-agent-adoption",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_EXPERIMENTAL_CLAWS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      config: {
        agents: {
          entries: {
            main: { default: true },
            "workspace-agent": {
              name: "Workspace Agent",
              identity: { name: "Workspace" },
              workspace: canonicalWorkspace,
            },
          },
        },
      },
    });

    await runQaGatewayFixture(
      async () => {
        const run = async (args: string[]) => {
          const result = await instance.cli(args);
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
          return result;
        };

        const agentDir = join(instance.stateDir, "agents", "workspace-agent");
        const agentDatabase = resolveOpenClawAgentSqlitePath({
          agentId: "workspace-agent",
          env: { OPENCLAW_STATE_DIR: instance.stateDir },
        });
        const sessionStorePath = join(agentDir, "sessions", "sessions.json");
        const sessionKey = "agent:workspace-agent:pre-claws";
        const sessionId = "pre-claws-session";
        const stateSentinel = join(agentDir, "pre-claws-state.txt");
        const transcriptSentinel = join(agentDir, "sessions", "pre-claws-transcript.jsonl");
        const undeclared = join(workspace, "operator-notes.md");
        await mkdir(join(agentDir, "sessions"), { recursive: true });
        await upsertSessionEntryCore(
          { agentId: "workspace-agent", sessionKey, storePath: sessionStorePath },
          { sessionId, updatedAt: 1 },
        );
        const transcriptEvent = {
          id: "pre-claws-event",
          marker: "pre-claws-history",
          timestamp: "1970-01-01T00:00:00.001Z",
          type: "metadata",
        };
        await appendTranscriptEvent(
          { agentId: "workspace-agent", sessionId, sessionKey, storePath: sessionStorePath },
          transcriptEvent,
        );
        await writeFile(stateSentinel, "pre-claws-agent-state\n", "utf8");
        await writeFile(transcriptSentinel, "pre-claws-transcript-sentinel\n", "utf8");
        await writeFile(undeclared, "operator-owned\n", "utf8");
        expect(
          loadSessionEntry({ agentId: "workspace-agent", sessionKey, storePath: sessionStorePath }),
        ).toMatchObject({ sessionId });
        await expect(
          loadTranscriptEvents({
            agentId: "workspace-agent",
            sessionId,
            sessionKey,
            storePath: sessionStorePath,
          }),
        ).resolves.toContainEqual(transcriptEvent);
        closeOpenClawAgentDatabasesForTest();

        const source = "src/claws/fixtures/workspace-agent.claw.json";
        const preview = await run([
          "claws",
          "add",
          source,
          "--workspace",
          workspace,
          "--adopt-existing-agent",
          "--dry-run",
          "--json",
        ]);
        const previewPlan = parseJson(preview.stdout) as { planIntegrity: string };
        expect(previewPlan).toMatchObject({
          blockers: [],
          actions: expect.arrayContaining([
            expect.objectContaining({ kind: "agent", action: "adopt" }),
            expect.objectContaining({ kind: "workspace", action: "adopt" }),
          ]),
        });
        const added = await run([
          "claws",
          "add",
          source,
          "--workspace",
          workspace,
          "--adopt-existing-agent",
          "--yes",
          "--plan-integrity",
          previewPlan.planIntegrity,
          "--json",
        ]);
        expect(parseJson(added.stdout)).toMatchObject({
          status: "complete",
          agent: { finalId: "workspace-agent" },
          installRecord: {
            agentOrigin: "adopted",
            schemaVersion: "openclaw.clawInstallRecord.v3",
          },
        });
        const adoptedConfig = {
          name: "Workspace Agent",
          identity: { name: "Workspace" },
          workspace: canonicalWorkspace,
        };
        expect(
          JSON.parse(await readFile(instance.configPath, "utf8")).agents.entries["workspace-agent"],
        ).toEqual(adoptedConfig);

        const status = await run(["claws", "status", "workspace-agent", "--json"]);
        expect(parseJson(status.stdout)).toMatchObject({
          records: [
            {
              agentOrigin: "adopted",
              agentState: "present",
              install: { agentId: "workspace-agent", agentOrigin: "adopted" },
            },
          ],
        });

        const updatePlan = await run(["claws", "update", "workspace-agent", "--dry-run", "--json"]);
        const updatePlanResult = parseJson(updatePlan.stdout) as { planIntegrity: string };
        const updated = await run([
          "claws",
          "update",
          "workspace-agent",
          "--yes",
          "--plan-integrity",
          updatePlanResult.planIntegrity,
          "--json",
        ]);
        expect(parseJson(updated.stdout)).toMatchObject({
          status: "complete",
          installRecord: { agentOrigin: "adopted" },
        });
        expect(
          JSON.parse(await readFile(instance.configPath, "utf8")).agents.entries["workspace-agent"],
        ).toEqual(adoptedConfig);

        await instance.startGateway();

        const removePreview = await run([
          "claws",
          "remove",
          "workspace-agent",
          "--dry-run",
          "--json",
        ]);
        const removePlan = parseJson(removePreview.stdout) as { planIntegrity: string };
        expect(removePlan).toMatchObject({
          blockers: [],
          actions: expect.arrayContaining([
            expect.objectContaining({ kind: "agentState", action: "retain" }),
            expect.objectContaining({ kind: "sessionIndex", action: "retain" }),
            expect.objectContaining({ kind: "sessionTranscripts", action: "retain" }),
          ]),
        });
        const removed = await run([
          "claws",
          "remove",
          "workspace-agent",
          "--yes",
          "--plan-integrity",
          removePlan.planIntegrity,
          "--json",
        ]);
        expect(parseJson(removed.stdout)).toMatchObject({ status: "complete", agentRemoved: true });

        const config = JSON.parse(await readFile(instance.configPath, "utf8"));
        expect(config.agents.entries["workspace-agent"]).toBeUndefined();
        await expect(access(join(workspace, "SOUL.md"))).rejects.toThrow();
        await expect(access(agentDatabase)).resolves.toBeUndefined();
        expect(
          loadSessionEntry({ agentId: "workspace-agent", sessionKey, storePath: sessionStorePath }),
        ).toMatchObject({ sessionId });
        await expect(
          loadTranscriptEvents({
            agentId: "workspace-agent",
            sessionId,
            sessionKey,
            storePath: sessionStorePath,
          }),
        ).resolves.toContainEqual(transcriptEvent);
        await expect(readFile(stateSentinel, "utf8")).resolves.toBe("pre-claws-agent-state\n");
        await expect(readFile(transcriptSentinel, "utf8")).resolves.toBe(
          "pre-claws-transcript-sentinel\n",
        );
        await expect(readFile(undeclared, "utf8")).resolves.toBe("operator-owned\n");
        closeOpenClawAgentDatabasesForTest();
      },
      () => instance.cleanup(),
    );
  });
});

import { expect, it, vi, type Mock } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveExecApprovals } from "../../infra/exec-approvals-store.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as inheritedToolPolicy from "../inherited-tool-policy.js";
import type { InheritedToolPolicyRef } from "../inherited-tool-policy.schema.js";
import type { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

type AcpPolicyFixture = {
  createTool: typeof createSessionsSpawnTool;
  registerAcpBackendForTest: () => void;
  mocks: { spawnAcpDirectMock: Mock; spawnSubagentDirectMock: Mock };
};

/** Shares the registered spawn boundary and resets with the parent suite. */
export function registerSessionsSpawnAcpPolicyTests({
  createTool,
  registerAcpBackendForTest,
  mocks,
}: AcpPolicyFixture) {
  it("advertises an available ACP backend for an unbound legacy caller", () => {
    registerAcpBackendForTest();
    const tool = createTool({
      agentChannel: "discord",
      agentAccountId: "default",
      config: { session: { threadBindings: { spawnSessions: true } } },
    });
    expect(tool.displaySummary).toBe(
      "Spawn hidden subagent (ephemeral) or visible work session (durable).",
    );
    expect(tool.description).toContain('runtime="acp"');
    expect(tool.description).toContain("follow the receipt's completion mode");
    expect(tool.parameters).toMatchObject({
      properties: {
        runtime: { enum: ["subagent", "acp"] },
        resumeSessionId: {
          description: expect.stringContaining("ACP resume id"),
        },
        streamTo: { enum: ["parent"], description: expect.stringContaining("ACP only") },
      },
    });
    const schema = tool.parameters as {
      properties: { resumeSessionId: { description: string }; streamTo: { description: string } };
    };
    expect(schema.properties.resumeSessionId.description).toContain("ignored by subagent");
    expect(schema.properties.resumeSessionId.description).toContain(
      "already recorded for requester",
    );
    expect(schema.properties.streamTo.description).toContain('"parent" streams turn to requester');
    expect(schema.properties.streamTo.description).toContain("Ignored by subagent");
  });

  it.each([
    { name: "full session permission", bypass: true, retire: false },
    { name: "configured full/off without a host-floor bypass", bypass: false, retire: false },
    { name: "full session permission replaced after capture", bypass: true, retire: true },
  ])(
    "checks ACP admission from the real coding-tool factory ($name)",
    async ({ bypass, retire }) => {
      const state = await createOpenClawTestState({ scenario: "minimal" });
      const policyRef: InheritedToolPolicyRef = {};
      const config = {
        agents: { ownership: "explicit", entries: { main: {} } },
        tools: {
          profile: "full",
          allow: ["*"],
          exec: { host: "gateway", mode: "full", applyPatch: { workspaceOnly: false } },
          fs: { workspaceOnly: false },
        },
        acp: { enabled: true },
      } satisfies OpenClawConfig;
      let restoreCapture: (() => void) | undefined;
      try {
        setRuntimeConfigSnapshot(config);
        saveExecApprovals({
          version: 1,
          defaults: { security: "full", ask: "off", askFallback: "deny" },
          agents: { main: { security: "full", ask: "off" } },
        });
        registerAcpBackendForTest();
        const { createOpenClawCodingToolsInternal } = await import("../agent-tools.js");
        const tool = createOpenClawCodingToolsInternal({
          config,
          agentId: "main",
          sessionKey: "agent:main:main",
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          senderIsOwner: true,
          sessionPermissionPolicy: bypass ? { root: state.workspaceDir, mode: "full" } : undefined,
          inheritedToolPolicyRef: policyRef,
          wrapBeforeToolCallHook: false,
        }).find((entry) => entry.name === "sessions_spawn");
        if (!tool) {
          throw new Error("Expected the registered sessions_spawn tool");
        }
        expect(policyRef.current?.parameters.exec).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              security: "full",
              ask: "off",
              bypassHostApprovalFloors: bypass,
            }),
          ]),
        );
        expect(policyRef.current?.parameters.fileTools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              workspaceOnly: false,
              readOnly: false,
              applyPatchWorkspaceOnly: false,
            }),
          ]),
        );
        if (retire) {
          const capture = inheritedToolPolicy.captureDelegatedSourceToolPolicy;
          const spy = vi
            .spyOn(inheritedToolPolicy, "captureDelegatedSourceToolPolicy")
            .mockImplementationOnce(async (params) => {
              const captured = await capture(params);
              policyRef.captureSource = undefined;
              return captured;
            });
          restoreCapture = () => spy.mockRestore();
          await expect(
            tool.execute("native-acp-expired", { task: "Inspect the project", runtime: "acp" }),
          ).rejects.toThrow("replaced tool generation");
          expect(spy).toHaveBeenCalledOnce();
        } else {
          expect(tool.parameters).toMatchObject({
            properties: { runtime: { enum: ["subagent", "acp"] } },
          });
          const result = await tool.execute("native-acp", {
            task: "Inspect the project",
            runtime: "acp",
          });
          expect(result.details).toMatchObject({ status: bypass ? "accepted" : "forbidden" });
          if (bypass) {
            expect(result.details).toMatchObject({
              childSessionKey: "agent:codex:acp:1",
              runId: "run-acp",
            });
            expect(mocks.spawnAcpDirectMock).toHaveBeenCalledWith(
              expect.objectContaining({ task: "Inspect the project" }),
              expect.objectContaining({ agentSessionKey: "agent:main:main" }),
            );
          }
        }
        expect(mocks.spawnAcpDirectMock).toHaveBeenCalledTimes(bypass && !retire ? 1 : 0);
        expect(mocks.spawnSubagentDirectMock).not.toHaveBeenCalled();
      } finally {
        restoreCapture?.();
        await state.cleanup();
      }
    },
  );
}

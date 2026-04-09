import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

describe("task-os chat ingress", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_CONTROL_PLANE_DIR;
    delete process.env.OPENCLAW_APPROVAL_MATRIX_PATH;
    delete process.env.OPENCLAW_ROLLOUT_FLAGS_PATH;
  });

  it("ignores control-command messages", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { maybeHandleChatIngressOrchestration } = await import("./task-os-chat-ingress.js");
      const dispatcher = {
        sendFinalReply: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      };
      const result = await maybeHandleChatIngressOrchestration({
        ctx: {
          Body: "/status",
          BodyForCommands: "/status",
          SessionKey: "agent:quick:telegram:direct:8557864324",
          OriginatingChannel: "telegram",
          OriginatingTo: "8557864324",
          CommandAuthorized: true,
        },
        cfg: {
          session: {},
          agents: { defaults: {}, list: [{ id: "quick" }] },
        } as never,
        dispatcher: dispatcher as never,
      });
      expect(result.handled).toBe(false);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    });
  });

  it("promotes chat work into task-os and spawns deterministic stages", async () => {
    await withTempHome(async (home) => {
      const controlPlaneDir = `${home}/control-plane`;
      const approvalMatrixPath = `${home}/approval-matrix.json`;
      const rolloutFlagsPath = `${home}/rollout-flags.json`;
      await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
        await mkdir(controlPlaneDir, { recursive: true });
        await Promise.all([
          writeFile(
            `${controlPlaneDir}/channel-policy.json`,
            JSON.stringify(
              { schema_version: 1, stage: "topology", policy_version: "test", channels: [] },
              null,
              2,
            ),
          ),
          writeFile(
            `${controlPlaneDir}/trigger-ranking.json`,
            JSON.stringify(
              { schema_version: 1, stage: "topology", policy_version: "test", signals: [] },
              null,
              2,
            ),
          ),
          writeFile(
            `${controlPlaneDir}/persona-routing.json`,
            JSON.stringify(
              { schema_version: 1, stage: "topology", policy_version: "test", personas: [] },
              null,
              2,
            ),
          ),
          writeFile(
            approvalMatrixPath,
            JSON.stringify(
              {
                schema_version: 1,
                stage: "topology",
                policy_version: "test",
                entries: [{ action_class: "draft", decision: "allow", approval_route: "none" }],
                system_authority_matrix: [
                  {
                    id: "slack",
                    actions: [
                      {
                        id: "draft",
                        action_class: "draft",
                        decision: "allow",
                        approval_route: "none",
                      },
                    ],
                  },
                  {
                    id: "telegram",
                    actions: [
                      {
                        id: "draft",
                        action_class: "draft",
                        decision: "allow",
                        approval_route: "none",
                      },
                    ],
                  },
                ],
                source_of_truth: {
                  precedence: [
                    "ledger",
                    "execution_state",
                    "external_artifact_links",
                    "raw_source_events",
                  ],
                  layers: [
                    { id: "ledger", rank: 1 },
                    { id: "execution_state", rank: 2 },
                    { id: "external_artifact_links", rank: 3 },
                    { id: "raw_source_events", rank: 4 },
                  ],
                  systems: [
                    {
                      id: "slack",
                      layer: "raw_source_events",
                      reconciliation_mode: "candidate_task_only",
                      allow_candidate_task_creation: true,
                      promote_to_task_truth: false,
                    },
                    {
                      id: "telegram",
                      layer: "raw_source_events",
                      reconciliation_mode: "candidate_task_only",
                      allow_candidate_task_creation: true,
                      promote_to_task_truth: false,
                    },
                  ],
                },
              },
              null,
              2,
            ),
          ),
          writeFile(
            rolloutFlagsPath,
            JSON.stringify(
              { policy_version: "test", lanes: [{ id: "approval_inbox", enabled: true }] },
              null,
              2,
            ),
          ),
        ]);
      });
      process.env.OPENCLAW_CONTROL_PLANE_DIR = controlPlaneDir;
      process.env.OPENCLAW_APPROVAL_MATRIX_PATH = approvalMatrixPath;
      process.env.OPENCLAW_ROLLOUT_FLAGS_PATH = rolloutFlagsPath;

      spawnSubagentDirectMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:research:subagent:1",
      });
      vi.resetModules();
      const { maybeHandleChatIngressOrchestration } = await import("./task-os-chat-ingress.js");
      const { loadTaskOsStore } = await import("./task-os-store.js");
      const dispatcher = {
        sendFinalReply: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      };

      const result = await maybeHandleChatIngressOrchestration({
        ctx: {
          Body: "이거 조사하고 구현 계획 세워서 개발해줘",
          BodyForCommands: "이거 조사하고 구현 계획 세워서 개발해줘",
          SessionKey: "agent:quick:slack:channel:u08f692tp37",
          OriginatingChannel: "slack",
          OriginatingTo: "user:U08F692TP37",
          MessageSid: "171717.1",
          CommandAuthorized: false,
        },
        cfg: {
          session: {},
          agents: {
            defaults: {},
            list: [{ id: "quick" }, { id: "research" }, { id: "spec" }, { id: "builder" }],
          },
        } as never,
        dispatcher: dispatcher as never,
      });

      expect(result.handled).toBe(true);
      expect(result.stageIds).toEqual(["research", "spec-plan", "builder", "verifier"]);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
      expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(4);
      const store = await loadTaskOsStore();
      expect(store.tasks).toHaveLength(1);
      expect(store.tasks[0]?.evidence.some((entry) => entry.kind === "ingress_stage_spawn")).toBe(
        true,
      );
    });
  });
});

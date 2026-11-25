import path from "node:path";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

type SpawnOptions = NonNullable<Parameters<typeof SpawnToolFactory>[0]>;

/** Registers spawn-admission tests for sessions created by a visible spawn. */
export function registerSessionsSpawnVisibleDepthTests({
  createTool,
  makeDir,
}: {
  createTool: typeof SpawnToolFactory;
  makeDir: () => string;
}) {
  it("applies spawn depth limits to visible dashboard descendants", async () => {
    const storePath = path.join(makeDir(), "sessions.json");
    const childKey = "agent:main:dashboard:child";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      { sessionId: "root", updatedAt: 1 },
    );
    // A real visible spawn keeps sessions_spawn at the depth cap, so admission
    // is the only guard on its own spawns.
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: childKey, storePath },
      {
        sessionId: "child",
        updatedAt: 1,
        createdVia: "spawn",
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        parentSessionKey: "agent:main:main",
      },
    );
    const gateway: { call: NonNullable<SpawnOptions["callGateway"]> } = {
      call: async () => {
        throw new Error("Unexpected Gateway call");
      },
    };
    const callGateway = vi.spyOn(gateway, "call");
    const spawn = (maxSpawnDepth: number) =>
      createTool({
        agentSessionKey: childKey,
        callGateway: gateway.call,
        registerRun: vi.fn(),
        countActiveRuns: () => 0,
        config: {
          session: { store: storePath },
          agents: { defaults: { subagents: { maxSpawnDepth } } },
        },
      }).execute("nested", { task: "inspect", visible: true });
    expect((await spawn(1)).details).toMatchObject({ status: "forbidden" });
    expect(callGateway).not.toHaveBeenCalled();
    callGateway.mockResolvedValue({
      key: "agent:main:dashboard:grandchild",
      sessionId: "visible-grandchild",
      runStarted: true,
      runId: "run-grandchild",
    });
    expect((await spawn(2)).details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:dashboard:grandchild",
      runId: "run-grandchild",
    });
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        parentSessionKey: childKey,
        spawnDepth: 2,
        task: expect.stringContaining("inspect"),
      }),
    );
  });
}

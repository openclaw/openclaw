import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import "../../test-utils/prepare-compiled-subprocesses.js";

it.for(["visible", "native"] as const)(
  "keeps spawn runtimes cold and fences callers during the shared %s import",
  async (stage, { signal }) => {
    vi.resetModules();
    const entered = createDeferred();
    const release = createDeferred();
    let suspend = false;
    const spawn = vi
      .fn<typeof import("../subagents/spawn/subagent-spawn.js").spawnSubagentDirect>()
      .mockResolvedValue({
        status: "accepted",
        context: "isolated",
        childSessionKey: "agent:main:subagent:live",
        runId: "run-live",
      });
    const visible = vi
      .fn<typeof import("./sessions-spawn-visible.js").maybeSpawnVisibleSession>()
      .mockResolvedValue(undefined);
    const loadNative = vi.fn(async () => {
      if (suspend && stage === "native") {
        entered.resolve();
        await release.promise;
      }
      return {
        ...(await import("../subagents/spawn/subagent-spawn.types.js")),
        spawnSubagentDirect: spawn,
      };
    });
    const loadVisible = vi.fn(async () => {
      if (suspend && stage === "visible") {
        entered.resolve();
        await release.promise;
      }
      return { maybeSpawnVisibleSession: visible };
    });
    // mock-isolation: Observe import admission without creating child sessions.
    vi.doMock("../subagents/spawn/subagent-spawn.js", loadNative);
    // mock-isolation: Keep visible-session effects outside the import-lifecycle fixture.
    vi.doMock("./sessions-spawn-visible.js", loadVisible);
    let settlement: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let clearConfig: (() => void) | undefined;
    try {
      const config = await import("../../config/runtime-snapshot.js");
      clearConfig = config.clearRuntimeConfigSnapshot;
      config.setRuntimeConfigSnapshot({});
      const { createSessionsSpawnTool } = await import("./sessions-spawn-tool.js");
      const { withGatewayToolCallerIdentity } = await import("./gateway-caller-context.js");
      const tool = createSessionsSpawnTool({
        config: { tools: { swarm: false } },
        agentSessionKey: "agent:main:main",
      });
      expect(tool.parameters).toMatchObject({ properties: { task: { type: "string" } } });
      expect(loadNative).not.toHaveBeenCalled();
      expect(loadVisible).not.toHaveBeenCalled();

      suspend = true;
      const controller = new AbortController();
      const cancellation = new Error("spawn invocation cancelled");
      let current = true;
      settlement = Promise.allSettled([
        tool.execute("aborted", { task: "cancelled child" }, controller.signal),
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:main",
            receiptAuthority: () => current,
          },
          () => tool.execute("expired", { task: "expired child" }),
        ),
        tool.execute("live", { task: "live child" }),
      ]);
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, settlement, "spawn import was not reached"),
        signal,
      );
      controller.abort(cancellation);
      current = false;
      release.resolve();
      const [aborted, expired, live] = await withinTest(settlement, signal);
      expect(aborted).toEqual({ status: "rejected", reason: cancellation });
      expect(expired).toMatchObject({
        status: "rejected",
        reason: { message: "tool invocation authority is no longer active" },
      });
      expect(live).toMatchObject({
        status: "fulfilled",
        value: { details: { status: "accepted", runId: "run-live" } },
      });
      expect(visible).toHaveBeenCalledTimes(stage === "visible" ? 1 : 3);
      expect(spawn).toHaveBeenCalledOnce();
      expect(loadNative).toHaveBeenCalledOnce();
      expect(loadVisible).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await settlement;
      clearConfig?.();
      vi.doUnmock("../subagents/spawn/subagent-spawn.js");
      vi.doUnmock("./sessions-spawn-visible.js");
      vi.resetModules();
    }
  },
);

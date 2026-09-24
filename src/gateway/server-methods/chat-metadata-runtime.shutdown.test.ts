import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata shutdown", () => {
  test("closes replacement waiters without publishing or reviving metadata", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    await harness.runtime.refresh();
    harness.runtime.invalidate();
    const reads = [
      harness.runtime.read({ agentId: "main" }),
      harness.runtime.readStartup({
        agentId: "main",
        sessionEntry: { authProfileOverride: "test:session", authProfileOverrideSource: "user" },
      }),
    ].map((read) => read.catch((error: unknown) => error));

    await harness.runtime.stop();

    for (const result of await Promise.all(reads)) {
      expect(result).toMatchObject({
        name: "ChatMetadataSnapshotUnavailableError",
        message: "gateway chat metadata runtime is stopped",
      });
    }
    harness.runtime.invalidate();
    harness.runtime.fail(new Error("late owner failure"));
    await expect(harness.runtime.refresh()).rejects.toThrow("stopped");
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("stopped");
    await expect(harness.runtime.readStartup({ agentId: "main" })).resolves.toBeUndefined();
    await harness.runtime.stop();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(harness.buildProjection).not.toHaveBeenCalled();
  });

  test.each(["commands", "projection"] as const)(
    "joins evicted on-demand %s work before shutdown completes",
    async (phase) => {
      const agentIds = Array.from({ length: 66 }, (_, index) => `agent-${index}`);
      const harness = createChatMetadataHarness({
        agents: { list: agentIds.map((id, index) => ({ id, default: index === 0 })) },
      });
      const release = createDeferred();
      const entered = createDeferred();
      const events: string[] = [];
      const hold = async () => {
        entered.resolve();
        await release.promise;
        events.push("work settled");
      };
      if (phase === "commands") {
        harness.buildCommands.mockImplementation(async ({ agentId }) => {
          if (agentId === "agent-0") {
            await hold();
          }
          return { commands: [] };
        });
      } else {
        harness.buildProjection.mockImplementation(async ({ facts }) => {
          if (facts.agentId === "agent-0") {
            await hold();
          }
          return { modelCatalog: facts.modelCatalog.entries, models: facts.modelCatalog.entries };
        });
      }
      await harness.runtime.refresh();
      const reading = harness.runtime.read({ agentId: "agent-0" }).catch((error: unknown) => {
        events.push("read settled");
        return error;
      });
      try {
        await entered.promise;
        for (const agentId of agentIds.slice(1)) {
          await harness.runtime.read({ agentId });
        }
        const stopping = harness.runtime.stop().then(() => events.push("shutdown completed"));
        await nextEventLoopTurn();
        expect(events).toEqual([]);
        release.resolve();
        await stopping;
        expect(await reading).toMatchObject({
          message: "gateway chat metadata runtime is stopped",
        });
        expect(events).toEqual(["work settled", "read settled", "shutdown completed"]);
        await expect(harness.runtime.read({ agentId: "agent-0" })).rejects.toThrow("stopped");
      } finally {
        release.resolve();
        await Promise.allSettled([reading, harness.runtime.stop()]);
      }
    },
  );
});

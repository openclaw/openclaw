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
    expect(harness.buildProjection).toHaveBeenCalledOnce();
  });

  test.each([
    { replacement: false, phase: "agent" },
    { replacement: true, phase: "agent" },
    { replacement: false, phase: "session" },
    { replacement: true, phase: "session" },
  ])(
    "rejects readers during $phase preparation and joins abandoned work after sibling failure (replacement: $replacement)",
    async ({ replacement, phase }) => {
      const onChanged = vi.fn();
      const harness = createChatMetadataHarness(
        { agents: { list: [{ id: "main", default: true }, { id: "other" }] } },
        { onChanged },
      );
      const release = createDeferred();
      const entered = createDeferred();
      const failSibling = createDeferred();
      const events: string[] = [];
      if (replacement) {
        await harness.runtime.refresh();
        harness.runtime.invalidate();
      }
      const project = ({ facts }: Parameters<typeof harness.buildProjection>[0]) => ({
        modelCatalog: facts.modelCatalog.entries,
        models: facts.modelCatalog.entries,
      });
      const heldProjection = async (params: Parameters<typeof harness.buildProjection>[0]) => {
        entered.resolve();
        await release.promise;
        events.push("projection settled");
        return project(params);
      };
      if (phase === "session") {
        harness.buildProjection.mockImplementationOnce(async (params) => project(params));
      } else {
        harness.buildProjection.mockImplementationOnce(heldProjection);
      }
      harness.buildProjection.mockImplementationOnce(async () => {
        await failSibling.promise;
        throw new Error("sibling projection failed");
      });
      if (phase === "session") {
        harness.buildProjection.mockImplementationOnce(heldProjection);
      }
      const refresh = harness.runtime.refresh();
      let settledReads = 0;
      const readings = [
        harness.runtime.read({
          agentId: "main",
          sessionEntry: { authProfileOverride: "test:session", authProfileOverrideSource: "user" },
        }),
        harness.runtime.readStartup({
          agentId: "main",
          sessionEntry: { authProfileOverride: "test:session", authProfileOverrideSource: "user" },
        }),
      ].map((reading) =>
        reading
          .then(
            () => "published",
            () => "rejected",
          )
          .finally(() => {
            settledReads += 1;
          }),
      );
      try {
        await entered.promise;
        failSibling.resolve();
        await expect(refresh).rejects.toThrow("sibling projection failed");
        await nextEventLoopTurn();
        expect(settledReads).toBe(2);
        await expect(Promise.all(readings)).resolves.toEqual(["rejected", "rejected"]);
        const stopping = harness.runtime.stop().then(() => events.push("shutdown completed"));
        release.resolve();
        await stopping;
        expect(events).toEqual(["projection settled", "shutdown completed"]);
        expect(onChanged).toHaveBeenCalledTimes(replacement ? 2 : 1);
        await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("stopped");
      } finally {
        release.resolve();
        failSibling.resolve();
        await Promise.allSettled([refresh, ...readings, harness.runtime.stop()]);
      }
    },
  );
});

import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime session creation colors", () => {
  it("creates a plugin-owned CLI fork with canonical color", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-cli-session-create" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:catalog-adopt:claude:source";
      const created = await runtime.session.createSessionEntry({
        cfg: {},
        key,
        label: "Renamed CLI session",
        execNode: "node-a",
        execCwd: "/work/on-node",
        initialEntry: {
          cliBackendId: "claude-cli",
          color: " Blue ",
          model: "claude-opus-4-8",
          modelSelectionLocked: true,
          pluginOwnerId: "anthropic",
          cliSessionBinding: {
            sessionId: "claude-source",
            forceReuse: true,
            forkNextResume: true,
          },
        },
        afterCreate: async ({ entry }) => {
          expect(entry.initializationPending).toBe(true);
          expect(entry.color).toBe("blue");
        },
      });
      expect(created.entry.color).toBe("blue");
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(created.entry);
      expect(created.entry).toMatchObject({
        label: "Renamed CLI session",
        createdVia: "plugin",
        createdActor: { type: "system", id: "anthropic" },
        createdAt: expect.any(Number),
        pluginOwnerId: "anthropic",
        providerOverride: "claude-cli",
        modelOverride: "claude-opus-4-8",
        modelOverrideRouteResolution: "resolved",
        modelSelectionLocked: true,
        execHost: "node",
        execNode: "node-a",
        execCwd: "/work/on-node",
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-source",
            forceReuse: true,
            forkNextResume: true,
          },
        },
      });
    });
  });
});

describe("plugin runtime session patches", () => {
  it("rejects a patch whose owner closes during asynchronous preparation", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-patch-owner" }, async () => {
      const runtime = createRuntimeAgent();
      const scope = { agentId: "main", sessionKey: "agent:main:reef:group:room" };
      await runtime.session.upsertSessionEntry({
        ...scope,
        entry: { sessionId: "original", updatedAt: 100, displayName: "Original title" },
      });
      const original = runtime.session.getSessionEntry(scope);
      const preparing = createDeferred();
      const releasePreparation = createDeferred();
      let ownerActive = true;
      const patch = runtime.session.patchSessionEntry({
        ...scope,
        preserveActivity: true,
        assertCommitAllowed: () => {
          if (!ownerActive) {
            throw new Error("Session patch owner closed");
          }
        },
        update: async () => {
          preparing.resolve();
          await releasePreparation.promise;
          return { displayName: "Stale title" };
        },
      });
      try {
        await preparing.promise;
        ownerActive = false;
        releasePreparation.resolve();
        await expect(patch).rejects.toThrow("Session patch owner closed");
        expect(runtime.session.getSessionEntry(scope)).toEqual(original);
      } finally {
        releasePreparation.resolve();
        await patch.catch(() => undefined);
      }
    });
  });
});

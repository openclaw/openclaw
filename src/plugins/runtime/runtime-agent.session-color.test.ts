import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

it("creates a plugin-owned CLI fork with canonical color", async () => {
  await withOpenClawTestState({ label: "plugin-runtime-cli-session-create" }, async () => {
    await captureRuntimeConfigAsyncReader()();
    const { session } = createRuntimeAgent();
    const key = "agent:main:catalog-adopt:claude:source";
    const binding = { sessionId: "claude-source", forceReuse: true, forkNextResume: true };
    const created = await session.createSessionEntry({
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
        cliSessionBinding: binding,
      },
      afterCreate: async ({ entry }) => {
        expect(entry).toMatchObject({ initializationPending: true, color: "blue" });
      },
    });
    expect(session.getSessionEntry({ sessionKey: key, readConsistency: "latest" })).toEqual(
      created.entry,
    );
    expect(created.entry).toMatchObject({
      color: "blue",
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
        "claude-cli": { sessionId: "claude-source", forceReuse: true, forkNextResume: true },
      },
    });
  });
});

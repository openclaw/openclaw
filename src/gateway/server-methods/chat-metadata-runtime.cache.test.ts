import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, test, vi } from "vitest";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

test("rejects a retired owner instead of retrying compact metadata indefinitely", async () => {
  const config = { agents: { entries: { main: {} } } };
  const harness = createChatMetadataHarness(config);
  const isCurrent = vi.fn(() => true);
  harness.setOwner({ ...createChatMetadataOwner(config, "retired"), isCurrent });
  try {
    await harness.runtime.refresh();
    await harness.runtime.read({ agentId: "main", includeModels: false });
    // Bound the regression's microtask loop without a real timer.
    isCurrent
      .mockClear()
      .mockReturnValueOnce(false)
      .mockImplementation(() => {
        throw new Error("Compact metadata repeatedly read a retired owner");
      });
    await expect(harness.runtime.read({ agentId: "main", includeModels: false })).rejects.toThrow(
      'prepared chat metadata owner retired for agent "main"',
    );
    expect(isCurrent).toHaveBeenCalledOnce();
  } finally {
    await harness.runtime.stop();
  }
});

test.each(["metadata", "startup"] as const)(
  "projects each session's account provenance when %s reuses its catalog",
  async (surface) => {
    const harness = createChatMetadataHarness();
    const read = async (source: "user" | "user-link") => {
      const params = {
        agentId: "main",
        sessionEntry: {
          authProfileOverride: "test:shared",
          authProfileOverrideSource: source,
        },
      };
      return surface === "metadata"
        ? await harness.runtime.read(params)
        : (await harness.runtime.readStartup(params))?.metadata;
    };
    try {
      await harness.runtime.refresh();
      for (const source of ["user", "user-link", "user"] as const) {
        expect((await read(source))?.accountSelection).toEqual({
          kind: "shared",
          authProfileId: "test:shared",
          label: "test:shared",
          source,
        });
      }
      expect(harness.buildProjection).toHaveBeenCalledTimes(surface === "startup" ? 2 : 1);
    } finally {
      await harness.runtime.stop();
    }
  },
);

test.each(["neutral", "profile"] as const)(
  "releases session entries after caching a %s catalog",
  async (variant) => {
    class SessionInput {
      sessionId = "retired-input";
      authProfileOverride = variant === "profile" ? "test:shared" : undefined;
    }
    const control = new WeakRef({});
    expect(control.deref()).toBeDefined();
    const harness = createChatMetadataHarness();
    try {
      await harness.runtime.refresh();
      const metadata = await harness.runtime.read({
        agentId: "main",
        sessionEntry: new SessionInput(),
      });
      await setImmediate();
      const retained = queryObjects(SessionInput);
      expect(control.deref()).toBeUndefined();
      expect(retained).toBe(0);
      expect(await harness.runtime.read({ agentId: "main" })).toMatchObject({
        models: metadata.models,
      });
      expect(metadata.models).toEqual([expect.objectContaining({ id: "first" })]);
    } finally {
      await harness.runtime.stop();
    }
  },
);

test("bounds retained commands and neutral projections instead of warming the fleet", async () => {
  const agentIds = Array.from({ length: 200 }, (_, index) => `agent-${index}`);
  const harness = createChatMetadataHarness({
    agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
  });
  try {
    await harness.runtime.refresh();
    expect(harness.buildCommands).not.toHaveBeenCalled();
    expect(harness.buildProjection).not.toHaveBeenCalled();
    for (const readPolicy of ["current", "ready"] as const) {
      await expect(
        harness.runtime.readStartup({ agentId: "agent-0", readPolicy }),
      ).resolves.toBeUndefined();
    }
    expect(harness.buildProjection).not.toHaveBeenCalled();

    const first = await harness.runtime.read({ agentId: "agent-0" });
    expect(await harness.runtime.read({ agentId: "agent-0" })).toEqual(first);
    expect(harness.buildCommands).toHaveBeenCalledOnce();
    expect(harness.buildProjection).toHaveBeenCalledOnce();
    for (const agentId of agentIds.slice(1)) {
      await harness.runtime.read({ agentId });
    }
    expect(harness.buildCommands).toHaveBeenCalledTimes(agentIds.length);
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);
    const retained: string[] = [];
    for (const agentId of agentIds) {
      if (await harness.runtime.readStartup({ agentId, readPolicy: "ready" })) {
        retained.push(agentId);
      }
    }
    expect(retained).toEqual(agentIds.slice(-64));
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);

    expect(await harness.runtime.read({ agentId: "agent-0" })).toEqual(first);
    expect(harness.buildCommands).toHaveBeenCalledTimes(agentIds.length + 1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length + 1);
  } finally {
    await harness.runtime.stop();
  }
});

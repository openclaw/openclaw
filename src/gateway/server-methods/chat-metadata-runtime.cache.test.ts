import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { onTestFinished, assert, expect, test, vi } from "vitest";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

test("rejects a retired owner instead of retrying compact metadata indefinitely", async () => {
  const config = { agents: { entries: { main: {} } } };
  const harness = createChatMetadataHarness(config);
  onTestFinished(() => harness.runtime.stop());
  const isCurrent = vi.fn(() => true);
  harness.setOwner({ ...createChatMetadataOwner(config, "retired"), isCurrent });
  await harness.refresh();
  await harness.read({ includeModels: false });
  // Bound the regression's microtask loop without a real timer.
  isCurrent
    .mockClear()
    .mockReturnValueOnce(false)
    .mockImplementation(() => assert.fail("Compact metadata repeatedly read a retired owner"));
  await expect(harness.read({ includeModels: false })).rejects.toThrow(
    'prepared chat metadata owner retired for agent "main"',
  );
  expect(isCurrent).toHaveBeenCalledOnce();
});

test("projects each session's account provenance when metadata reuses its catalog", async () => {
  const harness = createChatMetadataHarness();
  onTestFinished(() => harness.runtime.stop());
  await harness.refresh();
  const id = "test:shared";
  for (const source of ["user", "user-link", "user"] as const) {
    const sessionEntry = { authProfileOverride: id, authProfileOverrideSource: source };
    const { accountSelection } = await harness.read({ sessionEntry });
    expect(accountSelection).toEqual({ kind: "shared", authProfileId: id, label: id, source });
  }
  expect(harness.buildProjection).toHaveBeenCalledOnce();
});

test.each(["neutral", "profile"] as const)(
  "releases session entries after caching a %s catalog",
  async (variant) => {
    class SessionInput {
      authProfileOverride = variant === "profile" ? "test:shared" : undefined;
    }
    const control = new WeakRef({});
    const harness = createChatMetadataHarness();
    onTestFinished(() => harness.runtime.stop());
    await harness.refresh();
    const metadata = await harness.read({ sessionEntry: new SessionInput() });
    await setImmediate();
    expect(queryObjects(SessionInput)).toBe(0);
    expect(control.deref()).toBeUndefined();
    expect(await harness.read()).toMatchObject({ models: metadata.models });
    expect(metadata.models).toEqual([expect.objectContaining({ id: "first" })]);
  },
);

test("bounds retained commands and neutral projections instead of warming the fleet", async () => {
  const agentIds = Array.from({ length: 200 }, (_, index) => `agent-${index}`);
  const harness = createChatMetadataHarness({
    agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
  });
  onTestFinished(() => harness.runtime.stop());
  await harness.refresh();
  expect(harness.buildCommands).not.toHaveBeenCalled();
  expect(harness.buildProjection).not.toHaveBeenCalled();
  for (const readPolicy of ["current", "ready"] as const) {
    await expect(harness.startup({ agentId: "agent-0", readPolicy })).resolves.toBeUndefined();
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
    if (await harness.startup({ agentId, readPolicy: "ready" })) {
      retained.push(agentId);
    }
  }
  expect(retained).toEqual(agentIds.slice(-64));
  expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);

  expect(await harness.runtime.read({ agentId: "agent-0" })).toEqual(first);
  expect(harness.buildCommands).toHaveBeenCalledTimes(agentIds.length + 1);
  expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length + 1);
});

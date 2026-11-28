import { validateToolArguments } from "@openclaw/llm-core/validation";
import { expect, it } from "vitest";
import {
  callGatewayMock,
  createTestCronTool,
  installCronToolTestFixture,
  readGatewayCall,
} from "./cron-tool.test-support.js";

installCronToolTestFixture();

it.each([
  { everyMs: 60_000, text: "Stretch" },
  { "schedule.everyMs": 60_000, "payload.text": "Stretch" },
  { every: 60_000, text: "Stretch" },
])("recovers a malformed job wrapper before validating flat fields %j", async (fields) => {
  const tool = createTestCronTool();
  const input = { action: "add", job: "remind", name: "Break", ...fields };
  const args = tool.prepareArguments?.(input) ?? input;
  const validated = validateToolArguments(tool, {
    type: "toolCall",
    id: "malformed-wrapper",
    name: "automations",
    arguments: args as Record<string, unknown>,
  });
  await tool.execute("malformed-wrapper", validated);
  expect(callGatewayMock).toHaveBeenCalledOnce();
  expect(readGatewayCall()).toMatchObject({
    method: "cron.add",
    params: {
      name: "Break",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "systemEvent", text: "Stretch" },
    },
  });
  expect(input.job).toBe("remind");
});

it("keeps valid nested wrappers authoritative and rejects unusable recovery", () => {
  const tool = createTestCronTool();
  const nested = { schedule: { everyMs: 60_000 }, payload: { text: "Nested" } };
  for (const job of [nested, JSON.stringify(nested)]) {
    const input = { action: "add", job, text: "Flat" };
    const args = tool.prepareArguments?.(input) ?? input;
    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "nested",
        name: "automations",
        arguments: args as Record<string, unknown>,
      }),
    ).toMatchObject({ job: nested });
  }
  expect(() => tool.prepareArguments?.({ action: "add", job: "remind", name: "Empty" })).toThrow(
    "job required: provide an object or usable flat job fields",
  );
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it("still rejects an empty recovered update before any Gateway call", async () => {
  const tool = createTestCronTool();
  const input = { action: "update", jobId: "saved-job", job: "remind", fallbacks: [123] };
  const args = tool.prepareArguments?.(input) ?? input;
  const validated = validateToolArguments(tool, {
    type: "toolCall",
    id: "empty-update",
    name: "automations",
    arguments: args as Record<string, unknown>,
  });
  await expect(tool.execute("empty-update", validated)).rejects.toThrow("job required");
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it("recovers a malformed wrapper for a partial update", async () => {
  const tool = createTestCronTool();
  const input = { action: "update", jobId: "saved-job", job: "change", enabled: false };
  const args = tool.prepareArguments?.(input) ?? input;
  const validated = validateToolArguments(tool, {
    type: "toolCall",
    id: "update",
    name: "automations",
    arguments: args as Record<string, unknown>,
  });
  await tool.execute("update", validated);
  expect(callGatewayMock).toHaveBeenCalledWith(
    { method: "cron.update", params: { id: "saved-job", patch: { enabled: false } } },
    expect.anything(),
  );
});

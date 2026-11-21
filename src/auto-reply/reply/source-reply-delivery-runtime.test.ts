import { expect, it } from "vitest";
import { createSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";

it("replaces only the bound delivery prompt component", () => {
  const repeatedPrefix = "same guidance\n\nindependent context\n\n";
  const run = { extraSystemPrompt: `${repeatedPrefix}same guidance\n\nlater context` };
  const runtime = createSourceReplyDeliveryRuntime({
    origin: "runtime_default",
    initialMode: "message_tool_only",
    projections: [run],
    promptComponentByMode: {
      automatic: "automatic guidance",
      message_tool_only: "same guidance",
    },
    promptComponentOffset: repeatedPrefix.length,
  });

  runtime.applyPreparedMode(run, "automatic");
  expect(run.extraSystemPrompt).toBe(`${repeatedPrefix}automatic guidance\n\nlater context`);

  const absent = { extraSystemPrompt: "independent context only" };
  createSourceReplyDeliveryRuntime({
    origin: "runtime_default",
    initialMode: "message_tool_only",
    projections: [absent],
    promptComponentByMode: {
      automatic: "automatic guidance",
      message_tool_only: "missing guidance",
    },
    promptComponentOffset: undefined,
  }).applyPreparedMode(absent, "automatic");
  expect(absent.extraSystemPrompt).toBe("independent context only");

  const empty = { extraSystemPrompt: "independent context only" };
  createSourceReplyDeliveryRuntime({
    origin: "runtime_default",
    initialMode: "message_tool_only",
    projections: [empty],
    promptComponentByMode: { automatic: "", message_tool_only: "" },
    promptComponentOffset: undefined,
  }).applyPreparedMode(empty, "automatic");
  expect(empty.extraSystemPrompt).toBe("independent context only");
});

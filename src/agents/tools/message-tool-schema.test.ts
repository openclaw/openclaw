import { normalizeToolParameterSchema } from "@openclaw/ai/internal/tool-schema";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { buildMessageToolSchemaFromActions } from "./message-tool-schema.js";

const options = {
  includePresentation: false,
  includeDeliveryPin: false,
  includeBestEffort: false,
};

describe("message schema variants", () => {
  it("projects presentation table cells to a scalar Gemini type without changing the source schema", () => {
    const source = buildMessageToolSchemaFromActions(["send"], {
      ...options,
      includePresentation: true,
    });
    const cellType =
      "properties.presentation.properties.blocks.items.properties.rows.items.items.type";
    expect(normalizeToolParameterSchema(source, { modelProvider: "google" })).toHaveProperty(
      cellType,
      "string",
    );
    expect(normalizeToolParameterSchema(source, { modelProvider: "anthropic" })).toHaveProperty(
      cellType,
      ["string", "number"],
    );
    expect(source).toHaveProperty(cellType, ["string", "number"]);
  });

  it("reuses equivalent capabilities and detaches channel-owned properties", () => {
    const extraProperties = { topic: Type.Optional(Type.String({ maxLength: 10 })) };
    const first = buildMessageToolSchemaFromActions(["send"], { ...options, extraProperties });
    const equivalent = buildMessageToolSchemaFromActions(["send"], {
      ...options,
      extraProperties: { topic: Type.Optional(Type.String({ maxLength: 10 })) },
    });
    expect(equivalent).toBe(first);
    expect(Value.Check(first, { action: "send" })).toBe(true);
    Object.assign(extraProperties.topic, { maxLength: 20 });
    expect(Value.Check(first, { action: "send", topic: "12345678901" })).toBe(false);
    const changed = buildMessageToolSchemaFromActions(["send"], { ...options, extraProperties });
    expect(changed).not.toBe(first);
    expect(Value.Check(changed, { action: "send", topic: "12345678901" })).toBe(true);
    const required = buildMessageToolSchemaFromActions(["send"], {
      ...options,
      extraProperties: { topic: Type.String({ maxLength: 10 }) },
    });
    expect(required).not.toBe(first);
    expect(Value.Check(required, { action: "send" })).toBe(false);
  });

  it.each([
    "includeClawHub",
    "includePresentation",
    "includeDeliveryPin",
    "includeBestEffort",
  ] as const)("selects a fresh schema when %s changes", (flag) => {
    const first = buildMessageToolSchemaFromActions(["send"], options);
    const changed = buildMessageToolSchemaFromActions(["send"], { ...options, [flag]: true });
    expect(changed).not.toBe(first);
    expect(changed).not.toEqual(first);
    expect(buildMessageToolSchemaFromActions(["send"], { ...options, [flag]: true })).toBe(changed);
  });

  it("refreshes the action surface without changing an earlier schema", () => {
    const actions = ["send"];
    const first = buildMessageToolSchemaFromActions(actions, options);
    actions.push("poll");
    const next = buildMessageToolSchemaFromActions(actions, options);
    expect(Value.Check(first, { action: "poll" })).toBe(false);
    expect(Value.Check(next, { action: "poll" })).toBe(true);
    expect(next.properties).toHaveProperty("pollOptionId");
  });
});

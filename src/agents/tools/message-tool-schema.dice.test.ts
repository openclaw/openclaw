// Scoped groups merge into one flat object, so `dice` needs its own key to advertise a face.
import { describe, expect, it } from "vitest";
import { buildMessageToolSchemaFromActions } from "./message-tool-schema.js";

const OPTIONS = {
  includePresentation: false,
  includeDeliveryPin: false,
  includeBestEffort: false,
  scopeToActions: true,
} as const;

function schemaPropertiesFor(actions: readonly string[]) {
  const schema = buildMessageToolSchemaFromActions(actions, OPTIONS);
  return (schema as { properties?: Record<string, { description?: string }> }).properties ?? {};
}

describe("dice schema scoping", () => {
  it("scopes a dice-only schema to the dice face", () => {
    const properties = Object.keys(schemaPropertiesFor(["dice"]));
    expect(properties).toContain("diceEmoji");
    expect(properties).not.toContain("remove");
    expect(properties).not.toContain("trackToolCalls");
  });

  it("leaves the reaction emoji description intact when both actions are enabled", () => {
    const properties = schemaPropertiesFor(["react", "dice"]);
    expect(properties.emoji?.description).toBe(
      "Unicode emoji; channels may also support custom emoji.",
    );
    expect(properties.diceEmoji?.description).toContain("Dice face");
  });
});

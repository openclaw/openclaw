import { describe, expect, it } from "vitest";
import { configLabelInContext } from "./config-form.label-context.ts";

describe("configLabelInContext", () => {
  it.each([
    ["Gateway port", "Gateway", "Port"],
    ["Browser Profile CDP Port", "Browser profiles", "CDP Port"],
    ["Model catalog mode", "Models", "Catalog mode"],
    ["Agent list", "Agents", "Agent list"],
    ["HTTP API", "Gateway", "HTTP API"],
    ["Gateway", "Gateway", "Gateway"],
    ["Gatewayish name", "Gateway", "Gatewayish name"],
    ["Queue mode", undefined, "Queue mode"],
  ])("%s under %s reads as %s", (label, context, expected) => {
    expect(configLabelInContext(label, context)).toBe(expected);
  });
});

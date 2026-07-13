import { describe, expect, it } from "vitest";
import { composeConfigLayers } from "./config-layers.js";

describe("composeConfigLayers", () => {
  it("composes a realistic ordered stack recursively", () => {
    expect(
      composeConfigLayers([
        {
          id: "scout-global",
          config: { gateway: { mode: "local" }, tools: { deny: ["write"] } },
        },
        {
          id: "tenant-network",
          config: {
            gateway: {
              controlUi: { allowedOrigins: ["https://scout.contoso.example"] },
            },
          },
        },
        { id: "operator-local", config: { agents: { defaults: { workspace: "/workspace" } } } },
      ]),
    ).toEqual({
      valid: true,
      config: {
        gateway: {
          mode: "local",
          controlUi: { allowedOrigins: ["https://scout.contoso.example"] },
        },
        tools: { deny: ["write"] },
        agents: { defaults: { workspace: "/workspace" } },
      },
    });
  });

  it("accepts identical declarations and rejects replacement", () => {
    expect(
      composeConfigLayers([
        { id: "one", config: { gateway: { mode: "local" } } },
        { id: "two", config: { gateway: { mode: "local" } } },
      ]),
    ).toMatchObject({ valid: true });
    expect(
      composeConfigLayers([
        { id: "one", config: { gateway: { mode: "local" } } },
        { id: "two", config: { gateway: { mode: "remote" } } },
      ]),
    ).toEqual({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          layer: "two",
          path: "gateway.mode",
          controllingLayer: "one",
        },
      ],
    });
  });

  it("allows bounded tool policy tightening but rejects weakening", () => {
    expect(
      composeConfigLayers([
        { id: "global", config: { tools: { allow: ["read", "write"], deny: ["exec"] } } },
        { id: "tenant", config: { tools: { allow: ["read"], deny: ["exec", "write"] } } },
      ]),
    ).toEqual({
      valid: true,
      config: { tools: { allow: ["read"], deny: ["exec", "write"] } },
    });
    const weakened = composeConfigLayers([
      { id: "global", config: { tools: { allow: ["read"], deny: ["exec", "write"] } } },
      { id: "tenant", config: { tools: { allow: ["read", "write"], deny: ["exec"] } } },
    ]);
    expect(weakened).toMatchObject({
      valid: false,
      findings: [
        { reason: "WouldWeakenEarlierLayer", path: "tools.allow" },
        { reason: "WouldWeakenEarlierLayer", path: "tools.deny" },
      ],
    });
  });

  it("preserves empty object ownership", () => {
    expect(
      composeConfigLayers([
        { id: "global", config: { plugins: {} } },
        { id: "operator", config: { plugins: { enabled: true } } },
      ]),
    ).toMatchObject({
      valid: false,
      findings: [
        {
          reason: "ControlledByEarlierLayer",
          layer: "operator",
          path: "plugins",
          controllingLayer: "global",
        },
      ],
    });
  });
  it("returns structured findings for invalid layer boundaries", () => {
    expect(
      composeConfigLayers([
        { id: "", config: {} },
        { id: "same", config: [] },
        { id: "same", config: {} },
      ]),
    ).toEqual({
      valid: false,
      findings: [
        { reason: "EmptyLayerId", layer: "" },
        { reason: "InvalidLayerDocument", layer: "same" },
        { reason: "DuplicateLayerId", layer: "same" },
      ],
    });
  });
});

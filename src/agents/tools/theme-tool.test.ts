import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../packages/gateway-protocol/src/schema/themes.js";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { createThemeTool } from "./theme-tool.js";

vi.mock("./in-process-gateway.js", () => ({ callAgentToolGatewayRequest: vi.fn() }));

const callGateway = vi.mocked(callAgentToolGatewayRequest);
const appearance = {
  mascot: "none" as const,
  workingPhrases: ["Building", "Compiling"],
  critters: ["penguin", "fedora"],
  avatarHat: "fedora",
};
const definition = createThemeDefinitionFixture(appearance);
const selection = { id: "user/xenovessel", mode: "dark" } as const;
const importArgs = { action: "import", id: "xenovessel", definition };

describe("theme tool", () => {
  beforeEach(() => callGateway.mockReset());

  it.each([
    ["list", {}, schema.ThemesListParamsSchema],
    ["get", {}, schema.ThemesGetParamsSchema],
    ["get", { id: "space-pack/xenovessel" }, schema.ThemesGetParamsSchema],
    ["set", { id: "space-pack/xenovessel", mode: "dark" }, schema.ThemesSetParamsSchema],
    ["set", { id: null, mode: null }, schema.ThemesSetParamsSchema],
    [
      "import",
      { id: "xenovessel", definition, apply: true, mode: "dark" },
      schema.ThemesImportParamsSchema,
    ],
  ] as const)(
    "executes %s through the Gateway theme owner",
    async (action, params, paramsSchema) => {
      const args = {
        action,
        ...params,
        ...(action === "import"
          ? { definition: { ...definition, workingPhrases: [" Building ", "Compiling"] } }
          : {}),
      };
      const selected: schema.ThemesGetResult = {
        current: { ...selection, scope: "profile", overrides: selection },
        theme: {
          id: "user/xenovessel",
          name: definition.name,
          description: definition.description,
          modes: ["dark"],
          source: "user",
          ...appearance,
        },
        definition,
      };
      const { current, theme } = selected;
      const mutation = { current, theme, application: "saved" };
      const expected =
        action === "list" ? { current, themes: [theme] } : action === "get" ? selected : mutation;
      callGateway.mockResolvedValue({ ...selected, ...expected });
      const signal = new AbortController().signal;
      const tool = createThemeTool();
      expect(Value.Check(tool.parameters, args)).toBe(true);
      const result = await tool.execute(
        "theme-request",
        { ...args, profileId: "other-user" },
        signal,
      );
      expect(callGateway).toHaveBeenCalledExactlyOnceWith({
        method: `themes.${action}`,
        params,
        signal,
      });
      expect(Value.Check(paramsSchema, callGateway.mock.calls[0]?.[0].params)).toBe(true);
      expect(result.details).toEqual(expected);
    },
  );

  it.each([
    [{ action: "delete", id: "claw" }, "Unknown theme action"],
    [{ action: "set" }, "set requires id or mode"],
    [{ action: "set", id: "claw", mode: "sepia" }, "mode must be"],
    [{ ...importArgs, mode: null }, "import mode must be"],
    [{ ...importArgs, apply: "yes" }, "apply must be a boolean"],
    [{ ...importArgs, definition: { name: "Incomplete" } }, /description|palette|mode/i],
  ] as const)("rejects invalid arguments before dispatch (%#)", async (args, message) => {
    await expect(createThemeTool().execute("invalid", args)).rejects.toThrow(message);
    expect(callGateway).not.toHaveBeenCalled();
  });
});

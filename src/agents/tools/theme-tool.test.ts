import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThemesGetParamsSchema,
  ThemesImportParamsSchema,
  ThemesListParamsSchema,
  ThemesSetParamsSchema,
  type ThemesGetResult,
} from "../../../packages/gateway-protocol/src/schema/themes.js";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { createThemeTool } from "./theme-tool.js";

vi.mock("./in-process-gateway.js", () => ({ callAgentToolGatewayRequest: vi.fn() }));

const callGateway = vi.mocked(callAgentToolGatewayRequest);
const definition = createThemeDefinitionFixture();

describe("theme tool", () => {
  beforeEach(() => callGateway.mockReset());

  it.each([
    { args: { action: "list" }, params: {}, schema: ThemesListParamsSchema },
    { args: { action: "get" }, params: {}, schema: ThemesGetParamsSchema },
    {
      args: { action: "get", id: "space-pack/xenovessel" },
      params: { id: "space-pack/xenovessel" },
      schema: ThemesGetParamsSchema,
    },
    {
      args: { action: "set", id: "space-pack/xenovessel", mode: "dark" },
      params: { id: "space-pack/xenovessel", mode: "dark" },
      schema: ThemesSetParamsSchema,
    },
    {
      args: { action: "set", id: null, mode: null },
      params: { id: null, mode: null },
      schema: ThemesSetParamsSchema,
    },
    {
      args: { action: "import", id: "xenovessel", definition, apply: true, mode: "dark" },
      params: { id: "xenovessel", definition, apply: true, mode: "dark" },
      schema: ThemesImportParamsSchema,
    },
  ])("executes $args.action through the Gateway theme owner", async ({ args, params, schema }) => {
    const selected: ThemesGetResult = {
      current: {
        id: "user/xenovessel",
        mode: "dark",
        scope: "profile",
        overrides: { id: "user/xenovessel", mode: "dark" },
      },
      theme: {
        id: "user/xenovessel",
        name: definition.name,
        description: definition.description,
        modes: ["dark"],
        source: "user",
      },
      definition,
    };
    const reply =
      args.action === "list"
        ? { ...selected, themes: [selected.theme] }
        : args.action === "get"
          ? selected
          : { ...selected, application: "saved" };
    callGateway.mockResolvedValue(reply);
    const signal = new AbortController().signal;
    const tool = createThemeTool();
    expect(Value.Check(tool.parameters, args)).toBe(true);
    const result = await tool.execute(
      "theme-request",
      { ...args, profileId: "other-user" },
      signal,
    );
    expect(callGateway).toHaveBeenCalledExactlyOnceWith({
      method: `themes.${args.action}`,
      params,
      signal,
    });
    expect(Value.Check(schema, callGateway.mock.calls[0]?.[0].params)).toBe(true);
    expect(result.details).toEqual(
      args.action === "list"
        ? { current: selected.current, themes: [selected.theme] }
        : args.action === "get"
          ? selected
          : { current: selected.current, theme: selected.theme, application: "saved" },
    );
  });

  it("preserves imported branding through the Gateway get response", async () => {
    const brandedDefinition = createThemeDefinitionFixture({
      mascot: "none",
      workingPhrases: ["Building", "Compiling"],
      critters: ["penguin", "fedora"],
      avatarHat: "fedora",
    });
    const selected: ThemesGetResult = {
      current: {
        id: "user/xenovessel",
        mode: "dark",
        scope: "profile",
        overrides: { id: "user/xenovessel", mode: "dark" },
      },
      theme: {
        id: "user/xenovessel",
        name: brandedDefinition.name,
        description: brandedDefinition.description,
        modes: ["dark"],
        source: "user",
        mascot: "none",
        workingPhrases: ["Building", "Compiling"],
        critters: ["penguin", "fedora"],
        avatarHat: "fedora",
      },
      definition: brandedDefinition,
    };
    callGateway.mockResolvedValueOnce({ ...selected, application: "saved" });
    const tool = createThemeTool();
    const args = {
      action: "import",
      id: "xenovessel",
      definition: { ...brandedDefinition, workingPhrases: [" Building ", "Compiling"] },
      apply: true,
    };
    expect(Value.Check(tool.parameters, args)).toBe(true);
    await tool.execute("import-theme", args);
    expect(callGateway).toHaveBeenCalledExactlyOnceWith({
      method: "themes.import",
      params: { id: "xenovessel", definition: brandedDefinition, apply: true },
      signal: undefined,
    });
    expect(Value.Check(ThemesImportParamsSchema, callGateway.mock.calls[0]?.[0].params)).toBe(true);
    callGateway.mockResolvedValueOnce(selected);
    expect(
      (await tool.execute("get-theme", { action: "get", id: "user/xenovessel" })).details,
    ).toEqual(selected);
    expect(callGateway).toHaveBeenLastCalledWith({
      method: "themes.get",
      params: { id: "user/xenovessel" },
      signal: undefined,
    });
  });

  it.each([
    { args: { action: "delete", id: "claw" }, message: "Unknown theme action" },
    { args: { action: "set" }, message: "set requires id or mode" },
    { args: { action: "set", id: "claw", mode: "sepia" }, message: "mode must be" },
    {
      args: { action: "import", id: "xenovessel", definition, mode: null },
      message: "import mode must be",
    },
    {
      args: { action: "import", id: "xenovessel", definition, apply: "yes" },
      message: "apply must be a boolean",
    },
    {
      args: { action: "import", id: "xenovessel", definition: { name: "Incomplete" } },
      message: /description|palette|mode/i,
    },
    {
      args: {
        action: "import",
        id: "xenovessel",
        definition: { ...definition, critters: ["robot"] },
      },
      message: "theme.critters[0] must be one of penguin, fedora",
    },
    {
      args: {
        action: "import",
        id: "xenovessel",
        definition: { ...definition, avatarHat: "beanie" },
      },
      message: "theme.avatarHat must be one of fedora, crown, santa, party, pumpkin",
    },
  ])("rejects invalid $args.action before dispatch", async ({ args, message }) => {
    await expect(createThemeTool().execute("invalid", args)).rejects.toThrow(message);
    expect(callGateway).not.toHaveBeenCalled();
  });
});

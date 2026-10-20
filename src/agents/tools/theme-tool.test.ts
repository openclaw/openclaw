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
const definition = createThemeDefinitionFixture({
  mascot: "none",
  workingPhrases: ["Building", "Compiling"],
  critters: ["penguin", "fedora"],
  avatarHat: "fedora",
});

describe("theme tool", () => {
  beforeEach(() => callGateway.mockReset());

  const schemas = {
    list: ThemesListParamsSchema,
    get: ThemesGetParamsSchema,
    set: ThemesSetParamsSchema,
    import: ThemesImportParamsSchema,
  };
  it.each([
    ["list", {}],
    ["get", {}],
    ["get", { id: "space-pack/xenovessel" }],
    ["set", { id: "space-pack/xenovessel", mode: "dark" }],
    ["set", { id: null, mode: null }],
    ["import", { id: "xenovessel", definition, apply: true, mode: "dark" }],
  ] as const)("executes %s through the Gateway theme owner", async (action, params) => {
    const args = {
      action,
      ...params,
      ...(action === "import"
        ? { definition: { ...definition, workingPhrases: [" Building ", "Compiling"] } }
        : {}),
    };
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
        mascot: "none",
        workingPhrases: ["Building", "Compiling"],
        critters: ["penguin", "fedora"],
        avatarHat: "fedora",
      },
      definition,
    };
    const reply =
      action === "list"
        ? { ...selected, themes: [selected.theme] }
        : action === "get"
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
      method: `themes.${action}`,
      params,
      signal,
    });
    expect(Value.Check(schemas[action], callGateway.mock.calls[0]?.[0].params)).toBe(true);
    expect(result.details).toEqual(
      action === "list"
        ? { current: selected.current, themes: [selected.theme] }
        : action === "get"
          ? selected
          : { current: selected.current, theme: selected.theme, application: "saved" },
    );
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
  ])("rejects invalid $args.action before dispatch", async ({ args, message }) => {
    await expect(createThemeTool().execute("invalid", args)).rejects.toThrow(message);
    expect(callGateway).not.toHaveBeenCalled();
  });
});

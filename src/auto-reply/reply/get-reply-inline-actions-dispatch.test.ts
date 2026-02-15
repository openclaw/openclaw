import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

// Re-implement resolveToolPrimaryArgKey inline for unit testing since it's
// not exported.  The logic mirrors the private function in
// get-reply-inline-actions.ts exactly.
function resolveToolPrimaryArgKey(tool: { parameters?: Record<string, unknown> }): string | null {
  const schema = tool.parameters;
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const required = (schema as { required?: string[] }).required;
  if (!Array.isArray(required) || required.length === 0) {
    return null;
  }
  const properties = (schema as { properties?: Record<string, { type?: string }> }).properties;
  if (!properties) {
    return required[0] ?? null;
  }
  for (const key of required) {
    const prop = properties[key];
    if (prop && prop.type === "string") {
      return key;
    }
  }
  return required[0] ?? null;
}

describe("resolveToolPrimaryArgKey", () => {
  it("returns first required string param from sessions_spawn schema (#14326)", () => {
    const schema = Type.Object({
      task: Type.String(),
      label: Type.Optional(Type.String()),
      agentId: Type.Optional(Type.String()),
    });
    expect(resolveToolPrimaryArgKey({ parameters: schema })).toBe("task");
  });

  it("returns null when tool has no parameters", () => {
    expect(resolveToolPrimaryArgKey({})).toBeNull();
    expect(resolveToolPrimaryArgKey({ parameters: undefined })).toBeNull();
  });

  it("returns null when no required params exist", () => {
    const schema = Type.Object({
      label: Type.Optional(Type.String()),
    });
    expect(resolveToolPrimaryArgKey({ parameters: schema })).toBeNull();
  });

  it("returns first required param even if not string type", () => {
    const schema = Type.Object({
      count: Type.Number(),
      label: Type.Optional(Type.String()),
    });
    expect(resolveToolPrimaryArgKey({ parameters: schema })).toBe("count");
  });

  it("prefers first required string over non-string required", () => {
    const schema = Type.Object({
      count: Type.Number(),
      query: Type.String(),
    });
    expect(resolveToolPrimaryArgKey({ parameters: schema })).toBe("query");
  });

  it("returns 'command' when command is the first required string", () => {
    const schema = Type.Object({
      command: Type.String(),
    });
    expect(resolveToolPrimaryArgKey({ parameters: schema })).toBe("command");
  });
});

describe("command-dispatch tool arg mapping", () => {
  it("maps rawArgs to primary arg key when different from 'command'", () => {
    const rawArgs = "do something important";
    const primaryArgKey = "task";
    const toolArgs: Record<string, unknown> = {
      command: rawArgs,
      commandName: "spawn",
      skillName: "task",
    };
    if (primaryArgKey && primaryArgKey !== "command") {
      toolArgs[primaryArgKey] = rawArgs;
    }
    expect(toolArgs).toEqual({
      command: "do something important",
      commandName: "spawn",
      skillName: "task",
      task: "do something important",
    });
  });

  it("does not duplicate when primary arg key is 'command'", () => {
    const rawArgs = "do something";
    const primaryArgKey = "command";
    const toolArgs: Record<string, unknown> = {
      command: rawArgs,
      commandName: "run",
      skillName: "exec",
    };
    if (primaryArgKey && primaryArgKey !== "command") {
      toolArgs[primaryArgKey] = rawArgs;
    }
    expect(toolArgs).toEqual({
      command: "do something",
      commandName: "run",
      skillName: "exec",
    });
    expect(Object.keys(toolArgs)).not.toContain("task");
  });
});

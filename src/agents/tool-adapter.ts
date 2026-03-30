type ToolDefinition = {
  name: string;
  execute: (args: any) => Promise<any>;
};

export function adaptToolToRuntime(tool: any): ToolDefinition {
  // Already runtime-compatible
  if (tool.execute && tool.execute.length === 1) {
    return tool;
  }

  // OpenClaw Tool → Adapter
  if (tool.execute) {
    return {
      name: tool.name,
      async execute(args: any) {
        const result = await tool.execute("lfm", args);

        return result?.content
          ?.map((c: any) => c.text || "")
          .join("\n");
      },
    };
  }

  // Legacy Tool (.run)
  if (tool.run) {
    return {
      name: tool.name,
      async execute(args: any) {
        return await tool.run(args);
      },
    };
  }

  throw new Error(`Invalid tool: ${tool?.name}`);
}
export type ToolDefinition = {
  name: string;
  execute: (args: any) => Promise<any>;
};

export class ToolRuntime {
  private tools: Map<string, ToolDefinition>;

  constructor(tools: ToolDefinition[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  async run(name: string, args: unknown) {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    try {
      return await tool.execute(args ?? {});
    } catch (err) {
    return {
      error: true,
      message: String(err),
    };
  }
}
}
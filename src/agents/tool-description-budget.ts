function checkToolDescriptions(tools: readonly unknown[]): void {
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const description: unknown = Reflect.get(tool, "description");
    if (typeof description === "string" && Buffer.byteLength(description, "utf8") > 1024 * 1024) {
      throw new Error(
        "Tool description exceeds the 1 MiB wire budget; use tool discovery or narrow the configured catalog.",
      );
    }
    const fn: unknown = Reflect.get(tool, "function");
    if (fn && typeof fn === "object") {
      checkToolDescriptions([fn]);
    }
    const nested: unknown = Reflect.get(tool, "tools");
    if (Array.isArray(nested)) {
      checkToolDescriptions(nested);
    }
  }
}

/** Check the JSON wire view, including toJSON, without changing callable schemas. */
export function assertRuntimeToolDescriptionBudget(serializedTools: string): void {
  const tools: unknown = JSON.parse(serializedTools);
  if (Array.isArray(tools)) {
    checkToolDescriptions(tools);
  }
}

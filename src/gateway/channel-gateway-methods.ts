type ChannelGatewayMethodDescriptorLike = {
  name?: unknown;
};

function readMaybeArray<T>(
  plugin: unknown,
  key: "gatewayMethods" | "gatewayMethodDescriptors",
): readonly T[] {
  if (!plugin || typeof plugin !== "object") {
    return [];
  }
  try {
    const value = (plugin as Record<string, unknown>)[key];
    return Array.isArray(value) ? (value as readonly T[]) : [];
  } catch {
    return [];
  }
}

function readDescriptorName(descriptor: ChannelGatewayMethodDescriptorLike): string | undefined {
  try {
    return typeof descriptor.name === "string" ? descriptor.name : undefined;
  } catch {
    return undefined;
  }
}

/** Lists readable channel-owned gateway method names without trusting plugin metadata accessors. */
export function listChannelGatewayMethodNames(plugin: unknown): string[] {
  const methods: string[] = [];
  for (const method of readMaybeArray<unknown>(plugin, "gatewayMethods")) {
    if (typeof method === "string") {
      methods.push(method);
    }
  }
  for (const descriptor of readMaybeArray<ChannelGatewayMethodDescriptorLike>(
    plugin,
    "gatewayMethodDescriptors",
  )) {
    const name = readDescriptorName(descriptor);
    if (name !== undefined) {
      methods.push(name);
    }
  }
  return methods;
}

export function channelGatewayMethodNamesInclude(
  plugin: unknown,
  names: ReadonlySet<string>,
): boolean {
  return listChannelGatewayMethodNames(plugin).some((method) => names.has(method));
}

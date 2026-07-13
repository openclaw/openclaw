// Control UI config module wires control ui chunking behavior.
function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
}

function moduleIdIncludesPackage(id: string, packageName: string): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.includes(`/node_modules/${packageName}/`) ||
    normalized.includes(`/openclaw-pnpm-node-modules/${packageName}/`)
  );
}

type ControlUiChunkGraph = {
  getModuleInfo: (id: string) => { importers: readonly string[]; isEntry: boolean } | null;
};

function isStaticEntryDependency(
  id: string,
  graph: ControlUiChunkGraph,
  visited = new Set<string>(),
): boolean {
  if (visited.has(id)) {
    return false;
  }
  visited.add(id);
  const info = graph.getModuleInfo(id);
  return Boolean(
    info?.isEntry ||
    info?.importers.some((importer) => isStaticEntryDependency(importer, graph, visited)),
  );
}

export function controlUiManualChunk(id: string, graph?: ControlUiChunkGraph): string | undefined {
  const normalized = normalizeModuleId(id);

  // These entry-and-route helpers must stay together; separate shared chunks
  // turn small route-graph changes into extra startup preload requests.
  if (
    normalized.endsWith("/ui/src/components/config-form.shared.ts") ||
    normalized.endsWith("/ui/src/lib/clipboard.ts")
  ) {
    return "control-ui-shared";
  }

  if (normalized.endsWith("/ui/src/lib/gateway-methods.ts")) {
    return "gateway-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "lit") ||
    moduleIdIncludesPackage(id, "lit-html") ||
    moduleIdIncludesPackage(id, "@lit/reactive-element")
  ) {
    return "lit-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "highlight.js") ||
    moduleIdIncludesPackage(id, "markdown-it") ||
    moduleIdIncludesPackage(id, "markdown-it-task-lists") ||
    moduleIdIncludesPackage(id, "dompurify") ||
    moduleIdIncludesPackage(id, "entities") ||
    moduleIdIncludesPackage(id, "linkify-it") ||
    moduleIdIncludesPackage(id, "mdurl") ||
    moduleIdIncludesPackage(id, "punycode.js") ||
    moduleIdIncludesPackage(id, "uc.micro")
  ) {
    return "markdown-runtime";
  }

  if (moduleIdIncludesPackage(id, "zod") || moduleIdIncludesPackage(id, "json5")) {
    return "config-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "@noble/ed25519") ||
    moduleIdIncludesPackage(id, "@noble/hashes") ||
    moduleIdIncludesPackage(id, "ipaddr.js")
  ) {
    return "gateway-runtime";
  }

  if (graph && isStaticEntryDependency(id, graph)) {
    return normalized.includes("/ui/src/") ? "control-ui-core" : "control-ui-foundation";
  }

  return undefined;
}

export function createRemotePluginCatalogFixture() {
  return {
    packageName: "@alice/memory-plus",
    displayName: "Memory Plus",
    family: "code-plugin" as const,
    isOfficial: false,
    categories: ["memory"],
    runtimeId: "memory-plus",
  };
}

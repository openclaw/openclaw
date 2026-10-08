export type ProjectRegistryIdentity = {
  id: string;
  repoRoot: string;
  originUrl?: string;
  source: "workspace" | "registered" | "cloned";
};

export type ProjectRegistryRecord = ProjectRegistryIdentity & {
  displayName: string;
  agentId?: string;
};

export type ProjectRegistryInsert = {
  displayName: string;
  repoRoot: string;
  originUrl?: string;
  source: "registered" | "cloned";
};

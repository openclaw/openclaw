export type PluginHookSkillArtifact = {
  name: string;
  skillKey: string;
  description?: string;
  skillFile: string;
  skillDir: string;
  source: string;
  revision: {
    declaredVersion?: string;
    contentSha256: string;
    treeSha256: string;
    sourceVersion?: string;
  };
};

export type PluginHookSkillChangedEvent = {
  action: "created" | "updated" | "removed";
  source: "workshop" | "clawhub" | "source-install" | "upload" | "plugin";
  /** Set by the host when `source` is "plugin": the plugin whose skills root changed. */
  pluginId?: string;
  occurredAt: string;
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
};

export type PluginHookSkillContext = {
  workspaceDir: string;
  agentId?: string;
};

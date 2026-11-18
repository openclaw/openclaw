/**
 * Places in Control UI Settings that a message or document can link to. Each place has a
 * route for surfaces that can open a link and words for surfaces that cannot. Hand-built
 * rows take their setting ID from here, and the Control UI tests fail when a place names a
 * route or setting the Control UI does not have.
 */
type ControlUiSettingsPlace = {
  /** Route path below the Control UI base path. */
  readonly path: string;
  /** The route continues with the agent ID, then `agentPanel` when present. */
  readonly agent?: true;
  readonly agentPanel?: "tools" | "skills";
  /** Setting ID or block anchor on the page; absent when the place is the page itself. */
  readonly hash?: string;
  /** Names the place where no link can be opened, such as a channel without a reachable Gateway. */
  readonly label: string;
};

export const CONTROL_UI_SETTINGS_PLACES = {
  "models.primary": {
    path: "/settings/model-providers",
    hash: "agents.defaults.model.primary",
    label: "Settings > Models > Model",
  },
  "models.fallbacks": {
    path: "/settings/model-providers",
    hash: "agents.defaults.model.fallbacks",
    label: "Settings > Models > Fallback model",
  },
  "models.thinking": {
    path: "/settings/model-providers",
    hash: "agents.defaults.thinkingDefault",
    label: "Settings > Models > Effort",
  },
  "models.providers": {
    path: "/settings/model-providers",
    hash: "settings-model-providers",
    label: "Settings > Models",
  },
  "agents.replyTimeout": {
    path: "/settings/ai-agents",
    hash: "agents.defaults.timeoutSeconds",
    label: "Settings > Agents > Agent defaults > Timeout seconds",
  },
  "agents.modelPolicy": {
    path: "/settings/ai-agents",
    hash: "agents.defaults.modelPolicy.allow",
    label: "Settings > Agents > Agent defaults > Model policy",
  },
  "gateway.publicOrigin": {
    path: "/settings/infrastructure",
    hash: "gateway.publicOrigin",
    label: "Settings > Infrastructure > Public origin",
  },
  "agent.model": {
    path: "/settings/agents",
    agent: true,
    hash: "agent.model.primary",
    label: "Settings > Agents > Overview > Primary model",
  },
  "agent.fallbacks": {
    path: "/settings/agents",
    agent: true,
    hash: "agent.model.fallbacks",
    label: "Settings > Agents > Overview > Fallbacks",
  },
  "agent.tools": {
    path: "/settings/agents",
    agent: true,
    agentPanel: "tools",
    label: "Settings > Agents > Tools",
  },
  "agent.skills": {
    path: "/settings/agents",
    agent: true,
    agentPanel: "skills",
    label: "Settings > Agents > Skills",
  },
} as const satisfies Record<string, ControlUiSettingsPlace>;

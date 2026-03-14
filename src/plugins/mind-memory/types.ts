/** Typed shape of the mind-memory plugin config within the global config. */
export type MindMemoryPluginConfig = {
  debug?: boolean;
  memoryDir?: string;
  graphiti?: {
    enabled?: boolean;
    autoStart?: boolean;
    baseUrl?: string;
    rewriteMemories?: boolean;
    thinking?: string;
  };
  narrative?: {
    enabled?: boolean;
    autoBootstrapStory?: boolean;
    thinking?: string;
  };
  /** Hyperfocus/intensive mode settings. */
  intensive?: {
    /**
     * Extra system prompt injected when hyperfocus mode is active.
     * Use this to customize the assistant's behavior during focused work sessions
     * (e.g. suppress persona expressions, enforce terse technical replies, etc.).
     */
    extraSystemPrompt?: string;
  };
  llamacpp?: LlamaCppConfig;
};

export type LlamaCppServerConfig = {
  url: string;
  slots?: {
    normal?: number;
    intensive?: number;
    subagentBase?: number;
  };
};

export type LlamaCppConfig = {
  servers?: LlamaCppServerConfig[];
};

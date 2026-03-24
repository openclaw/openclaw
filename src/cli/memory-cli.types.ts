export type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
};

export type MemorySearchCommandOptions = MemoryCommandOptions & {
  query?: string;
  maxResults?: number;
  minScore?: number;
};

export type MemoryConsolidateCommandOptions = MemoryCommandOptions & {
  agent?: string;
  retentionDays?: number;
  maxFiles?: number;
  force?: boolean;
  verbose?: boolean;
  json?: boolean;
};

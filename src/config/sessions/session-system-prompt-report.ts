/** Persisted size and provenance summary for one assembled system prompt. */
export type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: {
    warningMode?: "off" | "once" | "always";
    warningShown?: boolean;
    promptWarningSignature?: string;
    warningSignaturesSeen?: string[];
    truncatedFiles?: number;
    nearLimitFiles?: number;
    totalNearLimit?: boolean;
  };
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
    hash?: string;
  };
  currentTurn?: {
    kind?: "user_request" | "room_event";
    promptChars: number;
    runtimeContextChars: number;
    // Hook prepend/append context sent to the model but absent from the
    // persisted transcript prompt; consumers add it on top of transcript sums.
    modelOnlyPromptChars?: number;
  };
  injectedWorkspaceFiles: Array<
    {
      name: string;
      path: string;
      origin?: {
        kind: "agent-workspace" | "execution-project" | "personal" | "other";
        rootPath?: string;
      };
      missing: boolean;
      rawChars: number;
    } & (
      | {
          injectionStatus?: "verified";
          injectedChars: number;
          truncated: boolean;
        }
      | {
          injectionStatus: "native_unverified";
          injectedChars: null;
          truncated: null;
        }
    )
  >;
  skills: {
    promptChars: number;
    hash?: string;
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      source?: "openclaw" | "mcp" | "client";
      sourceName?: string;
      serverName?: string;
      summaryChars: number;
      summaryHash?: string;
      schemaChars: number;
      schemaHash?: string;
      propertiesCount?: number | null;
    }>;
    /** Available schemas, not part of the consumed schemaChars total. */
    deferred?: {
      /** Sum of known sizes; entries with null sizes remain unmeasured. */
      schemaChars: number;
      entries: Array<{
        name: string;
        source: "openclaw" | "mcp" | "client";
        sourceName?: string;
        serverName?: string;
        schemaChars: number | null;
      }>;
    };
  };
};

const pathTail = (filePath: string, segments: number) =>
  filePath
    .split(/[\\/]+/u)
    .slice(-segments)
    .join("/");

/**
 * Layered workspaces can inject one basename from two directories; label those by source path.
 * `compact` keeps only the trailing segments that tell them apart, for labels that get clipped.
 */
export function formatInjectedWorkspaceFileLabel(
  file: { name: string; path: string },
  shownFiles: ReadonlyArray<{ name: string; path: string }>,
  options: { compact?: boolean } = {},
): string {
  const others = shownFiles.filter((other) => other.name === file.name && other.path !== file.path);
  if (others.length === 0) {
    return file.name;
  }
  if (!options.compact) {
    return `${file.name} (${file.path})`;
  }
  for (let segments = 2; ; segments += 1) {
    const label = pathTail(file.path, segments);
    if (
      label === pathTail(file.path, segments + 1) ||
      others.every((other) => pathTail(other.path, segments) !== label)
    ) {
      return label;
    }
  }
}

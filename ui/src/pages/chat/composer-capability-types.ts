import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationNavigationOptions } from "../../app/context.ts";
import type { McpServerSummary } from "../../lib/config/mcp-servers.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import type { ComposerLibraryProps } from "./composer-library-session.ts";

export type ChatComposerPlusMenuView =
  | "root"
  | "skills"
  | "connectors"
  | "libraries"
  | `library:${string}`;

export type ChatComposerMenuSkill = {
  key: string;
  name: string;
  emoji?: string;
  enabled: boolean;
  baseEnabled: boolean;
  missingDeps?: boolean;
  blocked?: boolean;
};

export type ChatComposerCapabilityMenuProps = {
  basePath: string;
  skills: readonly ChatComposerMenuSkill[] | null;
  skillsRead: Promise<readonly ChatComposerMenuSkill[] | null> | null;
  library?: ComposerLibraryProps;
  mcpServers: readonly McpServerSummary[];
  mcpServersReadState: "ready" | "restricted" | "loading" | "unavailable";
  toolsEffectiveResult: ToolsEffectiveResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: boolean;
  toolAccessMutationBlockedReason: string | null;
  webSearchBaseEnabled: boolean;
  mutationBlockedReason: string | null;
  canAdmin: boolean;
  adminBlockedReason: string | null;
  onLoadSkills: () => void;
  onLoadView?: (view: ChatComposerPlusMenuView) => void;
  onPatchToolOverrides: (next: SessionToolOverrides | null) => void;
  onNavigate: (
    routeId: "mcp" | "plugins" | "skills",
    options?: ApplicationNavigationOptions,
  ) => void;
  onAddServer?: () => void;
  onOpenToolAccess?: (serverName: string) => void;
};

import type { RequirementRemote, RequirementsMetadata } from "../shared/requirements.js";

export type HookInstallSpec = {
  id?: string;
  kind: "bundled" | "npm" | "git";
  label?: string;
  package?: string;
  repository?: string;
  bins?: string[];
};

export type OpenClawHookMetadata = RequirementsMetadata & {
  always?: boolean;
  hookKey?: string;
  emoji?: string;
  homepage?: string;
  /** Events this hook handles (e.g., ["command:new", "session:start"]) */
  events: string[];
  /** Optional export name (default: "default") */
  export?: string;
  install?: HookInstallSpec[];
};

export type ParsedHookFrontmatter = Record<string, string>;

export type Hook = {
  name: string;
  description: string;
  source: "openclaw-bundled" | "openclaw-managed" | "openclaw-workspace" | "openclaw-plugin";
  pluginId?: string;
  filePath: string; // Path to HOOK.md
  baseDir: string; // Directory containing hook
  handlerPath: string; // Path to handler module (handler.ts/js)
};

export type HookSource = Hook["source"];

export type HookEntry = {
  hook: Hook;
  frontmatter: ParsedHookFrontmatter;
  metadata?: OpenClawHookMetadata;
  invocation?: { enabled: boolean };
};

export type HookPolicyEntry = Pick<HookEntry, "metadata"> & {
  hook: Pick<Hook, "name" | "source">;
};

export type HookEligibilityContext = {
  remote?: Required<RequirementRemote> & { note?: string };
};

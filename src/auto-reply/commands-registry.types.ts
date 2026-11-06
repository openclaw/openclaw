import type { OpenClawConfig } from "../config/types.js";
import type { CommandArgValues } from "./commands-args.types.js";
import type { ThinkingCatalogEntry } from "./thinking.shared.js";

export type { CommandArgValues, CommandArgs } from "./commands-args.types.js";

/**
 * Controls progressive disclosure of commands in the UI.
 * - "essential": Always visible (~10 core commands)
 * - "standard": Shown on expand / "Show more" (~15 commands)
 * - "power": Only surfaced via search or explicit filter (~15 commands)
 */
export type CommandTier = "essential" | "standard" | "power";

// v2026.8.1 SDK definitions may still use "docks"; it remains presentation-only.
export type CommandCategory =
  | "session"
  | "options"
  | "status"
  | "management"
  | "media"
  | "tools"
  | "docks";

export type CommandArgChoiceContext = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  catalog?: ThinkingCatalogEntry[];
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
};

export type CommandArgChoice = string | { value: string; label: string };

export type CommandArgDefinition = {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  choices?: CommandArgChoice[] | ((context: CommandArgChoiceContext) => CommandArgChoice[]);
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
};

/** Menu metadata for commands that should prompt for a missing argument. */
type CommandArgMenuSpec = {
  arg: string;
  title?: string;
};

export type CommandArgsParsing = "none" | "positional";

/** Canonical registry entry for one chat command across text and native surfaces. */
export type ChatCommandDefinition = {
  key: string;
  nativeName?: string;
  nativeAliases?: string[];
  nativeProviders?: string[];
  description: string;
  /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>;
  textAliases: string[];
  acceptsArgs?: boolean;
  args?: CommandArgDefinition[];
  argsParsing?: CommandArgsParsing;
  formatArgs?: (values: CommandArgValues) => string | undefined;
  argsMenu?: CommandArgMenuSpec | "auto";
  scope: "text" | "native" | "both";
  category?: CommandCategory;
  /** Progressive disclosure tier. Defaults to "standard" when omitted. */
  tier?: CommandTier;
  /** Handler is safe to resolve while another run owns the session execution slot. */
  activeRunSafe?: true;
  /** Browser command forms that do not need the selected chat model; authorization still applies. */
  modelIndependent?: "always" | "no-args" | "directive" | ((args: string) => boolean);
};

/** Provider-facing native command registration shape. */
export type NativeCommandSpec = {
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
  args?: CommandArgDefinition[];
  isAlias?: boolean;
};

export type CommandNormalizeOptions = {
  botUsername?: string;
  /** Keeps complete directive/task arguments, including whitespace and later lines. */
  preserveArguments?: boolean;
  /** Strip an explicit command target only while channel bot identity is unavailable. */
  targetedCommandMode?: "pre-identity";
};

export type ShouldHandleTextCommandsParams = {
  cfg: OpenClawConfig;
  surface: string;
  commandSource?: "text" | "native";
};

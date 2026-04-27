import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import type { ExplicitMentionSignal } from "./mentions.types.js";
export type { BuildMentionRegexes, ExplicitMentionSignal, MatchesMentionPatterns, MatchesMentionWithExplicit, } from "./mentions.types.js";
export declare const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
export declare function buildMentionRegexes(cfg: OpenClawConfig | undefined, agentId?: string): RegExp[];
export declare function normalizeMentionText(text: string): string;
export declare function matchesMentionPatterns(text: string, mentionRegexes: RegExp[]): boolean;
export declare function matchesMentionWithExplicit(params: {
    text: string;
    mentionRegexes: RegExp[];
    explicit?: ExplicitMentionSignal;
    transcript?: string;
}): boolean;
export declare function stripStructuralPrefixes(text: string): string;
export declare function stripMentions(text: string, ctx: MsgContext, cfg: OpenClawConfig | undefined, agentId?: string): string;

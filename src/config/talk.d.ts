import type { ResolvedTalkConfig, TalkConfig, TalkConfigResponse } from "./types.gateway.js";
import type { OpenClawConfig } from "./types.openclaw.js";
export declare function normalizeTalkSection(value: TalkConfig | undefined): TalkConfig | undefined;
export declare function normalizeTalkConfig(config: OpenClawConfig): OpenClawConfig;
export declare function resolveActiveTalkProviderConfig(talk: TalkConfig | undefined): ResolvedTalkConfig | undefined;
export declare function buildTalkConfigResponse(value: unknown): TalkConfigResponse | undefined;

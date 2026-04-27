import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import { type OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import { resolveProviderScopedAuthProfile, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
export { resolveProviderScopedAuthProfile, resolveRunAuthProfile };
import type { FollowupRun } from "./queue.js";
export declare function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig;
export declare function resolveQueuedReplyExecutionConfig(config: OpenClawConfig, params?: {
    originatingChannel?: string;
    messageProvider?: string;
    originatingAccountId?: string;
    agentAccountId?: string;
}): Promise<OpenClawConfig>;
/**
 * Build provider-specific threading context for tool auto-injection.
 */
export declare function buildThreadingToolContext(params: {
    sessionCtx: TemplateContext;
    config: OpenClawConfig | undefined;
    hasRepliedRef: {
        value: boolean;
    } | undefined;
}): ChannelThreadingToolContext;
export declare const isBunFetchSocketError: (message?: string) => boolean;
export declare const formatBunFetchSocketError: (message: string) => string;
export declare const resolveEnforceFinalTag: (run: FollowupRun["run"], provider: string, model?: string) => boolean;
export declare function resolveModelFallbackOptions(run: FollowupRun["run"]): {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
    agentDir: string;
    fallbacksOverride: string[] | undefined;
};
export declare function buildEmbeddedRunBaseParams(params: {
    run: FollowupRun["run"];
    provider: string;
    model: string;
    runId: string;
    authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
    allowTransientCooldownProbe?: boolean;
}): {
    thinkLevel: import("./directives.js").ThinkLevel | undefined;
    verboseLevel: import("./directives.js").VerboseLevel | undefined;
    reasoningLevel: import("./directives.js").ReasoningLevel | undefined;
    execOverrides: Pick<import("../../agents/bash-tools.exec-types.js").ExecToolDefaults, "node" | "ask" | "security" | "host"> | undefined;
    bashElevated: {
        enabled: boolean;
        allowed: boolean;
        defaultLevel: import("./directives.js").ElevatedLevel;
    } | undefined;
    timeoutMs: number;
    runId: string;
    allowTransientCooldownProbe: boolean | undefined;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    sessionFile: string;
    workspaceDir: string;
    agentDir: string;
    config: OpenClawConfig;
    skillsSnapshot: import("../../agents/skills.js").SkillSnapshot | undefined;
    ownerNumbers: string[] | undefined;
    inputProvenance: import("../../sessions/input-provenance.js").InputProvenance | undefined;
    senderIsOwner: boolean | undefined;
    enforceFinalTag: boolean;
    silentExpected: boolean | undefined;
    provider: string;
    model: string;
};
export declare function buildEmbeddedContextFromTemplate(params: {
    run: FollowupRun["run"];
    sessionCtx: TemplateContext;
    hasRepliedRef: {
        value: boolean;
    } | undefined;
}): {
    currentChannelId?: string;
    currentGraphChannelId?: string;
    currentChannelProvider?: ChannelId;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: {
        value: boolean;
    };
    skipCrossContextDecoration?: boolean;
    sessionId: string;
    sessionKey: string | undefined;
    sandboxSessionKey: string | undefined;
    agentId: string;
    messageProvider: string | undefined;
    agentAccountId: string | undefined;
    messageTo: string | undefined;
    messageThreadId: string | number | undefined;
    memberRoleIds: string[] | undefined;
};
export declare function buildTemplateSenderContext(sessionCtx: TemplateContext): {
    senderId: string | undefined;
    senderName: string | undefined;
    senderUsername: string | undefined;
    senderE164: string | undefined;
};
export declare function buildEmbeddedRunContexts(params: {
    run: FollowupRun["run"];
    sessionCtx: TemplateContext;
    hasRepliedRef: {
        value: boolean;
    } | undefined;
    provider: string;
}): {
    authProfile: {
        authProfileId?: string;
        authProfileIdSource?: "auto" | "user";
    };
    embeddedContext: {
        currentChannelId?: string;
        currentGraphChannelId?: string;
        currentChannelProvider?: ChannelId;
        currentThreadTs?: string;
        currentMessageId?: string | number;
        replyToMode?: "off" | "first" | "all" | "batched";
        hasRepliedRef?: {
            value: boolean;
        };
        skipCrossContextDecoration?: boolean;
        sessionId: string;
        sessionKey: string | undefined;
        sandboxSessionKey: string | undefined;
        agentId: string;
        messageProvider: string | undefined;
        agentAccountId: string | undefined;
        messageTo: string | undefined;
        messageThreadId: string | number | undefined;
        memberRoleIds: string[] | undefined;
    };
    senderContext: {
        senderId: string | undefined;
        senderName: string | undefined;
        senderUsername: string | undefined;
        senderE164: string | undefined;
    };
};
export declare function buildEmbeddedRunExecutionParams(params: {
    run: FollowupRun["run"];
    sessionCtx: TemplateContext;
    hasRepliedRef: {
        value: boolean;
    } | undefined;
    provider: string;
    model: string;
    runId: string;
    allowTransientCooldownProbe?: boolean;
}): {
    embeddedContext: {
        currentChannelId?: string;
        currentGraphChannelId?: string;
        currentChannelProvider?: ChannelId;
        currentThreadTs?: string;
        currentMessageId?: string | number;
        replyToMode?: "off" | "first" | "all" | "batched";
        hasRepliedRef?: {
            value: boolean;
        };
        skipCrossContextDecoration?: boolean;
        sessionId: string;
        sessionKey: string | undefined;
        sandboxSessionKey: string | undefined;
        agentId: string;
        messageProvider: string | undefined;
        agentAccountId: string | undefined;
        messageTo: string | undefined;
        messageThreadId: string | number | undefined;
        memberRoleIds: string[] | undefined;
    };
    senderContext: {
        senderId: string | undefined;
        senderName: string | undefined;
        senderUsername: string | undefined;
        senderE164: string | undefined;
    };
    runBaseParams: {
        thinkLevel: import("./directives.js").ThinkLevel | undefined;
        verboseLevel: import("./directives.js").VerboseLevel | undefined;
        reasoningLevel: import("./directives.js").ReasoningLevel | undefined;
        execOverrides: Pick<import("../../agents/bash-tools.exec-types.js").ExecToolDefaults, "node" | "ask" | "security" | "host"> | undefined;
        bashElevated: {
            enabled: boolean;
            allowed: boolean;
            defaultLevel: import("./directives.js").ElevatedLevel;
        } | undefined;
        timeoutMs: number;
        runId: string;
        allowTransientCooldownProbe: boolean | undefined;
        authProfileId?: string;
        authProfileIdSource?: "auto" | "user";
        sessionFile: string;
        workspaceDir: string;
        agentDir: string;
        config: OpenClawConfig;
        skillsSnapshot: import("../../agents/skills.js").SkillSnapshot | undefined;
        ownerNumbers: string[] | undefined;
        inputProvenance: import("../../sessions/input-provenance.js").InputProvenance | undefined;
        senderIsOwner: boolean | undefined;
        enforceFinalTag: boolean;
        silentExpected: boolean | undefined;
        provider: string;
        model: string;
    };
};

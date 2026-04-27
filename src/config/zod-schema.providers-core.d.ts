import { z } from "zod";
export declare const TelegramTopicSchema: z.ZodObject<{
    requireMention: z.ZodOptional<z.ZodBoolean>;
    ingest: z.ZodOptional<z.ZodBoolean>;
    disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
    groupPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
    errorPolicy: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
    }>>;
    errorCooldownMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const TelegramGroupSchema: z.ZodObject<{
    requireMention: z.ZodOptional<z.ZodBoolean>;
    ingest: z.ZodOptional<z.ZodBoolean>;
    disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
    groupPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodString>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    errorPolicy: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
    }>>;
    errorCooldownMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const TelegramDirectSchema: z.ZodObject<{
    dmPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodString>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    errorPolicy: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
    }>>;
    errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    requireTopic: z.ZodOptional<z.ZodBoolean>;
    autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const TelegramAccountSchemaBase: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        inlineButtons: z.ZodOptional<z.ZodEnum<{
            off: "off";
            group: "group";
            dm: "dm";
            all: "all";
            allowlist: "allowlist";
        }>>;
    }, z.core.$strict>]>>;
    execApprovals: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        target: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            dm: "dm";
            both: "both";
        }>>;
    }, z.core.$strict>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    commands: z.ZodOptional<z.ZodObject<{
        native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    customCommands: z.ZodOptional<z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        description: z.ZodString;
    }, z.core.$strict>>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    botToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    tokenFile: z.ZodOptional<z.ZodString>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
            }>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    direct: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        dmPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
            }>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        requireTopic: z.ZodOptional<z.ZodBoolean>;
        autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>]>>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    streaming: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            off: "off";
            partial: "partial";
            block: "block";
            progress: "progress";
        }>>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        preview: z.ZodOptional<z.ZodObject<{
            chunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            toolProgress: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        block: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            coalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
    pollingStallThresholdMs: z.ZodOptional<z.ZodNumber>;
    retry: z.ZodOptional<z.ZodObject<{
        attempts: z.ZodOptional<z.ZodNumber>;
        minDelayMs: z.ZodOptional<z.ZodNumber>;
        maxDelayMs: z.ZodOptional<z.ZodNumber>;
        jitter: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    network: z.ZodOptional<z.ZodObject<{
        autoSelectFamily: z.ZodOptional<z.ZodBoolean>;
        dnsResultOrder: z.ZodOptional<z.ZodEnum<{
            ipv4first: "ipv4first";
            verbatim: "verbatim";
        }>>;
        dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    proxy: z.ZodOptional<z.ZodString>;
    webhookUrl: z.ZodOptional<z.ZodString>;
    webhookSecret: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodOptional<z.ZodString>;
    webhookHost: z.ZodOptional<z.ZodString>;
    webhookPort: z.ZodOptional<z.ZodNumber>;
    webhookCertPath: z.ZodOptional<z.ZodString>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        sendMessage: z.ZodOptional<z.ZodBoolean>;
        poll: z.ZodOptional<z.ZodBoolean>;
        deleteMessage: z.ZodOptional<z.ZodBoolean>;
        editMessage: z.ZodOptional<z.ZodBoolean>;
        sticker: z.ZodOptional<z.ZodBoolean>;
        createForumTopic: z.ZodOptional<z.ZodBoolean>;
        editForumTopic: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    threadBindings: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleHours: z.ZodOptional<z.ZodNumber>;
        maxAgeHours: z.ZodOptional<z.ZodNumber>;
        spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
        spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        own: "own";
    }>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    linkPreview: z.ZodOptional<z.ZodBoolean>;
    silentErrorReplies: z.ZodOptional<z.ZodBoolean>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    ackReaction: z.ZodOptional<z.ZodString>;
    errorPolicy: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
    }>>;
    errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    apiRoot: z.ZodOptional<z.ZodString>;
    trustedLocalFileRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const TelegramAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        inlineButtons: z.ZodOptional<z.ZodEnum<{
            off: "off";
            group: "group";
            dm: "dm";
            all: "all";
            allowlist: "allowlist";
        }>>;
    }, z.core.$strict>]>>;
    execApprovals: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        target: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            dm: "dm";
            both: "both";
        }>>;
    }, z.core.$strict>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    commands: z.ZodOptional<z.ZodObject<{
        native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    customCommands: z.ZodOptional<z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        description: z.ZodString;
    }, z.core.$strict>>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    botToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    tokenFile: z.ZodOptional<z.ZodString>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
            }>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    direct: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        dmPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
            }>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        requireTopic: z.ZodOptional<z.ZodBoolean>;
        autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>]>>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    streaming: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            off: "off";
            partial: "partial";
            block: "block";
            progress: "progress";
        }>>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        preview: z.ZodOptional<z.ZodObject<{
            chunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            toolProgress: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        block: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            coalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
    pollingStallThresholdMs: z.ZodOptional<z.ZodNumber>;
    retry: z.ZodOptional<z.ZodObject<{
        attempts: z.ZodOptional<z.ZodNumber>;
        minDelayMs: z.ZodOptional<z.ZodNumber>;
        maxDelayMs: z.ZodOptional<z.ZodNumber>;
        jitter: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    network: z.ZodOptional<z.ZodObject<{
        autoSelectFamily: z.ZodOptional<z.ZodBoolean>;
        dnsResultOrder: z.ZodOptional<z.ZodEnum<{
            ipv4first: "ipv4first";
            verbatim: "verbatim";
        }>>;
        dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    proxy: z.ZodOptional<z.ZodString>;
    webhookUrl: z.ZodOptional<z.ZodString>;
    webhookSecret: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodOptional<z.ZodString>;
    webhookHost: z.ZodOptional<z.ZodString>;
    webhookPort: z.ZodOptional<z.ZodNumber>;
    webhookCertPath: z.ZodOptional<z.ZodString>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        sendMessage: z.ZodOptional<z.ZodBoolean>;
        poll: z.ZodOptional<z.ZodBoolean>;
        deleteMessage: z.ZodOptional<z.ZodBoolean>;
        editMessage: z.ZodOptional<z.ZodBoolean>;
        sticker: z.ZodOptional<z.ZodBoolean>;
        createForumTopic: z.ZodOptional<z.ZodBoolean>;
        editForumTopic: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    threadBindings: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleHours: z.ZodOptional<z.ZodNumber>;
        maxAgeHours: z.ZodOptional<z.ZodNumber>;
        spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
        spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        own: "own";
    }>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    linkPreview: z.ZodOptional<z.ZodBoolean>;
    silentErrorReplies: z.ZodOptional<z.ZodBoolean>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    ackReaction: z.ZodOptional<z.ZodString>;
    errorPolicy: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
    }>>;
    errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    apiRoot: z.ZodOptional<z.ZodString>;
    trustedLocalFileRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const TelegramConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        inlineButtons: z.ZodOptional<z.ZodEnum<{
            off: "off";
            group: "group";
            dm: "dm";
            all: "all";
            allowlist: "allowlist";
        }>>;
    }, z.core.$strict>]>>;
    execApprovals: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        target: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            dm: "dm";
            both: "both";
        }>>;
    }, z.core.$strict>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    commands: z.ZodOptional<z.ZodObject<{
        native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    customCommands: z.ZodOptional<z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        description: z.ZodString;
    }, z.core.$strict>>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    botToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    tokenFile: z.ZodOptional<z.ZodString>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
            }>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    direct: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        dmPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
            }>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        requireTopic: z.ZodOptional<z.ZodBoolean>;
        autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>]>>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    streaming: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            off: "off";
            partial: "partial";
            block: "block";
            progress: "progress";
        }>>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        preview: z.ZodOptional<z.ZodObject<{
            chunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            toolProgress: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        block: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            coalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
    pollingStallThresholdMs: z.ZodOptional<z.ZodNumber>;
    retry: z.ZodOptional<z.ZodObject<{
        attempts: z.ZodOptional<z.ZodNumber>;
        minDelayMs: z.ZodOptional<z.ZodNumber>;
        maxDelayMs: z.ZodOptional<z.ZodNumber>;
        jitter: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    network: z.ZodOptional<z.ZodObject<{
        autoSelectFamily: z.ZodOptional<z.ZodBoolean>;
        dnsResultOrder: z.ZodOptional<z.ZodEnum<{
            ipv4first: "ipv4first";
            verbatim: "verbatim";
        }>>;
        dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    proxy: z.ZodOptional<z.ZodString>;
    webhookUrl: z.ZodOptional<z.ZodString>;
    webhookSecret: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodOptional<z.ZodString>;
    webhookHost: z.ZodOptional<z.ZodString>;
    webhookPort: z.ZodOptional<z.ZodNumber>;
    webhookCertPath: z.ZodOptional<z.ZodString>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        sendMessage: z.ZodOptional<z.ZodBoolean>;
        poll: z.ZodOptional<z.ZodBoolean>;
        deleteMessage: z.ZodOptional<z.ZodBoolean>;
        editMessage: z.ZodOptional<z.ZodBoolean>;
        sticker: z.ZodOptional<z.ZodBoolean>;
        createForumTopic: z.ZodOptional<z.ZodBoolean>;
        editForumTopic: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    threadBindings: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleHours: z.ZodOptional<z.ZodNumber>;
        maxAgeHours: z.ZodOptional<z.ZodNumber>;
        spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
        spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        own: "own";
    }>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    linkPreview: z.ZodOptional<z.ZodBoolean>;
    silentErrorReplies: z.ZodOptional<z.ZodBoolean>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    ackReaction: z.ZodOptional<z.ZodString>;
    errorPolicy: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
    }>>;
    errorCooldownMs: z.ZodOptional<z.ZodNumber>;
    apiRoot: z.ZodOptional<z.ZodString>;
    trustedLocalFileRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>]>>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
            inlineButtons: z.ZodOptional<z.ZodEnum<{
                off: "off";
                group: "group";
                dm: "dm";
                all: "all";
                allowlist: "allowlist";
            }>>;
        }, z.core.$strict>]>>;
        execApprovals: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            target: z.ZodOptional<z.ZodEnum<{
                channel: "channel";
                dm: "dm";
                both: "both";
            }>>;
        }, z.core.$strict>>;
        markdown: z.ZodOptional<z.ZodObject<{
            tables: z.ZodOptional<z.ZodEnum<{
                off: "off";
                block: "block";
                bullets: "bullets";
                code: "code";
            }>>;
        }, z.core.$strict>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        commands: z.ZodOptional<z.ZodObject<{
            native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
            nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        }, z.core.$strict>>;
        customCommands: z.ZodOptional<z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            description: z.ZodString;
        }, z.core.$strict>>>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        botToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        tokenFile: z.ZodOptional<z.ZodString>;
        replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
            }>>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                ingest: z.ZodOptional<z.ZodBoolean>;
                disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
                groupPolicy: z.ZodOptional<z.ZodEnum<{
                    disabled: "disabled";
                    open: "open";
                    allowlist: "allowlist";
                }>>;
                skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                systemPrompt: z.ZodOptional<z.ZodString>;
                agentId: z.ZodOptional<z.ZodString>;
                errorPolicy: z.ZodOptional<z.ZodEnum<{
                    silent: "silent";
                    always: "always";
                    once: "once";
                }>>;
                errorCooldownMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        defaultTo: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>>;
        contextVisibility: z.ZodOptional<z.ZodEnum<{
            all: "all";
            allowlist: "allowlist";
            allowlist_quote: "allowlist_quote";
        }>>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        direct: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            dmPolicy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
                pairing: "pairing";
            }>>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                ingest: z.ZodOptional<z.ZodBoolean>;
                disableAudioPreflight: z.ZodOptional<z.ZodBoolean>;
                groupPolicy: z.ZodOptional<z.ZodEnum<{
                    disabled: "disabled";
                    open: "open";
                    allowlist: "allowlist";
                }>>;
                skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                systemPrompt: z.ZodOptional<z.ZodString>;
                agentId: z.ZodOptional<z.ZodString>;
                errorPolicy: z.ZodOptional<z.ZodEnum<{
                    silent: "silent";
                    always: "always";
                    once: "once";
                }>>;
                errorCooldownMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            errorPolicy: z.ZodOptional<z.ZodEnum<{
                silent: "silent";
                always: "always";
                once: "once";
            }>>;
            errorCooldownMs: z.ZodOptional<z.ZodNumber>;
            requireTopic: z.ZodOptional<z.ZodBoolean>;
            autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                prompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>]>>;
        }, z.core.$strict>>>>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        streaming: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
                progress: "progress";
            }>>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            preview: z.ZodOptional<z.ZodObject<{
                chunk: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
                }, z.core.$strict>>;
                toolProgress: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            block: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                coalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        pollingStallThresholdMs: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodOptional<z.ZodObject<{
            attempts: z.ZodOptional<z.ZodNumber>;
            minDelayMs: z.ZodOptional<z.ZodNumber>;
            maxDelayMs: z.ZodOptional<z.ZodNumber>;
            jitter: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        network: z.ZodOptional<z.ZodObject<{
            autoSelectFamily: z.ZodOptional<z.ZodBoolean>;
            dnsResultOrder: z.ZodOptional<z.ZodEnum<{
                ipv4first: "ipv4first";
                verbatim: "verbatim";
            }>>;
            dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        proxy: z.ZodOptional<z.ZodString>;
        webhookUrl: z.ZodOptional<z.ZodString>;
        webhookSecret: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        webhookPath: z.ZodOptional<z.ZodString>;
        webhookHost: z.ZodOptional<z.ZodString>;
        webhookPort: z.ZodOptional<z.ZodNumber>;
        webhookCertPath: z.ZodOptional<z.ZodString>;
        actions: z.ZodOptional<z.ZodObject<{
            reactions: z.ZodOptional<z.ZodBoolean>;
            sendMessage: z.ZodOptional<z.ZodBoolean>;
            poll: z.ZodOptional<z.ZodBoolean>;
            deleteMessage: z.ZodOptional<z.ZodBoolean>;
            editMessage: z.ZodOptional<z.ZodBoolean>;
            sticker: z.ZodOptional<z.ZodBoolean>;
            createForumTopic: z.ZodOptional<z.ZodBoolean>;
            editForumTopic: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        threadBindings: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            idleHours: z.ZodOptional<z.ZodNumber>;
            maxAgeHours: z.ZodOptional<z.ZodNumber>;
            spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
            spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        reactionNotifications: z.ZodOptional<z.ZodEnum<{
            off: "off";
            all: "all";
            own: "own";
        }>>;
        reactionLevel: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            extensive: "extensive";
            ack: "ack";
        }>>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        linkPreview: z.ZodOptional<z.ZodBoolean>;
        silentErrorReplies: z.ZodOptional<z.ZodBoolean>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        ackReaction: z.ZodOptional<z.ZodString>;
        errorPolicy: z.ZodOptional<z.ZodEnum<{
            silent: "silent";
            always: "always";
            once: "once";
        }>>;
        errorCooldownMs: z.ZodOptional<z.ZodNumber>;
        apiRoot: z.ZodOptional<z.ZodString>;
        trustedLocalFileRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        autoTopicLabel: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            prompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>]>>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const DiscordDmSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    policy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    groupEnabled: z.ZodOptional<z.ZodBoolean>;
    groupChannels: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
}, z.core.$strict>;
export declare const DiscordThreadSchema: z.ZodObject<{
    inheritParent: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const DiscordGuildChannelSchema: z.ZodObject<{
    requireMention: z.ZodOptional<z.ZodBoolean>;
    ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    includeThreadStarter: z.ZodOptional<z.ZodBoolean>;
    autoThread: z.ZodOptional<z.ZodBoolean>;
    autoThreadName: z.ZodOptional<z.ZodEnum<{
        message: "message";
        generated: "generated";
    }>>;
    autoArchiveDuration: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
        60: "60";
        1440: "1440";
        4320: "4320";
        10080: "10080";
    }>, z.ZodLiteral<60>, z.ZodLiteral<1440>, z.ZodLiteral<4320>, z.ZodLiteral<10080>]>>;
}, z.core.$strict>;
export declare const DiscordGuildSchema: z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        allowlist: "allowlist";
        own: "own";
    }>>;
    users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        includeThreadStarter: z.ZodOptional<z.ZodBoolean>;
        autoThread: z.ZodOptional<z.ZodBoolean>;
        autoThreadName: z.ZodOptional<z.ZodEnum<{
            message: "message";
            generated: "generated";
        }>>;
        autoArchiveDuration: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            60: "60";
            1440: "1440";
            4320: "4320";
            10080: "10080";
        }>, z.ZodLiteral<60>, z.ZodLiteral<1440>, z.ZodLiteral<4320>, z.ZodLiteral<10080>]>>;
    }, z.core.$strict>>>>;
}, z.core.$strict>;
export declare const DiscordAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    commands: z.ZodOptional<z.ZodObject<{
        native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    token: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    proxy: z.ZodOptional<z.ZodString>;
    allowBots: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"mentions">]>>;
    dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    streaming: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            off: "off";
            partial: "partial";
            block: "block";
            progress: "progress";
        }>>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        preview: z.ZodOptional<z.ZodObject<{
            chunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            toolProgress: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        block: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            coalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    maxLinesPerMessage: z.ZodOptional<z.ZodNumber>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    retry: z.ZodOptional<z.ZodObject<{
        attempts: z.ZodOptional<z.ZodNumber>;
        minDelayMs: z.ZodOptional<z.ZodNumber>;
        maxDelayMs: z.ZodOptional<z.ZodNumber>;
        jitter: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        stickers: z.ZodOptional<z.ZodBoolean>;
        emojiUploads: z.ZodOptional<z.ZodBoolean>;
        stickerUploads: z.ZodOptional<z.ZodBoolean>;
        polls: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodBoolean>;
        messages: z.ZodOptional<z.ZodBoolean>;
        threads: z.ZodOptional<z.ZodBoolean>;
        pins: z.ZodOptional<z.ZodBoolean>;
        search: z.ZodOptional<z.ZodBoolean>;
        memberInfo: z.ZodOptional<z.ZodBoolean>;
        roleInfo: z.ZodOptional<z.ZodBoolean>;
        roles: z.ZodOptional<z.ZodBoolean>;
        channelInfo: z.ZodOptional<z.ZodBoolean>;
        voiceStatus: z.ZodOptional<z.ZodBoolean>;
        events: z.ZodOptional<z.ZodBoolean>;
        moderation: z.ZodOptional<z.ZodBoolean>;
        channels: z.ZodOptional<z.ZodBoolean>;
        presence: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    thread: z.ZodOptional<z.ZodObject<{
        inheritParent: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    dmPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    dm: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        policy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        groupEnabled: z.ZodOptional<z.ZodBoolean>;
        groupChannels: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    }, z.core.$strict>>;
    guilds: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        slug: z.ZodOptional<z.ZodString>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        reactionNotifications: z.ZodOptional<z.ZodEnum<{
            off: "off";
            all: "all";
            allowlist: "allowlist";
            own: "own";
        }>>;
        users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            includeThreadStarter: z.ZodOptional<z.ZodBoolean>;
            autoThread: z.ZodOptional<z.ZodBoolean>;
            autoThreadName: z.ZodOptional<z.ZodEnum<{
                message: "message";
                generated: "generated";
            }>>;
            autoArchiveDuration: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                60: "60";
                1440: "1440";
                4320: "4320";
                10080: "10080";
            }>, z.ZodLiteral<60>, z.ZodLiteral<1440>, z.ZodLiteral<4320>, z.ZodLiteral<10080>]>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    execApprovals: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        approvers: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        cleanupAfterResolve: z.ZodOptional<z.ZodBoolean>;
        target: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            dm: "dm";
            both: "both";
        }>>;
    }, z.core.$strict>>;
    agentComponents: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    ui: z.ZodOptional<z.ZodObject<{
        components: z.ZodOptional<z.ZodObject<{
            accentColor: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    slashCommand: z.ZodOptional<z.ZodObject<{
        ephemeral: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    threadBindings: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleHours: z.ZodOptional<z.ZodNumber>;
        maxAgeHours: z.ZodOptional<z.ZodNumber>;
        spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
        spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    intents: z.ZodOptional<z.ZodObject<{
        presence: z.ZodOptional<z.ZodBoolean>;
        guildMembers: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    voice: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        model: z.ZodOptional<z.ZodString>;
        autoJoin: z.ZodOptional<z.ZodArray<z.ZodObject<{
            guildId: z.ZodString;
            channelId: z.ZodString;
        }, z.core.$strict>>>;
        daveEncryption: z.ZodOptional<z.ZodBoolean>;
        decryptionFailureTolerance: z.ZodOptional<z.ZodNumber>;
        tts: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            auto: z.ZodOptional<z.ZodEnum<{
                off: "off";
                always: "always";
                inbound: "inbound";
                tagged: "tagged";
            }>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodEnum<{
                all: "all";
                final: "final";
            }>>;
            provider: z.ZodOptional<z.ZodString>;
            summaryModel: z.ZodOptional<z.ZodString>;
            modelOverrides: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                allowText: z.ZodOptional<z.ZodBoolean>;
                allowProvider: z.ZodOptional<z.ZodBoolean>;
                allowVoice: z.ZodOptional<z.ZodBoolean>;
                allowModelId: z.ZodOptional<z.ZodBoolean>;
                allowVoiceSettings: z.ZodOptional<z.ZodBoolean>;
                allowNormalization: z.ZodOptional<z.ZodBoolean>;
                allowSeed: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                apiKey: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                    source: z.ZodLiteral<"env">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"file">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"exec">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>], "source">]>>;
            }, z.core.$catchall<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull, z.ZodArray<z.ZodUnknown>, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>>>>;
            prefsPath: z.ZodOptional<z.ZodString>;
            maxTextLength: z.ZodOptional<z.ZodNumber>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    pluralkit: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        token: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    ackReaction: z.ZodOptional<z.ZodString>;
    ackReactionScope: z.ZodOptional<z.ZodEnum<{
        off: "off";
        direct: "direct";
        none: "none";
        all: "all";
        "group-mentions": "group-mentions";
        "group-all": "group-all";
    }>>;
    activity: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        idle: "idle";
        online: "online";
        dnd: "dnd";
        invisible: "invisible";
    }>>;
    autoPresence: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        intervalMs: z.ZodOptional<z.ZodNumber>;
        minUpdateIntervalMs: z.ZodOptional<z.ZodNumber>;
        healthyText: z.ZodOptional<z.ZodString>;
        degradedText: z.ZodOptional<z.ZodString>;
        exhaustedText: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    activityType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>, z.ZodLiteral<4>, z.ZodLiteral<5>]>>;
    activityUrl: z.ZodOptional<z.ZodString>;
    inboundWorker: z.ZodOptional<z.ZodObject<{
        runTimeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    eventQueue: z.ZodOptional<z.ZodObject<{
        listenerTimeout: z.ZodOptional<z.ZodNumber>;
        maxQueueSize: z.ZodOptional<z.ZodNumber>;
        maxConcurrency: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const DiscordConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    commands: z.ZodOptional<z.ZodObject<{
        native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    token: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    proxy: z.ZodOptional<z.ZodString>;
    allowBots: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"mentions">]>>;
    dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    streaming: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            off: "off";
            partial: "partial";
            block: "block";
            progress: "progress";
        }>>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        preview: z.ZodOptional<z.ZodObject<{
            chunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            toolProgress: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        block: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            coalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    maxLinesPerMessage: z.ZodOptional<z.ZodNumber>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    retry: z.ZodOptional<z.ZodObject<{
        attempts: z.ZodOptional<z.ZodNumber>;
        minDelayMs: z.ZodOptional<z.ZodNumber>;
        maxDelayMs: z.ZodOptional<z.ZodNumber>;
        jitter: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        stickers: z.ZodOptional<z.ZodBoolean>;
        emojiUploads: z.ZodOptional<z.ZodBoolean>;
        stickerUploads: z.ZodOptional<z.ZodBoolean>;
        polls: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodBoolean>;
        messages: z.ZodOptional<z.ZodBoolean>;
        threads: z.ZodOptional<z.ZodBoolean>;
        pins: z.ZodOptional<z.ZodBoolean>;
        search: z.ZodOptional<z.ZodBoolean>;
        memberInfo: z.ZodOptional<z.ZodBoolean>;
        roleInfo: z.ZodOptional<z.ZodBoolean>;
        roles: z.ZodOptional<z.ZodBoolean>;
        channelInfo: z.ZodOptional<z.ZodBoolean>;
        voiceStatus: z.ZodOptional<z.ZodBoolean>;
        events: z.ZodOptional<z.ZodBoolean>;
        moderation: z.ZodOptional<z.ZodBoolean>;
        channels: z.ZodOptional<z.ZodBoolean>;
        presence: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    thread: z.ZodOptional<z.ZodObject<{
        inheritParent: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    dmPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    dm: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        policy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        groupEnabled: z.ZodOptional<z.ZodBoolean>;
        groupChannels: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
    }, z.core.$strict>>;
    guilds: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        slug: z.ZodOptional<z.ZodString>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        reactionNotifications: z.ZodOptional<z.ZodEnum<{
            off: "off";
            all: "all";
            allowlist: "allowlist";
            own: "own";
        }>>;
        users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            includeThreadStarter: z.ZodOptional<z.ZodBoolean>;
            autoThread: z.ZodOptional<z.ZodBoolean>;
            autoThreadName: z.ZodOptional<z.ZodEnum<{
                message: "message";
                generated: "generated";
            }>>;
            autoArchiveDuration: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                60: "60";
                1440: "1440";
                4320: "4320";
                10080: "10080";
            }>, z.ZodLiteral<60>, z.ZodLiteral<1440>, z.ZodLiteral<4320>, z.ZodLiteral<10080>]>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    execApprovals: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        approvers: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        cleanupAfterResolve: z.ZodOptional<z.ZodBoolean>;
        target: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            dm: "dm";
            both: "both";
        }>>;
    }, z.core.$strict>>;
    agentComponents: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    ui: z.ZodOptional<z.ZodObject<{
        components: z.ZodOptional<z.ZodObject<{
            accentColor: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    slashCommand: z.ZodOptional<z.ZodObject<{
        ephemeral: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    threadBindings: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleHours: z.ZodOptional<z.ZodNumber>;
        maxAgeHours: z.ZodOptional<z.ZodNumber>;
        spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
        spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    intents: z.ZodOptional<z.ZodObject<{
        presence: z.ZodOptional<z.ZodBoolean>;
        guildMembers: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    voice: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        model: z.ZodOptional<z.ZodString>;
        autoJoin: z.ZodOptional<z.ZodArray<z.ZodObject<{
            guildId: z.ZodString;
            channelId: z.ZodString;
        }, z.core.$strict>>>;
        daveEncryption: z.ZodOptional<z.ZodBoolean>;
        decryptionFailureTolerance: z.ZodOptional<z.ZodNumber>;
        tts: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            auto: z.ZodOptional<z.ZodEnum<{
                off: "off";
                always: "always";
                inbound: "inbound";
                tagged: "tagged";
            }>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodEnum<{
                all: "all";
                final: "final";
            }>>;
            provider: z.ZodOptional<z.ZodString>;
            summaryModel: z.ZodOptional<z.ZodString>;
            modelOverrides: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                allowText: z.ZodOptional<z.ZodBoolean>;
                allowProvider: z.ZodOptional<z.ZodBoolean>;
                allowVoice: z.ZodOptional<z.ZodBoolean>;
                allowModelId: z.ZodOptional<z.ZodBoolean>;
                allowVoiceSettings: z.ZodOptional<z.ZodBoolean>;
                allowNormalization: z.ZodOptional<z.ZodBoolean>;
                allowSeed: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                apiKey: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                    source: z.ZodLiteral<"env">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"file">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"exec">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>], "source">]>>;
            }, z.core.$catchall<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull, z.ZodArray<z.ZodUnknown>, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>>>>;
            prefsPath: z.ZodOptional<z.ZodString>;
            maxTextLength: z.ZodOptional<z.ZodNumber>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    pluralkit: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        token: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    ackReaction: z.ZodOptional<z.ZodString>;
    ackReactionScope: z.ZodOptional<z.ZodEnum<{
        off: "off";
        direct: "direct";
        none: "none";
        all: "all";
        "group-mentions": "group-mentions";
        "group-all": "group-all";
    }>>;
    activity: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        idle: "idle";
        online: "online";
        dnd: "dnd";
        invisible: "invisible";
    }>>;
    autoPresence: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        intervalMs: z.ZodOptional<z.ZodNumber>;
        minUpdateIntervalMs: z.ZodOptional<z.ZodNumber>;
        healthyText: z.ZodOptional<z.ZodString>;
        degradedText: z.ZodOptional<z.ZodString>;
        exhaustedText: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    activityType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>, z.ZodLiteral<4>, z.ZodLiteral<5>]>>;
    activityUrl: z.ZodOptional<z.ZodString>;
    inboundWorker: z.ZodOptional<z.ZodObject<{
        runTimeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    eventQueue: z.ZodOptional<z.ZodObject<{
        listenerTimeout: z.ZodOptional<z.ZodNumber>;
        maxQueueSize: z.ZodOptional<z.ZodNumber>;
        maxConcurrency: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        markdown: z.ZodOptional<z.ZodObject<{
            tables: z.ZodOptional<z.ZodEnum<{
                off: "off";
                block: "block";
                bullets: "bullets";
                code: "code";
            }>>;
        }, z.core.$strict>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        commands: z.ZodOptional<z.ZodObject<{
            native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
            nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        }, z.core.$strict>>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        token: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        proxy: z.ZodOptional<z.ZodString>;
        allowBots: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"mentions">]>>;
        dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>>;
        contextVisibility: z.ZodOptional<z.ZodEnum<{
            all: "all";
            allowlist: "allowlist";
            allowlist_quote: "allowlist_quote";
        }>>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        streaming: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
                progress: "progress";
            }>>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            preview: z.ZodOptional<z.ZodObject<{
                chunk: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
                }, z.core.$strict>>;
                toolProgress: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            block: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                coalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        maxLinesPerMessage: z.ZodOptional<z.ZodNumber>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodOptional<z.ZodObject<{
            attempts: z.ZodOptional<z.ZodNumber>;
            minDelayMs: z.ZodOptional<z.ZodNumber>;
            maxDelayMs: z.ZodOptional<z.ZodNumber>;
            jitter: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        actions: z.ZodOptional<z.ZodObject<{
            reactions: z.ZodOptional<z.ZodBoolean>;
            stickers: z.ZodOptional<z.ZodBoolean>;
            emojiUploads: z.ZodOptional<z.ZodBoolean>;
            stickerUploads: z.ZodOptional<z.ZodBoolean>;
            polls: z.ZodOptional<z.ZodBoolean>;
            permissions: z.ZodOptional<z.ZodBoolean>;
            messages: z.ZodOptional<z.ZodBoolean>;
            threads: z.ZodOptional<z.ZodBoolean>;
            pins: z.ZodOptional<z.ZodBoolean>;
            search: z.ZodOptional<z.ZodBoolean>;
            memberInfo: z.ZodOptional<z.ZodBoolean>;
            roleInfo: z.ZodOptional<z.ZodBoolean>;
            roles: z.ZodOptional<z.ZodBoolean>;
            channelInfo: z.ZodOptional<z.ZodBoolean>;
            voiceStatus: z.ZodOptional<z.ZodBoolean>;
            events: z.ZodOptional<z.ZodBoolean>;
            moderation: z.ZodOptional<z.ZodBoolean>;
            channels: z.ZodOptional<z.ZodBoolean>;
            presence: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        thread: z.ZodOptional<z.ZodObject<{
            inheritParent: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        dmPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        defaultTo: z.ZodOptional<z.ZodString>;
        dm: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            policy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
                pairing: "pairing";
            }>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            groupEnabled: z.ZodOptional<z.ZodBoolean>;
            groupChannels: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
        }, z.core.$strict>>;
        guilds: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            slug: z.ZodOptional<z.ZodString>;
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            reactionNotifications: z.ZodOptional<z.ZodEnum<{
                off: "off";
                all: "all";
                allowlist: "allowlist";
                own: "own";
            }>>;
            users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                ignoreOtherMentions: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
                skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                users: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
                roles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
                systemPrompt: z.ZodOptional<z.ZodString>;
                includeThreadStarter: z.ZodOptional<z.ZodBoolean>;
                autoThread: z.ZodOptional<z.ZodBoolean>;
                autoThreadName: z.ZodOptional<z.ZodEnum<{
                    message: "message";
                    generated: "generated";
                }>>;
                autoArchiveDuration: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                    60: "60";
                    1440: "1440";
                    4320: "4320";
                    10080: "10080";
                }>, z.ZodLiteral<60>, z.ZodLiteral<1440>, z.ZodLiteral<4320>, z.ZodLiteral<10080>]>>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>>>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        execApprovals: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            approvers: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>, z.ZodTransform<string, string | number>>, z.ZodString>>>;
            agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            cleanupAfterResolve: z.ZodOptional<z.ZodBoolean>;
            target: z.ZodOptional<z.ZodEnum<{
                channel: "channel";
                dm: "dm";
                both: "both";
            }>>;
        }, z.core.$strict>>;
        agentComponents: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        ui: z.ZodOptional<z.ZodObject<{
            components: z.ZodOptional<z.ZodObject<{
                accentColor: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        slashCommand: z.ZodOptional<z.ZodObject<{
            ephemeral: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        threadBindings: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            idleHours: z.ZodOptional<z.ZodNumber>;
            maxAgeHours: z.ZodOptional<z.ZodNumber>;
            spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
            spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        intents: z.ZodOptional<z.ZodObject<{
            presence: z.ZodOptional<z.ZodBoolean>;
            guildMembers: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        voice: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            model: z.ZodOptional<z.ZodString>;
            autoJoin: z.ZodOptional<z.ZodArray<z.ZodObject<{
                guildId: z.ZodString;
                channelId: z.ZodString;
            }, z.core.$strict>>>;
            daveEncryption: z.ZodOptional<z.ZodBoolean>;
            decryptionFailureTolerance: z.ZodOptional<z.ZodNumber>;
            tts: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                auto: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    always: "always";
                    inbound: "inbound";
                    tagged: "tagged";
                }>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                mode: z.ZodOptional<z.ZodEnum<{
                    all: "all";
                    final: "final";
                }>>;
                provider: z.ZodOptional<z.ZodString>;
                summaryModel: z.ZodOptional<z.ZodString>;
                modelOverrides: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allowText: z.ZodOptional<z.ZodBoolean>;
                    allowProvider: z.ZodOptional<z.ZodBoolean>;
                    allowVoice: z.ZodOptional<z.ZodBoolean>;
                    allowModelId: z.ZodOptional<z.ZodBoolean>;
                    allowVoiceSettings: z.ZodOptional<z.ZodBoolean>;
                    allowNormalization: z.ZodOptional<z.ZodBoolean>;
                    allowSeed: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                    apiKey: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                        source: z.ZodLiteral<"env">;
                        provider: z.ZodString;
                        id: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        source: z.ZodLiteral<"file">;
                        provider: z.ZodString;
                        id: z.ZodString;
                    }, z.core.$strict>, z.ZodObject<{
                        source: z.ZodLiteral<"exec">;
                        provider: z.ZodString;
                        id: z.ZodString;
                    }, z.core.$strict>], "source">]>>;
                }, z.core.$catchall<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull, z.ZodArray<z.ZodUnknown>, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>>>>;
                prefsPath: z.ZodOptional<z.ZodString>;
                maxTextLength: z.ZodOptional<z.ZodNumber>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        pluralkit: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            token: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                source: z.ZodLiteral<"env">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"file">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"exec">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>], "source">]>>;
        }, z.core.$strict>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        ackReaction: z.ZodOptional<z.ZodString>;
        ackReactionScope: z.ZodOptional<z.ZodEnum<{
            off: "off";
            direct: "direct";
            none: "none";
            all: "all";
            "group-mentions": "group-mentions";
            "group-all": "group-all";
        }>>;
        activity: z.ZodOptional<z.ZodString>;
        status: z.ZodOptional<z.ZodEnum<{
            idle: "idle";
            online: "online";
            dnd: "dnd";
            invisible: "invisible";
        }>>;
        autoPresence: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            intervalMs: z.ZodOptional<z.ZodNumber>;
            minUpdateIntervalMs: z.ZodOptional<z.ZodNumber>;
            healthyText: z.ZodOptional<z.ZodString>;
            degradedText: z.ZodOptional<z.ZodString>;
            exhaustedText: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        activityType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>, z.ZodLiteral<4>, z.ZodLiteral<5>]>>;
        activityUrl: z.ZodOptional<z.ZodString>;
        inboundWorker: z.ZodOptional<z.ZodObject<{
            runTimeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        eventQueue: z.ZodOptional<z.ZodObject<{
            listenerTimeout: z.ZodOptional<z.ZodNumber>;
            maxQueueSize: z.ZodOptional<z.ZodNumber>;
            maxConcurrency: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const GoogleChatDmSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    policy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
}, z.core.$strict>;
export declare const GoogleChatGroupSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const GoogleChatAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    allowBots: z.ZodOptional<z.ZodBoolean>;
    dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    serviceAccount: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    serviceAccountRef: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">>;
    serviceAccountFile: z.ZodOptional<z.ZodString>;
    audienceType: z.ZodOptional<z.ZodEnum<{
        "app-url": "app-url";
        "project-number": "project-number";
    }>>;
    audience: z.ZodOptional<z.ZodString>;
    appPrincipal: z.ZodOptional<z.ZodString>;
    webhookPath: z.ZodOptional<z.ZodString>;
    webhookUrl: z.ZodOptional<z.ZodString>;
    botUser: z.ZodOptional<z.ZodString>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    dm: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        policy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    typingIndicator: z.ZodOptional<z.ZodEnum<{
        none: "none";
        message: "message";
        reaction: "reaction";
    }>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const GoogleChatConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    allowBots: z.ZodOptional<z.ZodBoolean>;
    dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    serviceAccount: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    serviceAccountRef: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">>;
    serviceAccountFile: z.ZodOptional<z.ZodString>;
    audienceType: z.ZodOptional<z.ZodEnum<{
        "app-url": "app-url";
        "project-number": "project-number";
    }>>;
    audience: z.ZodOptional<z.ZodString>;
    appPrincipal: z.ZodOptional<z.ZodString>;
    webhookPath: z.ZodOptional<z.ZodString>;
    webhookUrl: z.ZodOptional<z.ZodString>;
    botUser: z.ZodOptional<z.ZodString>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    dm: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        policy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    typingIndicator: z.ZodOptional<z.ZodEnum<{
        none: "none";
        message: "message";
        reaction: "reaction";
    }>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        allowBots: z.ZodOptional<z.ZodBoolean>;
        dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            requireMention: z.ZodOptional<z.ZodBoolean>;
            users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>>;
        defaultTo: z.ZodOptional<z.ZodString>;
        serviceAccount: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        serviceAccountRef: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">>;
        serviceAccountFile: z.ZodOptional<z.ZodString>;
        audienceType: z.ZodOptional<z.ZodEnum<{
            "app-url": "app-url";
            "project-number": "project-number";
        }>>;
        audience: z.ZodOptional<z.ZodString>;
        appPrincipal: z.ZodOptional<z.ZodString>;
        webhookPath: z.ZodOptional<z.ZodString>;
        webhookUrl: z.ZodOptional<z.ZodString>;
        botUser: z.ZodOptional<z.ZodString>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        blockStreaming: z.ZodOptional<z.ZodBoolean>;
        blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
            minChars: z.ZodOptional<z.ZodNumber>;
            maxChars: z.ZodOptional<z.ZodNumber>;
            idleMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        actions: z.ZodOptional<z.ZodObject<{
            reactions: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        dm: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            policy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
                pairing: "pairing";
            }>>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        typingIndicator: z.ZodOptional<z.ZodEnum<{
            none: "none";
            message: "message";
            reaction: "reaction";
        }>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const SlackDmSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    policy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupEnabled: z.ZodOptional<z.ZodBoolean>;
    groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
}, z.core.$strict>;
export declare const SlackChannelSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    allowBots: z.ZodOptional<z.ZodBoolean>;
    users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const SlackThreadSchema: z.ZodObject<{
    historyScope: z.ZodOptional<z.ZodEnum<{
        channel: "channel";
        thread: "thread";
    }>>;
    inheritParent: z.ZodOptional<z.ZodBoolean>;
    initialHistoryLimit: z.ZodOptional<z.ZodNumber>;
    requireExplicitMention: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const SlackAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<{
        socket: "socket";
        http: "http";
    }>>;
    signingSecret: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        interactiveReplies: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>]>>;
    execApprovals: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        target: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            dm: "dm";
            both: "both";
        }>>;
    }, z.core.$strict>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    commands: z.ZodOptional<z.ZodObject<{
        native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    botToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    appToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    userToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    userTokenReadOnly: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    allowBots: z.ZodOptional<z.ZodBoolean>;
    dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    groupPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    streaming: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            off: "off";
            partial: "partial";
            block: "block";
            progress: "progress";
        }>>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        preview: z.ZodOptional<z.ZodObject<{
            chunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            toolProgress: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        block: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            coalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        nativeTransport: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        allowlist: "allowlist";
        own: "own";
    }>>;
    reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    replyToModeByChatType: z.ZodOptional<z.ZodObject<{
        direct: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    }, z.core.$strict>>;
    thread: z.ZodOptional<z.ZodObject<{
        historyScope: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            thread: "thread";
        }>>;
        inheritParent: z.ZodOptional<z.ZodBoolean>;
        initialHistoryLimit: z.ZodOptional<z.ZodNumber>;
        requireExplicitMention: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        messages: z.ZodOptional<z.ZodBoolean>;
        pins: z.ZodOptional<z.ZodBoolean>;
        search: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodBoolean>;
        memberInfo: z.ZodOptional<z.ZodBoolean>;
        channelInfo: z.ZodOptional<z.ZodBoolean>;
        emojiList: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    slashCommand: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        name: z.ZodOptional<z.ZodString>;
        sessionPrefix: z.ZodOptional<z.ZodString>;
        ephemeral: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    dmPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    dm: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        policy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupEnabled: z.ZodOptional<z.ZodBoolean>;
        groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    }, z.core.$strict>>;
    channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        allowBots: z.ZodOptional<z.ZodBoolean>;
        users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    ackReaction: z.ZodOptional<z.ZodString>;
    typingReaction: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const SlackConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        interactiveReplies: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>]>>;
    execApprovals: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
        target: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            dm: "dm";
            both: "both";
        }>>;
    }, z.core.$strict>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    commands: z.ZodOptional<z.ZodObject<{
        native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    botToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    appToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    userToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    userTokenReadOnly: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    allowBots: z.ZodOptional<z.ZodBoolean>;
    dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    streaming: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            off: "off";
            partial: "partial";
            block: "block";
            progress: "progress";
        }>>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        preview: z.ZodOptional<z.ZodObject<{
            chunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            toolProgress: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        block: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            coalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        nativeTransport: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        allowlist: "allowlist";
        own: "own";
    }>>;
    reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    replyToModeByChatType: z.ZodOptional<z.ZodObject<{
        direct: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    }, z.core.$strict>>;
    thread: z.ZodOptional<z.ZodObject<{
        historyScope: z.ZodOptional<z.ZodEnum<{
            channel: "channel";
            thread: "thread";
        }>>;
        inheritParent: z.ZodOptional<z.ZodBoolean>;
        initialHistoryLimit: z.ZodOptional<z.ZodNumber>;
        requireExplicitMention: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        messages: z.ZodOptional<z.ZodBoolean>;
        pins: z.ZodOptional<z.ZodBoolean>;
        search: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodBoolean>;
        memberInfo: z.ZodOptional<z.ZodBoolean>;
        channelInfo: z.ZodOptional<z.ZodBoolean>;
        emojiList: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    slashCommand: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        name: z.ZodOptional<z.ZodString>;
        sessionPrefix: z.ZodOptional<z.ZodString>;
        ephemeral: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    dmPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    dm: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        policy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupEnabled: z.ZodOptional<z.ZodBoolean>;
        groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    }, z.core.$strict>>;
    channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        allowBots: z.ZodOptional<z.ZodBoolean>;
        users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    ackReaction: z.ZodOptional<z.ZodString>;
    typingReaction: z.ZodOptional<z.ZodString>;
    mode: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        socket: "socket";
        http: "http";
    }>>>;
    signingSecret: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        mode: z.ZodOptional<z.ZodEnum<{
            socket: "socket";
            http: "http";
        }>>;
        signingSecret: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        webhookPath: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
            interactiveReplies: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>]>>;
        execApprovals: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            target: z.ZodOptional<z.ZodEnum<{
                channel: "channel";
                dm: "dm";
                both: "both";
            }>>;
        }, z.core.$strict>>;
        markdown: z.ZodOptional<z.ZodObject<{
            tables: z.ZodOptional<z.ZodEnum<{
                off: "off";
                block: "block";
                bullets: "bullets";
                code: "code";
            }>>;
        }, z.core.$strict>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        commands: z.ZodOptional<z.ZodObject<{
            native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
            nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
        }, z.core.$strict>>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        botToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        appToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        userToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        userTokenReadOnly: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        allowBots: z.ZodOptional<z.ZodBoolean>;
        dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        groupPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>;
        contextVisibility: z.ZodOptional<z.ZodEnum<{
            all: "all";
            allowlist: "allowlist";
            allowlist_quote: "allowlist_quote";
        }>>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        streaming: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
                progress: "progress";
            }>>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            preview: z.ZodOptional<z.ZodObject<{
                chunk: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
                }, z.core.$strict>>;
                toolProgress: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            block: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                coalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            nativeTransport: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        reactionNotifications: z.ZodOptional<z.ZodEnum<{
            off: "off";
            all: "all";
            allowlist: "allowlist";
            own: "own";
        }>>;
        reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        replyToModeByChatType: z.ZodOptional<z.ZodObject<{
            direct: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
            group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
            channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        }, z.core.$strict>>;
        thread: z.ZodOptional<z.ZodObject<{
            historyScope: z.ZodOptional<z.ZodEnum<{
                channel: "channel";
                thread: "thread";
            }>>;
            inheritParent: z.ZodOptional<z.ZodBoolean>;
            initialHistoryLimit: z.ZodOptional<z.ZodNumber>;
            requireExplicitMention: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        actions: z.ZodOptional<z.ZodObject<{
            reactions: z.ZodOptional<z.ZodBoolean>;
            messages: z.ZodOptional<z.ZodBoolean>;
            pins: z.ZodOptional<z.ZodBoolean>;
            search: z.ZodOptional<z.ZodBoolean>;
            permissions: z.ZodOptional<z.ZodBoolean>;
            memberInfo: z.ZodOptional<z.ZodBoolean>;
            channelInfo: z.ZodOptional<z.ZodBoolean>;
            emojiList: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        slashCommand: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            name: z.ZodOptional<z.ZodString>;
            sessionPrefix: z.ZodOptional<z.ZodString>;
            ephemeral: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        dmPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        defaultTo: z.ZodOptional<z.ZodString>;
        dm: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            policy: z.ZodOptional<z.ZodEnum<{
                disabled: "disabled";
                open: "open";
                allowlist: "allowlist";
                pairing: "pairing";
            }>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groupEnabled: z.ZodOptional<z.ZodBoolean>;
            groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        }, z.core.$strict>>;
        channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            requireMention: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            allowBots: z.ZodOptional<z.ZodBoolean>;
            users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        ackReaction: z.ZodOptional<z.ZodString>;
        typingReaction: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const SignalAccountSchemaBase: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    account: z.ZodOptional<z.ZodString>;
    accountUuid: z.ZodOptional<z.ZodString>;
    httpUrl: z.ZodOptional<z.ZodString>;
    httpHost: z.ZodOptional<z.ZodString>;
    httpPort: z.ZodOptional<z.ZodNumber>;
    cliPath: z.ZodOptional<z.ZodString>;
    autoStart: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    receiveMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on-start">, z.ZodLiteral<"manual">]>>;
    ignoreAttachments: z.ZodOptional<z.ZodBoolean>;
    ignoreStories: z.ZodOptional<z.ZodBoolean>;
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        allowlist: "allowlist";
        own: "own";
    }>>;
    reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const SignalAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    account: z.ZodOptional<z.ZodString>;
    accountUuid: z.ZodOptional<z.ZodString>;
    httpUrl: z.ZodOptional<z.ZodString>;
    httpHost: z.ZodOptional<z.ZodString>;
    httpPort: z.ZodOptional<z.ZodNumber>;
    cliPath: z.ZodOptional<z.ZodString>;
    autoStart: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    receiveMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on-start">, z.ZodLiteral<"manual">]>>;
    ignoreAttachments: z.ZodOptional<z.ZodBoolean>;
    ignoreStories: z.ZodOptional<z.ZodBoolean>;
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        allowlist: "allowlist";
        own: "own";
    }>>;
    reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const SignalConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    account: z.ZodOptional<z.ZodString>;
    accountUuid: z.ZodOptional<z.ZodString>;
    httpUrl: z.ZodOptional<z.ZodString>;
    httpHost: z.ZodOptional<z.ZodString>;
    httpPort: z.ZodOptional<z.ZodNumber>;
    cliPath: z.ZodOptional<z.ZodString>;
    autoStart: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    receiveMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on-start">, z.ZodLiteral<"manual">]>>;
    ignoreAttachments: z.ZodOptional<z.ZodBoolean>;
    ignoreStories: z.ZodOptional<z.ZodBoolean>;
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        ingest: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    reactionNotifications: z.ZodOptional<z.ZodEnum<{
        off: "off";
        all: "all";
        allowlist: "allowlist";
        own: "own";
    }>>;
    reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        markdown: z.ZodOptional<z.ZodObject<{
            tables: z.ZodOptional<z.ZodEnum<{
                off: "off";
                block: "block";
                bullets: "bullets";
                code: "code";
            }>>;
        }, z.core.$strict>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        account: z.ZodOptional<z.ZodString>;
        accountUuid: z.ZodOptional<z.ZodString>;
        httpUrl: z.ZodOptional<z.ZodString>;
        httpHost: z.ZodOptional<z.ZodString>;
        httpPort: z.ZodOptional<z.ZodNumber>;
        cliPath: z.ZodOptional<z.ZodString>;
        autoStart: z.ZodOptional<z.ZodBoolean>;
        startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
        receiveMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on-start">, z.ZodLiteral<"manual">]>>;
        ignoreAttachments: z.ZodOptional<z.ZodBoolean>;
        ignoreStories: z.ZodOptional<z.ZodBoolean>;
        sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
        dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        defaultTo: z.ZodOptional<z.ZodString>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>>;
        contextVisibility: z.ZodOptional<z.ZodEnum<{
            all: "all";
            allowlist: "allowlist";
            allowlist_quote: "allowlist_quote";
        }>>;
        groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            ingest: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>>>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        blockStreaming: z.ZodOptional<z.ZodBoolean>;
        blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
            minChars: z.ZodOptional<z.ZodNumber>;
            maxChars: z.ZodOptional<z.ZodNumber>;
            idleMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        reactionNotifications: z.ZodOptional<z.ZodEnum<{
            off: "off";
            all: "all";
            allowlist: "allowlist";
            own: "own";
        }>>;
        reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        actions: z.ZodOptional<z.ZodObject<{
            reactions: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        reactionLevel: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            extensive: "extensive";
            ack: "ack";
        }>>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IrcGroupSchema: z.ZodObject<{
    requireMention: z.ZodOptional<z.ZodBoolean>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IrcNickServSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    service: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    passwordFile: z.ZodOptional<z.ZodString>;
    register: z.ZodOptional<z.ZodBoolean>;
    registerEmail: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IrcAccountSchemaBase: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    host: z.ZodOptional<z.ZodString>;
    port: z.ZodOptional<z.ZodNumber>;
    tls: z.ZodOptional<z.ZodBoolean>;
    nick: z.ZodOptional<z.ZodString>;
    username: z.ZodOptional<z.ZodString>;
    realname: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    passwordFile: z.ZodOptional<z.ZodString>;
    nickserv: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        service: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        passwordFile: z.ZodOptional<z.ZodString>;
        register: z.ZodOptional<z.ZodBoolean>;
        registerEmail: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IrcAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    host: z.ZodOptional<z.ZodString>;
    port: z.ZodOptional<z.ZodNumber>;
    tls: z.ZodOptional<z.ZodBoolean>;
    nick: z.ZodOptional<z.ZodString>;
    username: z.ZodOptional<z.ZodString>;
    realname: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    passwordFile: z.ZodOptional<z.ZodString>;
    nickserv: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        service: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        passwordFile: z.ZodOptional<z.ZodString>;
        register: z.ZodOptional<z.ZodBoolean>;
        registerEmail: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IrcConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    host: z.ZodOptional<z.ZodString>;
    port: z.ZodOptional<z.ZodNumber>;
    tls: z.ZodOptional<z.ZodBoolean>;
    nick: z.ZodOptional<z.ZodString>;
    username: z.ZodOptional<z.ZodString>;
    realname: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    passwordFile: z.ZodOptional<z.ZodString>;
    nickserv: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        service: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        passwordFile: z.ZodOptional<z.ZodString>;
        register: z.ZodOptional<z.ZodBoolean>;
        registerEmail: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        markdown: z.ZodOptional<z.ZodObject<{
            tables: z.ZodOptional<z.ZodEnum<{
                off: "off";
                block: "block";
                bullets: "bullets";
                code: "code";
            }>>;
        }, z.core.$strict>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        host: z.ZodOptional<z.ZodString>;
        port: z.ZodOptional<z.ZodNumber>;
        tls: z.ZodOptional<z.ZodBoolean>;
        nick: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
        realname: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        passwordFile: z.ZodOptional<z.ZodString>;
        nickserv: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            service: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                source: z.ZodLiteral<"env">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"file">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"exec">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>], "source">]>>;
            passwordFile: z.ZodOptional<z.ZodString>;
            register: z.ZodOptional<z.ZodBoolean>;
            registerEmail: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
        dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        defaultTo: z.ZodOptional<z.ZodString>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>>;
        contextVisibility: z.ZodOptional<z.ZodEnum<{
            all: "all";
            allowlist: "allowlist";
            allowlist_quote: "allowlist_quote";
        }>>;
        groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            systemPrompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>>;
        mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        blockStreaming: z.ZodOptional<z.ZodBoolean>;
        blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
            minChars: z.ZodOptional<z.ZodNumber>;
            maxChars: z.ZodOptional<z.ZodNumber>;
            idleMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IMessageAccountSchemaBase: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    cliPath: z.ZodOptional<z.ZodString>;
    dbPath: z.ZodOptional<z.ZodString>;
    remoteHost: z.ZodOptional<z.ZodString>;
    service: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"imessage">, z.ZodLiteral<"sms">, z.ZodLiteral<"auto">]>>;
    region: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    includeAttachments: z.ZodOptional<z.ZodBoolean>;
    attachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    remoteAttachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IMessageAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    cliPath: z.ZodOptional<z.ZodString>;
    dbPath: z.ZodOptional<z.ZodString>;
    remoteHost: z.ZodOptional<z.ZodString>;
    service: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"imessage">, z.ZodLiteral<"sms">, z.ZodLiteral<"auto">]>>;
    region: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    includeAttachments: z.ZodOptional<z.ZodBoolean>;
    attachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    remoteAttachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IMessageConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    cliPath: z.ZodOptional<z.ZodString>;
    dbPath: z.ZodOptional<z.ZodString>;
    remoteHost: z.ZodOptional<z.ZodString>;
    service: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"imessage">, z.ZodLiteral<"sms">, z.ZodLiteral<"auto">]>>;
    region: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    includeAttachments: z.ZodOptional<z.ZodBoolean>;
    attachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    remoteAttachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        markdown: z.ZodOptional<z.ZodObject<{
            tables: z.ZodOptional<z.ZodEnum<{
                off: "off";
                block: "block";
                bullets: "bullets";
                code: "code";
            }>>;
        }, z.core.$strict>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        cliPath: z.ZodOptional<z.ZodString>;
        dbPath: z.ZodOptional<z.ZodString>;
        remoteHost: z.ZodOptional<z.ZodString>;
        service: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"imessage">, z.ZodLiteral<"sms">, z.ZodLiteral<"auto">]>>;
        region: z.ZodOptional<z.ZodString>;
        dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        defaultTo: z.ZodOptional<z.ZodString>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>>;
        contextVisibility: z.ZodOptional<z.ZodEnum<{
            all: "all";
            allowlist: "allowlist";
            allowlist_quote: "allowlist_quote";
        }>>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        includeAttachments: z.ZodOptional<z.ZodBoolean>;
        attachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        remoteAttachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        blockStreaming: z.ZodOptional<z.ZodBoolean>;
        blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
            minChars: z.ZodOptional<z.ZodNumber>;
            maxChars: z.ZodOptional<z.ZodNumber>;
            idleMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>>>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const BlueBubblesAccountSchemaBase: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    serverUrl: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    sendTimeoutMs: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    mediaLocalRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    network: z.ZodOptional<z.ZodObject<{
        dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    enrichGroupParticipantsFromContacts: z.ZodOptional<z.ZodBoolean>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    coalesceSameSenderDms: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const BlueBubblesAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    serverUrl: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    sendTimeoutMs: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    mediaLocalRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    network: z.ZodOptional<z.ZodObject<{
        dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    enrichGroupParticipantsFromContacts: z.ZodOptional<z.ZodBoolean>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    coalesceSameSenderDms: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const BlueBubblesConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    serverUrl: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    webhookPath: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    sendTimeoutMs: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    mediaLocalRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    network: z.ZodOptional<z.ZodObject<{
        dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    enrichGroupParticipantsFromContacts: z.ZodOptional<z.ZodBoolean>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    coalesceSameSenderDms: z.ZodOptional<z.ZodBoolean>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        markdown: z.ZodOptional<z.ZodObject<{
            tables: z.ZodOptional<z.ZodEnum<{
                off: "off";
                block: "block";
                bullets: "bullets";
                code: "code";
            }>>;
        }, z.core.$strict>>;
        configWrites: z.ZodOptional<z.ZodBoolean>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        serverUrl: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            provider: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>], "source">]>>;
        webhookPath: z.ZodOptional<z.ZodString>;
        dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>>>;
        contextVisibility: z.ZodOptional<z.ZodEnum<{
            all: "all";
            allowlist: "allowlist";
            allowlist_quote: "allowlist_quote";
        }>>;
        historyLimit: z.ZodOptional<z.ZodNumber>;
        dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
        dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>>;
        textChunkLimit: z.ZodOptional<z.ZodNumber>;
        sendTimeoutMs: z.ZodOptional<z.ZodNumber>;
        chunkMode: z.ZodOptional<z.ZodEnum<{
            length: "length";
            newline: "newline";
        }>>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        mediaLocalRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
        network: z.ZodOptional<z.ZodObject<{
            dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        blockStreaming: z.ZodOptional<z.ZodBoolean>;
        blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
            minChars: z.ZodOptional<z.ZodNumber>;
            maxChars: z.ZodOptional<z.ZodNumber>;
            idleMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>>>;
        enrichGroupParticipantsFromContacts: z.ZodOptional<z.ZodBoolean>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        coalesceSameSenderDms: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        edit: z.ZodOptional<z.ZodBoolean>;
        unsend: z.ZodOptional<z.ZodBoolean>;
        reply: z.ZodOptional<z.ZodBoolean>;
        sendWithEffect: z.ZodOptional<z.ZodBoolean>;
        renameGroup: z.ZodOptional<z.ZodBoolean>;
        setGroupIcon: z.ZodOptional<z.ZodBoolean>;
        addParticipant: z.ZodOptional<z.ZodBoolean>;
        removeParticipant: z.ZodOptional<z.ZodBoolean>;
        leaveGroup: z.ZodOptional<z.ZodBoolean>;
        sendAttachment: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const MSTeamsChannelSchema: z.ZodObject<{
    requireMention: z.ZodOptional<z.ZodBoolean>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    replyStyle: z.ZodOptional<z.ZodEnum<{
        thread: "thread";
        "top-level": "top-level";
    }>>;
}, z.core.$strict>;
export declare const MSTeamsTeamSchema: z.ZodObject<{
    requireMention: z.ZodOptional<z.ZodBoolean>;
    tools: z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
    replyStyle: z.ZodOptional<z.ZodEnum<{
        thread: "thread";
        "top-level": "top-level";
    }>>;
    channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        replyStyle: z.ZodOptional<z.ZodEnum<{
            thread: "thread";
            "top-level": "top-level";
        }>>;
    }, z.core.$strict>>>>;
}, z.core.$strict>;
export declare const MSTeamsConfigSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
    markdown: z.ZodOptional<z.ZodObject<{
        tables: z.ZodOptional<z.ZodEnum<{
            off: "off";
            block: "block";
            bullets: "bullets";
            code: "code";
        }>>;
    }, z.core.$strict>>;
    configWrites: z.ZodOptional<z.ZodBoolean>;
    appId: z.ZodOptional<z.ZodString>;
    appPassword: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        source: z.ZodLiteral<"env">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"file">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        source: z.ZodLiteral<"exec">;
        provider: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>], "source">]>>;
    tenantId: z.ZodOptional<z.ZodString>;
    authType: z.ZodOptional<z.ZodEnum<{
        secret: "secret";
        federated: "federated";
    }>>;
    certificatePath: z.ZodOptional<z.ZodString>;
    certificateThumbprint: z.ZodOptional<z.ZodString>;
    useManagedIdentity: z.ZodOptional<z.ZodBoolean>;
    managedIdentityClientId: z.ZodOptional<z.ZodString>;
    webhook: z.ZodOptional<z.ZodObject<{
        port: z.ZodOptional<z.ZodNumber>;
        path: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>>>;
    contextVisibility: z.ZodOptional<z.ZodEnum<{
        all: "all";
        allowlist: "allowlist";
        allowlist_quote: "allowlist_quote";
    }>>;
    textChunkLimit: z.ZodOptional<z.ZodNumber>;
    chunkMode: z.ZodOptional<z.ZodEnum<{
        length: "length";
        newline: "newline";
    }>>;
    typingIndicator: z.ZodOptional<z.ZodBoolean>;
    blockStreaming: z.ZodOptional<z.ZodBoolean>;
    blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
        minChars: z.ZodOptional<z.ZodNumber>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        idleMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    mediaAllowHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    mediaAuthAllowHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
    dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
    dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        historyLimit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>>;
    replyStyle: z.ZodOptional<z.ZodEnum<{
        thread: "thread";
        "top-level": "top-level";
    }>>;
    teams: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        requireMention: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
        replyStyle: z.ZodOptional<z.ZodEnum<{
            thread: "thread";
            "top-level": "top-level";
        }>>;
        channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            requireMention: z.ZodOptional<z.ZodBoolean>;
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            replyStyle: z.ZodOptional<z.ZodEnum<{
                thread: "thread";
                "top-level": "top-level";
            }>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    sharePointSiteId: z.ZodOptional<z.ZodString>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    welcomeCard: z.ZodOptional<z.ZodBoolean>;
    promptStarters: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groupWelcomeCard: z.ZodOptional<z.ZodBoolean>;
    feedbackEnabled: z.ZodOptional<z.ZodBoolean>;
    feedbackReflection: z.ZodOptional<z.ZodBoolean>;
    feedbackReflectionCooldownMs: z.ZodOptional<z.ZodNumber>;
    delegatedAuth: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        scopes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    sso: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        connectionName: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;

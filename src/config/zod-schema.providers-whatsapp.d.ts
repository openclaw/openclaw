import { z } from "zod";
export declare const WhatsAppAccountSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    authDir: z.ZodOptional<z.ZodString>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
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
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    messagePrefix: z.ZodOptional<z.ZodString>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>> | z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    selfChatMode: z.ZodOptional<z.ZodBoolean>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groupPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>> | z.ZodDefault<z.ZodOptional<z.ZodEnum<{
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
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    direct: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    ackReaction: z.ZodOptional<z.ZodObject<{
        emoji: z.ZodOptional<z.ZodString>;
        direct: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        group: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            never: "never";
            always: "always";
            mentions: "mentions";
        }>>>;
    }, z.core.$strict>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    debounceMs: z.ZodOptional<z.ZodNumber> | z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const WhatsAppConfigSchema: z.ZodObject<{
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        authDir: z.ZodOptional<z.ZodString>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
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
        sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
        messagePrefix: z.ZodOptional<z.ZodString>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        dmPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>> | z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
            pairing: "pairing";
        }>>>;
        selfChatMode: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
        defaultTo: z.ZodOptional<z.ZodString>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
        groupPolicy: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            open: "open";
            allowlist: "allowlist";
        }>> | z.ZodDefault<z.ZodOptional<z.ZodEnum<{
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
            systemPrompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>>;
        direct: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            systemPrompt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>>;
        ackReaction: z.ZodOptional<z.ZodObject<{
            emoji: z.ZodOptional<z.ZodString>;
            direct: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            group: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                never: "never";
                always: "always";
                mentions: "mentions";
            }>>>;
        }, z.core.$strict>>;
        reactionLevel: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            extensive: "extensive";
            ack: "ack";
        }>>;
        debounceMs: z.ZodOptional<z.ZodNumber> | z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
        replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
        heartbeat: z.ZodOptional<z.ZodObject<{
            showOk: z.ZodOptional<z.ZodBoolean>;
            showAlerts: z.ZodOptional<z.ZodBoolean>;
            useIndicator: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        healthMonitor: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>>>>;
    defaultAccount: z.ZodOptional<z.ZodString>;
    mediaMaxMb: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    actions: z.ZodOptional<z.ZodObject<{
        reactions: z.ZodOptional<z.ZodBoolean>;
        sendMessage: z.ZodOptional<z.ZodBoolean>;
        polls: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
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
    sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
    messagePrefix: z.ZodOptional<z.ZodString>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    dmPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>> | z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
        pairing: "pairing";
    }>>>;
    selfChatMode: z.ZodOptional<z.ZodBoolean>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultTo: z.ZodOptional<z.ZodString>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groupPolicy: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        open: "open";
        allowlist: "allowlist";
    }>> | z.ZodDefault<z.ZodOptional<z.ZodEnum<{
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
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    direct: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    ackReaction: z.ZodOptional<z.ZodObject<{
        emoji: z.ZodOptional<z.ZodString>;
        direct: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        group: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            never: "never";
            always: "always";
            mentions: "mentions";
        }>>>;
    }, z.core.$strict>>;
    reactionLevel: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        extensive: "extensive";
        ack: "ack";
    }>>;
    debounceMs: z.ZodOptional<z.ZodNumber> | z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">, z.ZodLiteral<"batched">]>>;
    heartbeat: z.ZodOptional<z.ZodObject<{
        showOk: z.ZodOptional<z.ZodBoolean>;
        showAlerts: z.ZodOptional<z.ZodBoolean>;
        useIndicator: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    healthMonitor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;

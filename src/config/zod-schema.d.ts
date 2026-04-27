import { z } from "zod";
export declare const OpenClawSchema: z.ZodObject<{
    $schema: z.ZodOptional<z.ZodString>;
    meta: z.ZodOptional<z.ZodObject<{
        lastTouchedVersion: z.ZodOptional<z.ZodString>;
        lastTouchedAt: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodNumber, z.ZodTransform<string, number>>]>>;
    }, z.core.$strict>>;
    env: z.ZodOptional<z.ZodObject<{
        shellEnv: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        vars: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$catchall<z.ZodString>>>;
    wizard: z.ZodOptional<z.ZodObject<{
        lastRunAt: z.ZodOptional<z.ZodString>;
        lastRunVersion: z.ZodOptional<z.ZodString>;
        lastRunCommit: z.ZodOptional<z.ZodString>;
        lastRunCommand: z.ZodOptional<z.ZodString>;
        lastRunMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"local">, z.ZodLiteral<"remote">]>>;
    }, z.core.$strict>>;
    diagnostics: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        flags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        stuckSessionWarnMs: z.ZodOptional<z.ZodNumber>;
        otel: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            endpoint: z.ZodOptional<z.ZodString>;
            protocol: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"http/protobuf">, z.ZodLiteral<"grpc">]>>;
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            serviceName: z.ZodOptional<z.ZodString>;
            traces: z.ZodOptional<z.ZodBoolean>;
            metrics: z.ZodOptional<z.ZodBoolean>;
            logs: z.ZodOptional<z.ZodBoolean>;
            sampleRate: z.ZodOptional<z.ZodNumber>;
            flushIntervalMs: z.ZodOptional<z.ZodNumber>;
            captureContent: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                inputMessages: z.ZodOptional<z.ZodBoolean>;
                outputMessages: z.ZodOptional<z.ZodBoolean>;
                toolInputs: z.ZodOptional<z.ZodBoolean>;
                toolOutputs: z.ZodOptional<z.ZodBoolean>;
                systemPrompt: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>]>>;
        }, z.core.$strict>>;
        cacheTrace: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            filePath: z.ZodOptional<z.ZodString>;
            includeMessages: z.ZodOptional<z.ZodBoolean>;
            includePrompt: z.ZodOptional<z.ZodBoolean>;
            includeSystem: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    logging: z.ZodOptional<z.ZodObject<{
        level: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"silent">, z.ZodLiteral<"fatal">, z.ZodLiteral<"error">, z.ZodLiteral<"warn">, z.ZodLiteral<"info">, z.ZodLiteral<"debug">, z.ZodLiteral<"trace">]>>;
        file: z.ZodOptional<z.ZodString>;
        maxFileBytes: z.ZodOptional<z.ZodNumber>;
        consoleLevel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"silent">, z.ZodLiteral<"fatal">, z.ZodLiteral<"error">, z.ZodLiteral<"warn">, z.ZodLiteral<"info">, z.ZodLiteral<"debug">, z.ZodLiteral<"trace">]>>;
        consoleStyle: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"pretty">, z.ZodLiteral<"compact">, z.ZodLiteral<"json">]>>;
        redactSensitive: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"tools">]>>;
        redactPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    cli: z.ZodOptional<z.ZodObject<{
        banner: z.ZodOptional<z.ZodObject<{
            taglineMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"random">, z.ZodLiteral<"default">, z.ZodLiteral<"off">]>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    crestodian: z.ZodOptional<z.ZodObject<{
        rescue: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodBoolean]>>;
            ownerDmOnly: z.ZodOptional<z.ZodBoolean>;
            pendingTtlMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    update: z.ZodOptional<z.ZodObject<{
        channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"stable">, z.ZodLiteral<"beta">, z.ZodLiteral<"dev">]>>;
        checkOnStart: z.ZodOptional<z.ZodBoolean>;
        auto: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            stableDelayHours: z.ZodOptional<z.ZodNumber>;
            stableJitterHours: z.ZodOptional<z.ZodNumber>;
            betaCheckIntervalHours: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    browser: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        evaluateEnabled: z.ZodOptional<z.ZodBoolean>;
        cdpUrl: z.ZodOptional<z.ZodString>;
        remoteCdpTimeoutMs: z.ZodOptional<z.ZodNumber>;
        remoteCdpHandshakeTimeoutMs: z.ZodOptional<z.ZodNumber>;
        localLaunchTimeoutMs: z.ZodOptional<z.ZodNumber>;
        localCdpReadyTimeoutMs: z.ZodOptional<z.ZodNumber>;
        actionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        color: z.ZodOptional<z.ZodString>;
        executablePath: z.ZodOptional<z.ZodString>;
        headless: z.ZodOptional<z.ZodBoolean>;
        noSandbox: z.ZodOptional<z.ZodBoolean>;
        attachOnly: z.ZodOptional<z.ZodBoolean>;
        cdpPortRangeStart: z.ZodOptional<z.ZodNumber>;
        defaultProfile: z.ZodOptional<z.ZodString>;
        snapshotDefaults: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodLiteral<"efficient">>;
        }, z.core.$strict>>;
        ssrfPolicy: z.ZodOptional<z.ZodObject<{
            dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
            allowedHostnames: z.ZodOptional<z.ZodArray<z.ZodString>>;
            hostnameAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        profiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            cdpPort: z.ZodOptional<z.ZodNumber>;
            cdpUrl: z.ZodOptional<z.ZodString>;
            userDataDir: z.ZodOptional<z.ZodString>;
            mcpCommand: z.ZodOptional<z.ZodString>;
            mcpArgs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            driver: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"openclaw">, z.ZodLiteral<"clawd">, z.ZodLiteral<"existing-session">]>>;
            headless: z.ZodOptional<z.ZodBoolean>;
            executablePath: z.ZodOptional<z.ZodString>;
            attachOnly: z.ZodOptional<z.ZodBoolean>;
            color: z.ZodString;
        }, z.core.$strict>>>;
        extraArgs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    ui: z.ZodOptional<z.ZodObject<{
        seamColor: z.ZodOptional<z.ZodString>;
        assistant: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            avatar: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    secrets: z.ZodOptional<z.ZodObject<{
        providers: z.ZodOptional<z.ZodObject<{}, z.core.$catchall<z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            path: z.ZodString;
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"singleValue">, z.ZodLiteral<"json">]>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
            maxBytes: z.ZodOptional<z.ZodNumber>;
            allowInsecurePath: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            command: z.ZodString;
            args: z.ZodOptional<z.ZodArray<z.ZodString>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
            noOutputTimeoutMs: z.ZodOptional<z.ZodNumber>;
            maxOutputBytes: z.ZodOptional<z.ZodNumber>;
            jsonOnly: z.ZodOptional<z.ZodBoolean>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            passEnv: z.ZodOptional<z.ZodArray<z.ZodString>>;
            trustedDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            allowInsecurePath: z.ZodOptional<z.ZodBoolean>;
            allowSymlinkCommand: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>], "source">>>>;
        defaults: z.ZodOptional<z.ZodObject<{
            env: z.ZodOptional<z.ZodString>;
            file: z.ZodOptional<z.ZodString>;
            exec: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        resolution: z.ZodOptional<z.ZodObject<{
            maxProviderConcurrency: z.ZodOptional<z.ZodNumber>;
            maxRefsPerProvider: z.ZodOptional<z.ZodNumber>;
            maxBatchBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    auth: z.ZodOptional<z.ZodObject<{
        profiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            provider: z.ZodString;
            mode: z.ZodUnion<readonly [z.ZodLiteral<"api_key">, z.ZodLiteral<"oauth">, z.ZodLiteral<"token">]>;
            email: z.ZodOptional<z.ZodString>;
            displayName: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        order: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        cooldowns: z.ZodOptional<z.ZodObject<{
            billingBackoffHours: z.ZodOptional<z.ZodNumber>;
            billingBackoffHoursByProvider: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            billingMaxHours: z.ZodOptional<z.ZodNumber>;
            authPermanentBackoffMinutes: z.ZodOptional<z.ZodNumber>;
            authPermanentMaxMinutes: z.ZodOptional<z.ZodNumber>;
            failureWindowHours: z.ZodOptional<z.ZodNumber>;
            overloadedProfileRotations: z.ZodOptional<z.ZodNumber>;
            overloadedBackoffMs: z.ZodOptional<z.ZodNumber>;
            rateLimitedProfileRotations: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    acp: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        dispatch: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        backend: z.ZodOptional<z.ZodString>;
        defaultAgent: z.ZodOptional<z.ZodString>;
        allowedAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
        maxConcurrentSessions: z.ZodOptional<z.ZodNumber>;
        stream: z.ZodOptional<z.ZodObject<{
            coalesceIdleMs: z.ZodOptional<z.ZodNumber>;
            maxChunkChars: z.ZodOptional<z.ZodNumber>;
            repeatSuppression: z.ZodOptional<z.ZodBoolean>;
            deliveryMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"live">, z.ZodLiteral<"final_only">]>>;
            hiddenBoundarySeparator: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"space">, z.ZodLiteral<"newline">, z.ZodLiteral<"paragraph">]>>;
            maxOutputChars: z.ZodOptional<z.ZodNumber>;
            maxSessionUpdateChars: z.ZodOptional<z.ZodNumber>;
            tagVisibility: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        }, z.core.$strict>>;
        runtime: z.ZodOptional<z.ZodObject<{
            ttlMinutes: z.ZodOptional<z.ZodNumber>;
            installCommand: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    models: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"merge">, z.ZodLiteral<"replace">]>>;
        providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            baseUrl: z.ZodString;
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
            auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"api-key">, z.ZodLiteral<"aws-sdk">, z.ZodLiteral<"oauth">, z.ZodLiteral<"token">]>>;
            api: z.ZodOptional<z.ZodEnum<{
                "openai-completions": "openai-completions";
                "openai-responses": "openai-responses";
                "openai-codex-responses": "openai-codex-responses";
                "anthropic-messages": "anthropic-messages";
                "google-generative-ai": "google-generative-ai";
                "github-copilot": "github-copilot";
                "bedrock-converse-stream": "bedrock-converse-stream";
                ollama: "ollama";
                "azure-openai-responses": "azure-openai-responses";
            }>>;
            injectNumCtxForOpenAICompat: z.ZodOptional<z.ZodBoolean>;
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
            }, z.core.$strict>], "source">]>>>;
            authHeader: z.ZodOptional<z.ZodBoolean>;
            request: z.ZodOptional<z.ZodObject<{
                allowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                }, z.core.$strict>], "source">]>>>;
                auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"provider-default">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"authorization-bearer">;
                    token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"header">;
                    headerName: z.ZodString;
                    value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                    prefix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>]>>;
                proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"env-proxy">;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"explicit-proxy">;
                    url: z.ZodString;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>>;
                tls: z.ZodOptional<z.ZodObject<{
                    ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    serverName: z.ZodOptional<z.ZodString>;
                    insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            models: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                api: z.ZodOptional<z.ZodEnum<{
                    "openai-completions": "openai-completions";
                    "openai-responses": "openai-responses";
                    "openai-codex-responses": "openai-codex-responses";
                    "anthropic-messages": "anthropic-messages";
                    "google-generative-ai": "google-generative-ai";
                    "github-copilot": "github-copilot";
                    "bedrock-converse-stream": "bedrock-converse-stream";
                    ollama: "ollama";
                    "azure-openai-responses": "azure-openai-responses";
                }>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                reasoning: z.ZodOptional<z.ZodBoolean>;
                input: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"text">, z.ZodLiteral<"image">]>>>;
                cost: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodNumber>;
                    output: z.ZodOptional<z.ZodNumber>;
                    cacheRead: z.ZodOptional<z.ZodNumber>;
                    cacheWrite: z.ZodOptional<z.ZodNumber>;
                    tieredPricing: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        input: z.ZodNumber;
                        output: z.ZodNumber;
                        cacheRead: z.ZodNumber;
                        cacheWrite: z.ZodNumber;
                        range: z.ZodUnion<readonly [z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>, z.ZodTuple<[z.ZodNumber], null>]>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                contextWindow: z.ZodOptional<z.ZodNumber>;
                contextTokens: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                compat: z.ZodOptional<z.ZodObject<{
                    supportsStore: z.ZodOptional<z.ZodBoolean>;
                    supportsPromptCacheKey: z.ZodOptional<z.ZodBoolean>;
                    supportsDeveloperRole: z.ZodOptional<z.ZodBoolean>;
                    supportsReasoningEffort: z.ZodOptional<z.ZodBoolean>;
                    supportsUsageInStreaming: z.ZodOptional<z.ZodBoolean>;
                    supportsTools: z.ZodOptional<z.ZodBoolean>;
                    supportsStrictMode: z.ZodOptional<z.ZodBoolean>;
                    requiresStringContent: z.ZodOptional<z.ZodBoolean>;
                    visibleReasoningDetailTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    maxTokensField: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"max_completion_tokens">, z.ZodLiteral<"max_tokens">]>>;
                    thinkingFormat: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"openai">, z.ZodLiteral<"openrouter">, z.ZodLiteral<"deepseek">, z.ZodLiteral<"zai">, z.ZodLiteral<"qwen">, z.ZodLiteral<"qwen-chat-template">]>>;
                    requiresToolResultName: z.ZodOptional<z.ZodBoolean>;
                    requiresAssistantAfterToolResult: z.ZodOptional<z.ZodBoolean>;
                    requiresThinkingAsText: z.ZodOptional<z.ZodBoolean>;
                    toolSchemaProfile: z.ZodOptional<z.ZodString>;
                    unsupportedToolSchemaKeywords: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    nativeWebSearchTool: z.ZodOptional<z.ZodBoolean>;
                    toolCallArgumentsEncoding: z.ZodOptional<z.ZodString>;
                    requiresMistralToolIds: z.ZodOptional<z.ZodBoolean>;
                    requiresOpenAiAnthropicToolPayload: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                metadataSource: z.ZodOptional<z.ZodLiteral<"models-add">>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    nodeHost: z.ZodOptional<z.ZodObject<{
        browserProxy: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowProfiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    agents: z.ZodOptional<z.ZodObject<{
        defaults: z.ZodOptional<z.ZodLazy<z.ZodOptional<z.ZodObject<{
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            embeddedHarness: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodOptional<z.ZodString>;
                fallback: z.ZodOptional<z.ZodEnum<{
                    none: "none";
                    pi: "pi";
                }>>;
            }, z.core.$strict>>;
            model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
            imageModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
            imageGenerationModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
            videoGenerationModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
            musicGenerationModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
            mediaGenerationAutoProviderFallback: z.ZodOptional<z.ZodBoolean>;
            pdfModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
            pdfMaxBytesMb: z.ZodOptional<z.ZodNumber>;
            pdfMaxPages: z.ZodOptional<z.ZodNumber>;
            models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                alias: z.ZodOptional<z.ZodString>;
                params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                streaming: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>>;
            workspace: z.ZodOptional<z.ZodString>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            silentReply: z.ZodOptional<z.ZodObject<{
                direct: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
                group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
                internal: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
            }, z.core.$strict>>;
            silentReplyRewrite: z.ZodOptional<z.ZodObject<{
                direct: z.ZodOptional<z.ZodBoolean>;
                group: z.ZodOptional<z.ZodBoolean>;
                internal: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            repoRoot: z.ZodOptional<z.ZodString>;
            systemPromptOverride: z.ZodOptional<z.ZodString>;
            promptOverlays: z.ZodOptional<z.ZodObject<{
                gpt5: z.ZodOptional<z.ZodObject<{
                    personality: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"friendly">, z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            skipBootstrap: z.ZodOptional<z.ZodBoolean>;
            contextInjection: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"continuation-skip">, z.ZodLiteral<"never">]>>;
            bootstrapMaxChars: z.ZodOptional<z.ZodNumber>;
            bootstrapTotalMaxChars: z.ZodOptional<z.ZodNumber>;
            experimental: z.ZodOptional<z.ZodObject<{
                localModelLean: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            bootstrapPromptTruncationWarning: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"once">, z.ZodLiteral<"always">]>>;
            userTimezone: z.ZodOptional<z.ZodString>;
            startupContext: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                applyOn: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"new">, z.ZodLiteral<"reset">]>>>;
                dailyMemoryDays: z.ZodOptional<z.ZodNumber>;
                maxFileBytes: z.ZodOptional<z.ZodNumber>;
                maxFileChars: z.ZodOptional<z.ZodNumber>;
                maxTotalChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            contextLimits: z.ZodOptional<z.ZodObject<{
                memoryGetMaxChars: z.ZodOptional<z.ZodNumber>;
                memoryGetDefaultLines: z.ZodOptional<z.ZodNumber>;
                toolResultMaxChars: z.ZodOptional<z.ZodNumber>;
                postCompactionMaxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            timeFormat: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"12">, z.ZodLiteral<"24">]>>;
            envelopeTimezone: z.ZodOptional<z.ZodString>;
            envelopeTimestamp: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
            envelopeElapsed: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
            contextTokens: z.ZodOptional<z.ZodNumber>;
            cliBackends: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                command: z.ZodString;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                output: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"json">, z.ZodLiteral<"text">, z.ZodLiteral<"jsonl">]>>;
                resumeOutput: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"json">, z.ZodLiteral<"text">, z.ZodLiteral<"jsonl">]>>;
                jsonlDialect: z.ZodOptional<z.ZodLiteral<"claude-stream-json">>;
                liveSession: z.ZodOptional<z.ZodLiteral<"claude-stdio">>;
                input: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"arg">, z.ZodLiteral<"stdin">]>>;
                maxPromptArgChars: z.ZodOptional<z.ZodNumber>;
                env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                clearEnv: z.ZodOptional<z.ZodArray<z.ZodString>>;
                modelArg: z.ZodOptional<z.ZodString>;
                modelAliases: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                sessionArg: z.ZodOptional<z.ZodString>;
                sessionArgs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                resumeArgs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                sessionMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"existing">, z.ZodLiteral<"none">]>>;
                sessionIdFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
                systemPromptArg: z.ZodOptional<z.ZodString>;
                systemPromptFileArg: z.ZodOptional<z.ZodString>;
                systemPromptFileConfigArg: z.ZodOptional<z.ZodString>;
                systemPromptFileConfigKey: z.ZodOptional<z.ZodString>;
                systemPromptMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"append">, z.ZodLiteral<"replace">]>>;
                systemPromptWhen: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"always">, z.ZodLiteral<"never">]>>;
                imageArg: z.ZodOptional<z.ZodString>;
                imageMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"repeat">, z.ZodLiteral<"list">]>>;
                imagePathScope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"temp">, z.ZodLiteral<"workspace">]>>;
                serialize: z.ZodOptional<z.ZodBoolean>;
                reliability: z.ZodOptional<z.ZodObject<{
                    watchdog: z.ZodOptional<z.ZodObject<{
                        fresh: z.ZodOptional<z.ZodObject<{
                            noOutputTimeoutMs: z.ZodOptional<z.ZodNumber>;
                            noOutputTimeoutRatio: z.ZodOptional<z.ZodNumber>;
                            minMs: z.ZodOptional<z.ZodNumber>;
                            maxMs: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        resume: z.ZodOptional<z.ZodObject<{
                            noOutputTimeoutMs: z.ZodOptional<z.ZodNumber>;
                            noOutputTimeoutRatio: z.ZodOptional<z.ZodNumber>;
                            minMs: z.ZodOptional<z.ZodNumber>;
                            maxMs: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
            }, z.core.$strict>>>;
            memorySearch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                sources: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"memory">, z.ZodLiteral<"sessions">]>>>;
                extraPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
                qmd: z.ZodOptional<z.ZodObject<{
                    extraCollections: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        path: z.ZodString;
                        name: z.ZodOptional<z.ZodString>;
                        pattern: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                multimodal: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    modalities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"all">]>>>;
                    maxFileBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                experimental: z.ZodOptional<z.ZodObject<{
                    sessionMemory: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodString>;
                remote: z.ZodOptional<z.ZodObject<{
                    baseUrl: z.ZodOptional<z.ZodString>;
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
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    batch: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        wait: z.ZodOptional<z.ZodBoolean>;
                        concurrency: z.ZodOptional<z.ZodNumber>;
                        pollIntervalMs: z.ZodOptional<z.ZodNumber>;
                        timeoutMinutes: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                fallback: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                outputDimensionality: z.ZodOptional<z.ZodNumber>;
                local: z.ZodOptional<z.ZodObject<{
                    modelPath: z.ZodOptional<z.ZodString>;
                    modelCacheDir: z.ZodOptional<z.ZodString>;
                    contextSize: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodLiteral<"auto">]>>;
                }, z.core.$strict>>;
                store: z.ZodOptional<z.ZodObject<{
                    driver: z.ZodOptional<z.ZodLiteral<"sqlite">>;
                    path: z.ZodOptional<z.ZodString>;
                    fts: z.ZodOptional<z.ZodObject<{
                        tokenizer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"unicode61">, z.ZodLiteral<"trigram">]>>;
                    }, z.core.$strict>>;
                    vector: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        extensionPath: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                chunking: z.ZodOptional<z.ZodObject<{
                    tokens: z.ZodOptional<z.ZodNumber>;
                    overlap: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                sync: z.ZodOptional<z.ZodObject<{
                    onSessionStart: z.ZodOptional<z.ZodBoolean>;
                    onSearch: z.ZodOptional<z.ZodBoolean>;
                    watch: z.ZodOptional<z.ZodBoolean>;
                    watchDebounceMs: z.ZodOptional<z.ZodNumber>;
                    intervalMinutes: z.ZodOptional<z.ZodNumber>;
                    sessions: z.ZodOptional<z.ZodObject<{
                        deltaBytes: z.ZodOptional<z.ZodNumber>;
                        deltaMessages: z.ZodOptional<z.ZodNumber>;
                        postCompactionForce: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                query: z.ZodOptional<z.ZodObject<{
                    maxResults: z.ZodOptional<z.ZodNumber>;
                    minScore: z.ZodOptional<z.ZodNumber>;
                    hybrid: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        vectorWeight: z.ZodOptional<z.ZodNumber>;
                        textWeight: z.ZodOptional<z.ZodNumber>;
                        candidateMultiplier: z.ZodOptional<z.ZodNumber>;
                        mmr: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            lambda: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        temporalDecay: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            halfLifeDays: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                cache: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxEntries: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            contextPruning: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"cache-ttl">]>>;
                ttl: z.ZodOptional<z.ZodString>;
                keepLastAssistants: z.ZodOptional<z.ZodNumber>;
                softTrimRatio: z.ZodOptional<z.ZodNumber>;
                hardClearRatio: z.ZodOptional<z.ZodNumber>;
                minPrunableToolChars: z.ZodOptional<z.ZodNumber>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                softTrim: z.ZodOptional<z.ZodObject<{
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    headChars: z.ZodOptional<z.ZodNumber>;
                    tailChars: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                hardClear: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    placeholder: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            llm: z.ZodOptional<z.ZodObject<{
                idleTimeoutSeconds: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            compaction: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"default">, z.ZodLiteral<"safeguard">]>>;
                provider: z.ZodOptional<z.ZodString>;
                reserveTokens: z.ZodOptional<z.ZodNumber>;
                keepRecentTokens: z.ZodOptional<z.ZodNumber>;
                reserveTokensFloor: z.ZodOptional<z.ZodNumber>;
                maxHistoryShare: z.ZodOptional<z.ZodNumber>;
                customInstructions: z.ZodOptional<z.ZodString>;
                identifierPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"strict">, z.ZodLiteral<"off">, z.ZodLiteral<"custom">]>>;
                identifierInstructions: z.ZodOptional<z.ZodString>;
                recentTurnsPreserve: z.ZodOptional<z.ZodNumber>;
                qualityGuard: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxRetries: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                postIndexSync: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    async: "async";
                    await: "await";
                }>>;
                postCompactionSections: z.ZodOptional<z.ZodArray<z.ZodString>>;
                model: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                memoryFlush: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    softThresholdTokens: z.ZodOptional<z.ZodNumber>;
                    forceFlushTranscriptBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
                    prompt: z.ZodOptional<z.ZodString>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                truncateAfterCompaction: z.ZodOptional<z.ZodBoolean>;
                notifyUser: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            embeddedPi: z.ZodOptional<z.ZodObject<{
                projectSettingsPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"trusted">, z.ZodLiteral<"sanitize">, z.ZodLiteral<"ignore">]>>;
                executionContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"default">, z.ZodLiteral<"strict-agentic">]>>;
            }, z.core.$strict>>;
            thinkingDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"minimal">, z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">, z.ZodLiteral<"xhigh">, z.ZodLiteral<"adaptive">, z.ZodLiteral<"max">]>>;
            verboseDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">, z.ZodLiteral<"full">]>>;
            elevatedDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">, z.ZodLiteral<"ask">, z.ZodLiteral<"full">]>>;
            blockStreamingDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">]>>;
            blockStreamingBreak: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"text_end">, z.ZodLiteral<"message_end">]>>;
            blockStreamingChunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            humanDelay: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"natural">, z.ZodLiteral<"custom">]>>;
                minMs: z.ZodOptional<z.ZodNumber>;
                maxMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            imageMaxDimensionPx: z.ZodOptional<z.ZodNumber>;
            typingIntervalSeconds: z.ZodOptional<z.ZodNumber>;
            typingMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"never">, z.ZodLiteral<"instant">, z.ZodLiteral<"thinking">, z.ZodLiteral<"message">]>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                every: z.ZodOptional<z.ZodString>;
                activeHours: z.ZodOptional<z.ZodObject<{
                    start: z.ZodOptional<z.ZodString>;
                    end: z.ZodOptional<z.ZodString>;
                    timezone: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                model: z.ZodOptional<z.ZodString>;
                session: z.ZodOptional<z.ZodString>;
                includeReasoning: z.ZodOptional<z.ZodBoolean>;
                target: z.ZodOptional<z.ZodString>;
                directPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"block">]>>;
                to: z.ZodOptional<z.ZodString>;
                accountId: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                includeSystemPromptSection: z.ZodOptional<z.ZodBoolean>;
                ackMaxChars: z.ZodOptional<z.ZodNumber>;
                suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                lightContext: z.ZodOptional<z.ZodBoolean>;
                isolatedSession: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            maxConcurrent: z.ZodOptional<z.ZodNumber>;
            subagents: z.ZodOptional<z.ZodObject<{
                allowAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
                maxConcurrent: z.ZodOptional<z.ZodNumber>;
                maxSpawnDepth: z.ZodOptional<z.ZodNumber>;
                maxChildrenPerAgent: z.ZodOptional<z.ZodNumber>;
                archiveAfterMinutes: z.ZodOptional<z.ZodNumber>;
                model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                    primary: z.ZodOptional<z.ZodString>;
                    fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    timeoutMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>]>>;
                thinking: z.ZodOptional<z.ZodString>;
                runTimeoutSeconds: z.ZodOptional<z.ZodNumber>;
                announceTimeoutMs: z.ZodOptional<z.ZodNumber>;
                requireAgentId: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            sandbox: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"non-main">, z.ZodLiteral<"all">]>>;
                backend: z.ZodOptional<z.ZodString>;
                workspaceAccess: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"ro">, z.ZodLiteral<"rw">]>>;
                sessionToolsVisibility: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"spawned">, z.ZodLiteral<"all">]>>;
                scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"agent">, z.ZodLiteral<"shared">]>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                docker: z.ZodOptional<z.ZodObject<{
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    workdir: z.ZodOptional<z.ZodString>;
                    readOnlyRoot: z.ZodOptional<z.ZodBoolean>;
                    tmpfs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    network: z.ZodOptional<z.ZodString>;
                    user: z.ZodOptional<z.ZodString>;
                    capDrop: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    setupCommand: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>, z.ZodTransform<string, string | string[]>>>;
                    pidsLimit: z.ZodOptional<z.ZodNumber>;
                    memory: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    memorySwap: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    cpus: z.ZodOptional<z.ZodNumber>;
                    ulimits: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodObject<{
                        soft: z.ZodOptional<z.ZodNumber>;
                        hard: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>]>>>;
                    seccompProfile: z.ZodOptional<z.ZodString>;
                    apparmorProfile: z.ZodOptional<z.ZodString>;
                    dns: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    extraHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    dangerouslyAllowReservedContainerTargets: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowExternalBindSources: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowContainerNamespaceJoin: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                ssh: z.ZodOptional<z.ZodObject<{
                    target: z.ZodOptional<z.ZodString>;
                    command: z.ZodOptional<z.ZodString>;
                    workspaceRoot: z.ZodOptional<z.ZodString>;
                    strictHostKeyChecking: z.ZodOptional<z.ZodBoolean>;
                    updateHostKeys: z.ZodOptional<z.ZodBoolean>;
                    identityFile: z.ZodOptional<z.ZodString>;
                    certificateFile: z.ZodOptional<z.ZodString>;
                    knownHostsFile: z.ZodOptional<z.ZodString>;
                    identityData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    certificateData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    knownHostsData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                browser: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    network: z.ZodOptional<z.ZodString>;
                    cdpPort: z.ZodOptional<z.ZodNumber>;
                    cdpSourceRange: z.ZodOptional<z.ZodString>;
                    vncPort: z.ZodOptional<z.ZodNumber>;
                    noVncPort: z.ZodOptional<z.ZodNumber>;
                    headless: z.ZodOptional<z.ZodBoolean>;
                    enableNoVnc: z.ZodOptional<z.ZodBoolean>;
                    allowHostControl: z.ZodOptional<z.ZodBoolean>;
                    autoStart: z.ZodOptional<z.ZodBoolean>;
                    autoStartTimeoutMs: z.ZodOptional<z.ZodNumber>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                prune: z.ZodOptional<z.ZodObject<{
                    idleHours: z.ZodOptional<z.ZodNumber>;
                    maxAgeDays: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        list: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            default: z.ZodOptional<z.ZodBoolean>;
            name: z.ZodOptional<z.ZodString>;
            workspace: z.ZodOptional<z.ZodString>;
            agentDir: z.ZodOptional<z.ZodString>;
            systemPromptOverride: z.ZodOptional<z.ZodString>;
            embeddedHarness: z.ZodOptional<z.ZodObject<{
                runtime: z.ZodOptional<z.ZodString>;
                fallback: z.ZodOptional<z.ZodEnum<{
                    none: "none";
                    pi: "pi";
                }>>;
            }, z.core.$strict>>;
            model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
            thinkingDefault: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                adaptive: "adaptive";
                max: "max";
            }>>;
            reasoningDefault: z.ZodOptional<z.ZodEnum<{
                off: "off";
                on: "on";
                stream: "stream";
            }>>;
            fastModeDefault: z.ZodOptional<z.ZodBoolean>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            memorySearch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                sources: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"memory">, z.ZodLiteral<"sessions">]>>>;
                extraPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
                qmd: z.ZodOptional<z.ZodObject<{
                    extraCollections: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        path: z.ZodString;
                        name: z.ZodOptional<z.ZodString>;
                        pattern: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                multimodal: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    modalities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"all">]>>>;
                    maxFileBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                experimental: z.ZodOptional<z.ZodObject<{
                    sessionMemory: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodString>;
                remote: z.ZodOptional<z.ZodObject<{
                    baseUrl: z.ZodOptional<z.ZodString>;
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
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    batch: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        wait: z.ZodOptional<z.ZodBoolean>;
                        concurrency: z.ZodOptional<z.ZodNumber>;
                        pollIntervalMs: z.ZodOptional<z.ZodNumber>;
                        timeoutMinutes: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                fallback: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                outputDimensionality: z.ZodOptional<z.ZodNumber>;
                local: z.ZodOptional<z.ZodObject<{
                    modelPath: z.ZodOptional<z.ZodString>;
                    modelCacheDir: z.ZodOptional<z.ZodString>;
                    contextSize: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodLiteral<"auto">]>>;
                }, z.core.$strict>>;
                store: z.ZodOptional<z.ZodObject<{
                    driver: z.ZodOptional<z.ZodLiteral<"sqlite">>;
                    path: z.ZodOptional<z.ZodString>;
                    fts: z.ZodOptional<z.ZodObject<{
                        tokenizer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"unicode61">, z.ZodLiteral<"trigram">]>>;
                    }, z.core.$strict>>;
                    vector: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        extensionPath: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                chunking: z.ZodOptional<z.ZodObject<{
                    tokens: z.ZodOptional<z.ZodNumber>;
                    overlap: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                sync: z.ZodOptional<z.ZodObject<{
                    onSessionStart: z.ZodOptional<z.ZodBoolean>;
                    onSearch: z.ZodOptional<z.ZodBoolean>;
                    watch: z.ZodOptional<z.ZodBoolean>;
                    watchDebounceMs: z.ZodOptional<z.ZodNumber>;
                    intervalMinutes: z.ZodOptional<z.ZodNumber>;
                    sessions: z.ZodOptional<z.ZodObject<{
                        deltaBytes: z.ZodOptional<z.ZodNumber>;
                        deltaMessages: z.ZodOptional<z.ZodNumber>;
                        postCompactionForce: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                query: z.ZodOptional<z.ZodObject<{
                    maxResults: z.ZodOptional<z.ZodNumber>;
                    minScore: z.ZodOptional<z.ZodNumber>;
                    hybrid: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        vectorWeight: z.ZodOptional<z.ZodNumber>;
                        textWeight: z.ZodOptional<z.ZodNumber>;
                        candidateMultiplier: z.ZodOptional<z.ZodNumber>;
                        mmr: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            lambda: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        temporalDecay: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            halfLifeDays: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                cache: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxEntries: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            humanDelay: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"natural">, z.ZodLiteral<"custom">]>>;
                minMs: z.ZodOptional<z.ZodNumber>;
                maxMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            skillsLimits: z.ZodOptional<z.ZodObject<{
                maxSkillsPromptChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            contextLimits: z.ZodOptional<z.ZodObject<{
                memoryGetMaxChars: z.ZodOptional<z.ZodNumber>;
                memoryGetDefaultLines: z.ZodOptional<z.ZodNumber>;
                toolResultMaxChars: z.ZodOptional<z.ZodNumber>;
                postCompactionMaxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            contextTokens: z.ZodOptional<z.ZodNumber>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                every: z.ZodOptional<z.ZodString>;
                activeHours: z.ZodOptional<z.ZodObject<{
                    start: z.ZodOptional<z.ZodString>;
                    end: z.ZodOptional<z.ZodString>;
                    timezone: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                model: z.ZodOptional<z.ZodString>;
                session: z.ZodOptional<z.ZodString>;
                includeReasoning: z.ZodOptional<z.ZodBoolean>;
                target: z.ZodOptional<z.ZodString>;
                directPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"block">]>>;
                to: z.ZodOptional<z.ZodString>;
                accountId: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                includeSystemPromptSection: z.ZodOptional<z.ZodBoolean>;
                ackMaxChars: z.ZodOptional<z.ZodNumber>;
                suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                lightContext: z.ZodOptional<z.ZodBoolean>;
                isolatedSession: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            identity: z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                theme: z.ZodOptional<z.ZodString>;
                emoji: z.ZodOptional<z.ZodString>;
                avatar: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            groupChat: z.ZodOptional<z.ZodObject<{
                mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            subagents: z.ZodOptional<z.ZodObject<{
                allowAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
                model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                    primary: z.ZodOptional<z.ZodString>;
                    fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>]>>;
                thinking: z.ZodOptional<z.ZodString>;
                requireAgentId: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            embeddedPi: z.ZodOptional<z.ZodObject<{
                executionContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"default">, z.ZodLiteral<"strict-agentic">]>>;
            }, z.core.$strict>>;
            sandbox: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"non-main">, z.ZodLiteral<"all">]>>;
                backend: z.ZodOptional<z.ZodString>;
                workspaceAccess: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"ro">, z.ZodLiteral<"rw">]>>;
                sessionToolsVisibility: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"spawned">, z.ZodLiteral<"all">]>>;
                scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"agent">, z.ZodLiteral<"shared">]>>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                docker: z.ZodOptional<z.ZodObject<{
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    workdir: z.ZodOptional<z.ZodString>;
                    readOnlyRoot: z.ZodOptional<z.ZodBoolean>;
                    tmpfs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    network: z.ZodOptional<z.ZodString>;
                    user: z.ZodOptional<z.ZodString>;
                    capDrop: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    setupCommand: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>, z.ZodTransform<string, string | string[]>>>;
                    pidsLimit: z.ZodOptional<z.ZodNumber>;
                    memory: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    memorySwap: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    cpus: z.ZodOptional<z.ZodNumber>;
                    ulimits: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodObject<{
                        soft: z.ZodOptional<z.ZodNumber>;
                        hard: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>]>>>;
                    seccompProfile: z.ZodOptional<z.ZodString>;
                    apparmorProfile: z.ZodOptional<z.ZodString>;
                    dns: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    extraHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    dangerouslyAllowReservedContainerTargets: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowExternalBindSources: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowContainerNamespaceJoin: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                ssh: z.ZodOptional<z.ZodObject<{
                    target: z.ZodOptional<z.ZodString>;
                    command: z.ZodOptional<z.ZodString>;
                    workspaceRoot: z.ZodOptional<z.ZodString>;
                    strictHostKeyChecking: z.ZodOptional<z.ZodBoolean>;
                    updateHostKeys: z.ZodOptional<z.ZodBoolean>;
                    identityFile: z.ZodOptional<z.ZodString>;
                    certificateFile: z.ZodOptional<z.ZodString>;
                    knownHostsFile: z.ZodOptional<z.ZodString>;
                    identityData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    certificateData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    knownHostsData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                browser: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    network: z.ZodOptional<z.ZodString>;
                    cdpPort: z.ZodOptional<z.ZodNumber>;
                    cdpSourceRange: z.ZodOptional<z.ZodString>;
                    vncPort: z.ZodOptional<z.ZodNumber>;
                    noVncPort: z.ZodOptional<z.ZodNumber>;
                    headless: z.ZodOptional<z.ZodBoolean>;
                    enableNoVnc: z.ZodOptional<z.ZodBoolean>;
                    allowHostControl: z.ZodOptional<z.ZodBoolean>;
                    autoStart: z.ZodOptional<z.ZodBoolean>;
                    autoStartTimeoutMs: z.ZodOptional<z.ZodNumber>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                prune: z.ZodOptional<z.ZodObject<{
                    idleHours: z.ZodOptional<z.ZodNumber>;
                    maxAgeDays: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            tools: z.ZodOptional<z.ZodObject<{
                elevated: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allowFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>;
                }, z.core.$strict>>;
                exec: z.ZodOptional<z.ZodObject<{
                    approvalRunningNoticeMs: z.ZodOptional<z.ZodNumber>;
                    host: z.ZodOptional<z.ZodEnum<{
                        auto: "auto";
                        sandbox: "sandbox";
                        gateway: "gateway";
                        node: "node";
                    }>>;
                    security: z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        deny: "deny";
                        full: "full";
                    }>>;
                    ask: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        "on-miss": "on-miss";
                        always: "always";
                    }>>;
                    node: z.ZodOptional<z.ZodString>;
                    pathPrepend: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    safeBins: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    strictInlineEval: z.ZodOptional<z.ZodBoolean>;
                    safeBinTrustedDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    safeBinProfiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                        minPositional: z.ZodOptional<z.ZodNumber>;
                        maxPositional: z.ZodOptional<z.ZodNumber>;
                        allowedValueFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deniedFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>;
                    backgroundMs: z.ZodOptional<z.ZodNumber>;
                    timeoutSec: z.ZodOptional<z.ZodNumber>;
                    cleanupMs: z.ZodOptional<z.ZodNumber>;
                    notifyOnExit: z.ZodOptional<z.ZodBoolean>;
                    notifyOnExitEmptySuccess: z.ZodOptional<z.ZodBoolean>;
                    applyPatch: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        workspaceOnly: z.ZodOptional<z.ZodBoolean>;
                        allowModels: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                fs: z.ZodOptional<z.ZodObject<{
                    workspaceOnly: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                loopDetection: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    historySize: z.ZodOptional<z.ZodNumber>;
                    warningThreshold: z.ZodOptional<z.ZodNumber>;
                    unknownToolThreshold: z.ZodOptional<z.ZodNumber>;
                    criticalThreshold: z.ZodOptional<z.ZodNumber>;
                    globalCircuitBreakerThreshold: z.ZodOptional<z.ZodNumber>;
                    detectors: z.ZodOptional<z.ZodObject<{
                        genericRepeat: z.ZodOptional<z.ZodBoolean>;
                        knownPollNoProgress: z.ZodOptional<z.ZodBoolean>;
                        pingPong: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                sandbox: z.ZodOptional<z.ZodObject<{
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                byProvider: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>;
            runtime: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                type: z.ZodLiteral<"embedded">;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"acp">;
                acp: z.ZodOptional<z.ZodObject<{
                    agent: z.ZodOptional<z.ZodString>;
                    backend: z.ZodOptional<z.ZodString>;
                    mode: z.ZodOptional<z.ZodEnum<{
                        persistent: "persistent";
                        oneshot: "oneshot";
                    }>>;
                    cwd: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>]>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    tools: z.ZodOptional<z.ZodObject<{
        web: z.ZodOptional<z.ZodObject<{
            search: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                provider: z.ZodOptional<z.ZodString>;
                maxResults: z.ZodOptional<z.ZodNumber>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
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
                openaiCodex: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"cached">, z.ZodLiteral<"live">]>>;
                    allowedDomains: z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[] | undefined, string[]>>>;
                    contextSize: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>;
                    userLocation: z.ZodOptional<z.ZodPipe<z.ZodObject<{
                        country: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodOptional<z.ZodString>>;
                        region: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodOptional<z.ZodString>>;
                        city: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodOptional<z.ZodString>>;
                        timezone: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodOptional<z.ZodString>>;
                    }, z.core.$strict>, z.ZodTransform<{
                        country?: string | undefined;
                        region?: string | undefined;
                        city?: string | undefined;
                        timezone?: string | undefined;
                    } | undefined, {
                        country?: string | undefined;
                        region?: string | undefined;
                        city?: string | undefined;
                        timezone?: string | undefined;
                    }>>>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            fetch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                provider: z.ZodOptional<z.ZodString>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                maxCharsCap: z.ZodOptional<z.ZodNumber>;
                maxResponseBytes: z.ZodOptional<z.ZodNumber>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
                maxRedirects: z.ZodOptional<z.ZodNumber>;
                userAgent: z.ZodOptional<z.ZodString>;
                readability: z.ZodOptional<z.ZodBoolean>;
                ssrfPolicy: z.ZodOptional<z.ZodObject<{
                    allowRfc2544BenchmarkRange: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                firecrawl: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
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
                    baseUrl: z.ZodOptional<z.ZodString>;
                    onlyMainContent: z.ZodOptional<z.ZodBoolean>;
                    maxAgeMs: z.ZodOptional<z.ZodNumber>;
                    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            x_search: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                model: z.ZodOptional<z.ZodString>;
                inlineCitations: z.ZodOptional<z.ZodBoolean>;
                maxTurns: z.ZodOptional<z.ZodNumber>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        media: z.ZodOptional<z.ZodObject<{
            models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                profile: z.ZodOptional<z.ZodString>;
                preferredProfile: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                request: z.ZodOptional<z.ZodObject<{
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>>>;
                    auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"provider-default">;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"authorization-bearer">;
                        token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"header">;
                        headerName: z.ZodString;
                        value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                        prefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>]>>;
                    proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"env-proxy">;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"explicit-proxy">;
                        url: z.ZodString;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>>;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                command: z.ZodOptional<z.ZodString>;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            concurrency: z.ZodOptional<z.ZodNumber>;
            asyncCompletion: z.ZodOptional<z.ZodObject<{
                directSend: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            image: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                attachments: z.ZodOptional<z.ZodObject<{
                    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    maxAttachments: z.ZodOptional<z.ZodNumber>;
                    prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
                }, z.core.$strict>>;
                models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                    profile: z.ZodOptional<z.ZodString>;
                    preferredProfile: z.ZodOptional<z.ZodString>;
                    prompt: z.ZodOptional<z.ZodString>;
                    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                    language: z.ZodOptional<z.ZodString>;
                    providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                    deepgram: z.ZodOptional<z.ZodObject<{
                        detectLanguage: z.ZodOptional<z.ZodBoolean>;
                        punctuate: z.ZodOptional<z.ZodBoolean>;
                        smartFormat: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    request: z.ZodOptional<z.ZodObject<{
                        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>>>;
                        auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                            mode: z.ZodLiteral<"provider-default">;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"authorization-bearer">;
                            token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            }, z.core.$strict>], "source">]>;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"header">;
                            headerName: z.ZodString;
                            value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            }, z.core.$strict>], "source">]>;
                            prefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>]>>;
                        proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                            mode: z.ZodLiteral<"env-proxy">;
                            tls: z.ZodOptional<z.ZodObject<{
                                ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                serverName: z.ZodOptional<z.ZodString>;
                                insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                            }, z.core.$strict>>;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"explicit-proxy">;
                            url: z.ZodString;
                            tls: z.ZodOptional<z.ZodObject<{
                                ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                serverName: z.ZodOptional<z.ZodString>;
                                insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                            }, z.core.$strict>>;
                        }, z.core.$strict>]>>;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                    provider: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                    capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                    type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                    command: z.ZodOptional<z.ZodString>;
                    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    maxBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                echoTranscript: z.ZodOptional<z.ZodBoolean>;
                echoFormat: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                request: z.ZodOptional<z.ZodObject<{
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>>>;
                    auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"provider-default">;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"authorization-bearer">;
                        token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"header">;
                        headerName: z.ZodString;
                        value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                        prefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>]>>;
                    proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"env-proxy">;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"explicit-proxy">;
                        url: z.ZodString;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>>;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                scope: z.ZodOptional<z.ZodObject<{
                    default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                        match: z.ZodOptional<z.ZodObject<{
                            channel: z.ZodOptional<z.ZodString>;
                            chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                            keyPrefix: z.ZodOptional<z.ZodString>;
                            rawKeyPrefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
            audio: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                attachments: z.ZodOptional<z.ZodObject<{
                    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    maxAttachments: z.ZodOptional<z.ZodNumber>;
                    prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
                }, z.core.$strict>>;
                models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                    profile: z.ZodOptional<z.ZodString>;
                    preferredProfile: z.ZodOptional<z.ZodString>;
                    prompt: z.ZodOptional<z.ZodString>;
                    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                    language: z.ZodOptional<z.ZodString>;
                    providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                    deepgram: z.ZodOptional<z.ZodObject<{
                        detectLanguage: z.ZodOptional<z.ZodBoolean>;
                        punctuate: z.ZodOptional<z.ZodBoolean>;
                        smartFormat: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    request: z.ZodOptional<z.ZodObject<{
                        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>>>;
                        auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                            mode: z.ZodLiteral<"provider-default">;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"authorization-bearer">;
                            token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            }, z.core.$strict>], "source">]>;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"header">;
                            headerName: z.ZodString;
                            value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            }, z.core.$strict>], "source">]>;
                            prefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>]>>;
                        proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                            mode: z.ZodLiteral<"env-proxy">;
                            tls: z.ZodOptional<z.ZodObject<{
                                ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                serverName: z.ZodOptional<z.ZodString>;
                                insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                            }, z.core.$strict>>;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"explicit-proxy">;
                            url: z.ZodString;
                            tls: z.ZodOptional<z.ZodObject<{
                                ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                serverName: z.ZodOptional<z.ZodString>;
                                insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                            }, z.core.$strict>>;
                        }, z.core.$strict>]>>;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                    provider: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                    capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                    type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                    command: z.ZodOptional<z.ZodString>;
                    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    maxBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                echoTranscript: z.ZodOptional<z.ZodBoolean>;
                echoFormat: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                request: z.ZodOptional<z.ZodObject<{
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>>>;
                    auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"provider-default">;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"authorization-bearer">;
                        token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"header">;
                        headerName: z.ZodString;
                        value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                        prefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>]>>;
                    proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"env-proxy">;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"explicit-proxy">;
                        url: z.ZodString;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>>;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                scope: z.ZodOptional<z.ZodObject<{
                    default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                        match: z.ZodOptional<z.ZodObject<{
                            channel: z.ZodOptional<z.ZodString>;
                            chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                            keyPrefix: z.ZodOptional<z.ZodString>;
                            rawKeyPrefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
            video: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                attachments: z.ZodOptional<z.ZodObject<{
                    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    maxAttachments: z.ZodOptional<z.ZodNumber>;
                    prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
                }, z.core.$strict>>;
                models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                    profile: z.ZodOptional<z.ZodString>;
                    preferredProfile: z.ZodOptional<z.ZodString>;
                    prompt: z.ZodOptional<z.ZodString>;
                    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                    language: z.ZodOptional<z.ZodString>;
                    providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                    deepgram: z.ZodOptional<z.ZodObject<{
                        detectLanguage: z.ZodOptional<z.ZodBoolean>;
                        punctuate: z.ZodOptional<z.ZodBoolean>;
                        smartFormat: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    request: z.ZodOptional<z.ZodObject<{
                        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>>>;
                        auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                            mode: z.ZodLiteral<"provider-default">;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"authorization-bearer">;
                            token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            }, z.core.$strict>], "source">]>;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"header">;
                            headerName: z.ZodString;
                            value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            }, z.core.$strict>], "source">]>;
                            prefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>]>>;
                        proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                            mode: z.ZodLiteral<"env-proxy">;
                            tls: z.ZodOptional<z.ZodObject<{
                                ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                serverName: z.ZodOptional<z.ZodString>;
                                insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                            }, z.core.$strict>>;
                        }, z.core.$strict>, z.ZodObject<{
                            mode: z.ZodLiteral<"explicit-proxy">;
                            url: z.ZodString;
                            tls: z.ZodOptional<z.ZodObject<{
                                ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                                serverName: z.ZodOptional<z.ZodString>;
                                insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                            }, z.core.$strict>>;
                        }, z.core.$strict>]>>;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                    provider: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                    capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                    type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                    command: z.ZodOptional<z.ZodString>;
                    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    maxBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                echoTranscript: z.ZodOptional<z.ZodBoolean>;
                echoFormat: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                request: z.ZodOptional<z.ZodObject<{
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>>>;
                    auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"provider-default">;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"authorization-bearer">;
                        token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"header">;
                        headerName: z.ZodString;
                        value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                        prefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>]>>;
                    proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"env-proxy">;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"explicit-proxy">;
                        url: z.ZodString;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>>;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                scope: z.ZodOptional<z.ZodObject<{
                    default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                        match: z.ZodOptional<z.ZodObject<{
                            channel: z.ZodOptional<z.ZodString>;
                            chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                            keyPrefix: z.ZodOptional<z.ZodString>;
                            rawKeyPrefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        links: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            scope: z.ZodOptional<z.ZodObject<{
                default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                    match: z.ZodOptional<z.ZodObject<{
                        channel: z.ZodOptional<z.ZodString>;
                        chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                        keyPrefix: z.ZodOptional<z.ZodString>;
                        rawKeyPrefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>;
            maxLinks: z.ZodOptional<z.ZodNumber>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            models: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodOptional<z.ZodLiteral<"cli">>;
                command: z.ZodString;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        sessions: z.ZodOptional<z.ZodObject<{
            visibility: z.ZodOptional<z.ZodEnum<{
                all: "all";
                agent: "agent";
                self: "self";
                tree: "tree";
            }>>;
        }, z.core.$strict>>;
        loopDetection: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            historySize: z.ZodOptional<z.ZodNumber>;
            warningThreshold: z.ZodOptional<z.ZodNumber>;
            unknownToolThreshold: z.ZodOptional<z.ZodNumber>;
            criticalThreshold: z.ZodOptional<z.ZodNumber>;
            globalCircuitBreakerThreshold: z.ZodOptional<z.ZodNumber>;
            detectors: z.ZodOptional<z.ZodObject<{
                genericRepeat: z.ZodOptional<z.ZodBoolean>;
                knownPollNoProgress: z.ZodOptional<z.ZodBoolean>;
                pingPong: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        message: z.ZodOptional<z.ZodObject<{
            allowCrossContextSend: z.ZodOptional<z.ZodBoolean>;
            crossContext: z.ZodOptional<z.ZodObject<{
                allowWithinProvider: z.ZodOptional<z.ZodBoolean>;
                allowAcrossProviders: z.ZodOptional<z.ZodBoolean>;
                marker: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    prefix: z.ZodOptional<z.ZodString>;
                    suffix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            broadcast: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        agentToAgent: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        elevated: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>;
        }, z.core.$strict>>;
        exec: z.ZodOptional<z.ZodObject<{
            host: z.ZodOptional<z.ZodEnum<{
                auto: "auto";
                sandbox: "sandbox";
                gateway: "gateway";
                node: "node";
            }>>;
            security: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                deny: "deny";
                full: "full";
            }>>;
            ask: z.ZodOptional<z.ZodEnum<{
                off: "off";
                "on-miss": "on-miss";
                always: "always";
            }>>;
            node: z.ZodOptional<z.ZodString>;
            pathPrepend: z.ZodOptional<z.ZodArray<z.ZodString>>;
            safeBins: z.ZodOptional<z.ZodArray<z.ZodString>>;
            strictInlineEval: z.ZodOptional<z.ZodBoolean>;
            safeBinTrustedDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            safeBinProfiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                minPositional: z.ZodOptional<z.ZodNumber>;
                maxPositional: z.ZodOptional<z.ZodNumber>;
                allowedValueFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deniedFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>;
            backgroundMs: z.ZodOptional<z.ZodNumber>;
            timeoutSec: z.ZodOptional<z.ZodNumber>;
            cleanupMs: z.ZodOptional<z.ZodNumber>;
            notifyOnExit: z.ZodOptional<z.ZodBoolean>;
            notifyOnExitEmptySuccess: z.ZodOptional<z.ZodBoolean>;
            applyPatch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                workspaceOnly: z.ZodOptional<z.ZodBoolean>;
                allowModels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        fs: z.ZodOptional<z.ZodObject<{
            workspaceOnly: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        subagents: z.ZodOptional<z.ZodObject<{
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        sandbox: z.ZodOptional<z.ZodObject<{
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        sessions_spawn: z.ZodOptional<z.ZodObject<{
            attachments: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                maxTotalBytes: z.ZodOptional<z.ZodNumber>;
                maxFiles: z.ZodOptional<z.ZodNumber>;
                maxFileBytes: z.ZodOptional<z.ZodNumber>;
                retainOnSessionKeep: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        experimental: z.ZodOptional<z.ZodObject<{
            planTool: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        byProvider: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    bindings: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodOptional<z.ZodLiteral<"route">>;
        agentId: z.ZodString;
        comment: z.ZodOptional<z.ZodString>;
        match: z.ZodObject<{
            channel: z.ZodString;
            accountId: z.ZodOptional<z.ZodString>;
            peer: z.ZodOptional<z.ZodObject<{
                kind: z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>;
                id: z.ZodString;
            }, z.core.$strict>>;
            guildId: z.ZodOptional<z.ZodString>;
            teamId: z.ZodOptional<z.ZodString>;
            roles: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"acp">;
        agentId: z.ZodString;
        comment: z.ZodOptional<z.ZodString>;
        match: z.ZodObject<{
            channel: z.ZodString;
            accountId: z.ZodOptional<z.ZodString>;
            peer: z.ZodOptional<z.ZodObject<{
                kind: z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>;
                id: z.ZodString;
            }, z.core.$strict>>;
            guildId: z.ZodOptional<z.ZodString>;
            teamId: z.ZodOptional<z.ZodString>;
            roles: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
        acp: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                persistent: "persistent";
                oneshot: "oneshot";
            }>>;
            label: z.ZodOptional<z.ZodString>;
            cwd: z.ZodOptional<z.ZodString>;
            backend: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>]>>>;
    broadcast: z.ZodOptional<z.ZodObject<{
        strategy: z.ZodOptional<z.ZodEnum<{
            parallel: "parallel";
            sequential: "sequential";
        }>>;
    }, z.core.$catchall<z.ZodArray<z.ZodString>>>>;
    audio: z.ZodOptional<z.ZodObject<{
        transcription: z.ZodOptional<z.ZodObject<{
            command: z.ZodArray<z.ZodString>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    media: z.ZodOptional<z.ZodObject<{
        preserveFilenames: z.ZodOptional<z.ZodBoolean>;
        ttlHours: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    messages: z.ZodOptional<z.ZodObject<{
        messagePrefix: z.ZodOptional<z.ZodString>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        groupChat: z.ZodOptional<z.ZodObject<{
            mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        queue: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
            byChannel: z.ZodOptional<z.ZodObject<{
                whatsapp: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                telegram: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                discord: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                irc: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                slack: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                mattermost: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                signal: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                imessage: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                msteams: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                webchat: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
            }, z.core.$strict>>;
            debounceMs: z.ZodOptional<z.ZodNumber>;
            debounceMsByChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            cap: z.ZodOptional<z.ZodNumber>;
            drop: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"old">, z.ZodLiteral<"new">, z.ZodLiteral<"summarize">]>>;
        }, z.core.$strict>>;
        inbound: z.ZodOptional<z.ZodObject<{
            debounceMs: z.ZodOptional<z.ZodNumber>;
            byChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        }, z.core.$strict>>;
        ackReaction: z.ZodOptional<z.ZodString>;
        ackReactionScope: z.ZodOptional<z.ZodEnum<{
            off: "off";
            direct: "direct";
            none: "none";
            all: "all";
            "group-mentions": "group-mentions";
            "group-all": "group-all";
        }>>;
        removeAckAfterReply: z.ZodOptional<z.ZodBoolean>;
        statusReactions: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            emojis: z.ZodOptional<z.ZodObject<{
                thinking: z.ZodOptional<z.ZodString>;
                tool: z.ZodOptional<z.ZodString>;
                coding: z.ZodOptional<z.ZodString>;
                web: z.ZodOptional<z.ZodString>;
                done: z.ZodOptional<z.ZodString>;
                error: z.ZodOptional<z.ZodString>;
                stallSoft: z.ZodOptional<z.ZodString>;
                stallHard: z.ZodOptional<z.ZodString>;
                compacting: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            timing: z.ZodOptional<z.ZodObject<{
                debounceMs: z.ZodOptional<z.ZodNumber>;
                stallSoftMs: z.ZodOptional<z.ZodNumber>;
                stallHardMs: z.ZodOptional<z.ZodNumber>;
                doneHoldMs: z.ZodOptional<z.ZodNumber>;
                errorHoldMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        suppressToolErrors: z.ZodOptional<z.ZodBoolean>;
        tts: z.ZodOptional<z.ZodObject<{
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
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    commands: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        native: z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>>;
        nativeSkills: z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>>;
        text: z.ZodOptional<z.ZodBoolean>;
        bash: z.ZodOptional<z.ZodBoolean>;
        bashForegroundMs: z.ZodOptional<z.ZodNumber>;
        config: z.ZodOptional<z.ZodBoolean>;
        mcp: z.ZodOptional<z.ZodBoolean>;
        plugins: z.ZodOptional<z.ZodBoolean>;
        debug: z.ZodOptional<z.ZodBoolean>;
        restart: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        useAccessGroups: z.ZodOptional<z.ZodBoolean>;
        ownerAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        ownerDisplay: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            raw: "raw";
            hash: "hash";
        }>>>;
        ownerDisplaySecret: z.ZodOptional<z.ZodString>;
        allowFrom: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>>;
    }, z.core.$strict>>>;
    approvals: z.ZodOptional<z.ZodObject<{
        exec: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"targets">, z.ZodLiteral<"both">]>>;
            agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            targets: z.ZodOptional<z.ZodArray<z.ZodObject<{
                channel: z.ZodString;
                to: z.ZodString;
                accountId: z.ZodOptional<z.ZodString>;
                threadId: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        plugin: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"targets">, z.ZodLiteral<"both">]>>;
            agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            targets: z.ZodOptional<z.ZodArray<z.ZodObject<{
                channel: z.ZodString;
                to: z.ZodString;
                accountId: z.ZodOptional<z.ZodString>;
                threadId: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    session: z.ZodOptional<z.ZodObject<{
        scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"per-sender">, z.ZodLiteral<"global">]>>;
        dmScope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"main">, z.ZodLiteral<"per-peer">, z.ZodLiteral<"per-channel-peer">, z.ZodLiteral<"per-account-channel-peer">]>>;
        identityLinks: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        resetTriggers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        idleMinutes: z.ZodOptional<z.ZodNumber>;
        reset: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
            atHour: z.ZodOptional<z.ZodNumber>;
            idleMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        resetByType: z.ZodOptional<z.ZodObject<{
            direct: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            dm: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            group: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            thread: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        resetByChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
            atHour: z.ZodOptional<z.ZodNumber>;
            idleMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
        store: z.ZodOptional<z.ZodString>;
        typingIntervalSeconds: z.ZodOptional<z.ZodNumber>;
        typingMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"never">, z.ZodLiteral<"instant">, z.ZodLiteral<"thinking">, z.ZodLiteral<"message">]>>;
        parentForkMaxTokens: z.ZodOptional<z.ZodNumber>;
        mainKey: z.ZodOptional<z.ZodString>;
        sendPolicy: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
            rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                match: z.ZodOptional<z.ZodObject<{
                    channel: z.ZodOptional<z.ZodString>;
                    chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                    keyPrefix: z.ZodOptional<z.ZodString>;
                    rawKeyPrefix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>>;
        agentToAgent: z.ZodOptional<z.ZodObject<{
            maxPingPongTurns: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        threadBindings: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            idleHours: z.ZodOptional<z.ZodNumber>;
            maxAgeHours: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        maintenance: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                enforce: "enforce";
                warn: "warn";
            }>>;
            pruneAfter: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            pruneDays: z.ZodOptional<z.ZodNumber>;
            maxEntries: z.ZodOptional<z.ZodNumber>;
            rotateBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            resetArchiveRetention: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodLiteral<false>]>>;
            maxDiskBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            highWaterBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    cron: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        store: z.ZodOptional<z.ZodString>;
        maxConcurrentRuns: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodOptional<z.ZodObject<{
            maxAttempts: z.ZodOptional<z.ZodNumber>;
            backoffMs: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
            retryOn: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                timeout: "timeout";
                network: "network";
                rate_limit: "rate_limit";
                overloaded: "overloaded";
                server_error: "server_error";
            }>>>;
        }, z.core.$strict>>;
        webhook: z.ZodOptional<z.ZodString>;
        webhookToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        sessionRetention: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodLiteral<false>]>>;
        runLog: z.ZodOptional<z.ZodObject<{
            maxBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            keepLines: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        failureAlert: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            after: z.ZodOptional<z.ZodNumber>;
            cooldownMs: z.ZodOptional<z.ZodNumber>;
            mode: z.ZodOptional<z.ZodEnum<{
                announce: "announce";
                webhook: "webhook";
            }>>;
            accountId: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        failureDestination: z.ZodOptional<z.ZodObject<{
            channel: z.ZodOptional<z.ZodString>;
            to: z.ZodOptional<z.ZodString>;
            accountId: z.ZodOptional<z.ZodString>;
            mode: z.ZodOptional<z.ZodEnum<{
                announce: "announce";
                webhook: "webhook";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    hooks: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        token: z.ZodOptional<z.ZodString>;
        defaultSessionKey: z.ZodOptional<z.ZodString>;
        allowRequestSessionKey: z.ZodOptional<z.ZodBoolean>;
        allowedSessionKeyPrefixes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        allowedAgentIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        maxBodyBytes: z.ZodOptional<z.ZodNumber>;
        presets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        transformsDir: z.ZodOptional<z.ZodString>;
        mappings: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            match: z.ZodOptional<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            action: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"wake">, z.ZodLiteral<"agent">]>>;
            wakeMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"now">, z.ZodLiteral<"next-heartbeat">]>>;
            name: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            sessionKey: z.ZodOptional<z.ZodString>;
            messageTemplate: z.ZodOptional<z.ZodString>;
            textTemplate: z.ZodOptional<z.ZodString>;
            deliver: z.ZodOptional<z.ZodBoolean>;
            allowUnsafeExternalContent: z.ZodOptional<z.ZodBoolean>;
            channel: z.ZodOptional<z.ZodString>;
            to: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            thinking: z.ZodOptional<z.ZodString>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            transform: z.ZodOptional<z.ZodObject<{
                module: z.ZodString;
                export: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        gmail: z.ZodOptional<z.ZodObject<{
            account: z.ZodOptional<z.ZodString>;
            label: z.ZodOptional<z.ZodString>;
            topic: z.ZodOptional<z.ZodString>;
            subscription: z.ZodOptional<z.ZodString>;
            pushToken: z.ZodOptional<z.ZodString>;
            hookUrl: z.ZodOptional<z.ZodString>;
            includeBody: z.ZodOptional<z.ZodBoolean>;
            maxBytes: z.ZodOptional<z.ZodNumber>;
            renewEveryMinutes: z.ZodOptional<z.ZodNumber>;
            allowUnsafeExternalContent: z.ZodOptional<z.ZodBoolean>;
            serve: z.ZodOptional<z.ZodObject<{
                bind: z.ZodOptional<z.ZodString>;
                port: z.ZodOptional<z.ZodNumber>;
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            tailscale: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"serve">, z.ZodLiteral<"funnel">]>>;
                path: z.ZodOptional<z.ZodString>;
                target: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            model: z.ZodOptional<z.ZodString>;
            thinking: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"minimal">, z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>;
        }, z.core.$strict>>;
        internal: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            handlers: z.ZodOptional<z.ZodArray<z.ZodObject<{
                event: z.ZodString;
                module: z.ZodString;
                export: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            entries: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            }, z.core.$loose>>>;
            load: z.ZodOptional<z.ZodObject<{
                extraDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            installs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                hooks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                source: z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"archive">, z.ZodLiteral<"path">, z.ZodLiteral<"clawhub">]>;
                spec: z.ZodOptional<z.ZodString>;
                sourcePath: z.ZodOptional<z.ZodString>;
                installPath: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                resolvedName: z.ZodOptional<z.ZodString>;
                resolvedVersion: z.ZodOptional<z.ZodString>;
                resolvedSpec: z.ZodOptional<z.ZodString>;
                integrity: z.ZodOptional<z.ZodString>;
                shasum: z.ZodOptional<z.ZodString>;
                resolvedAt: z.ZodOptional<z.ZodString>;
                installedAt: z.ZodOptional<z.ZodString>;
                clawhubUrl: z.ZodOptional<z.ZodString>;
                clawhubPackage: z.ZodOptional<z.ZodString>;
                clawhubFamily: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"code-plugin">, z.ZodLiteral<"bundle-plugin">]>>;
                clawhubChannel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"official">, z.ZodLiteral<"community">, z.ZodLiteral<"private">]>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    web: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        heartbeatSeconds: z.ZodOptional<z.ZodNumber>;
        reconnect: z.ZodOptional<z.ZodObject<{
            initialMs: z.ZodOptional<z.ZodNumber>;
            maxMs: z.ZodOptional<z.ZodNumber>;
            factor: z.ZodOptional<z.ZodNumber>;
            jitter: z.ZodOptional<z.ZodNumber>;
            maxAttempts: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    channels: z.ZodType<import("./types.channels.js").ChannelsConfig | undefined, unknown, z.core.$ZodTypeInternals<import("./types.channels.js").ChannelsConfig | undefined, unknown>>;
    discovery: z.ZodOptional<z.ZodObject<{
        wideArea: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            domain: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        mdns: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                full: "full";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    canvasHost: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        root: z.ZodOptional<z.ZodString>;
        port: z.ZodOptional<z.ZodNumber>;
        liveReload: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    talk: z.ZodOptional<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
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
        }, z.core.$catchall<z.ZodUnknown>>>>;
        speechLocale: z.ZodOptional<z.ZodString>;
        interruptOnSpeech: z.ZodOptional<z.ZodBoolean>;
        silenceTimeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    gateway: z.ZodOptional<z.ZodObject<{
        port: z.ZodOptional<z.ZodNumber>;
        mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"local">, z.ZodLiteral<"remote">]>>;
        bind: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"lan">, z.ZodLiteral<"loopback">, z.ZodLiteral<"custom">, z.ZodLiteral<"tailnet">]>>;
        customBindHost: z.ZodOptional<z.ZodString>;
        controlUi: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            basePath: z.ZodOptional<z.ZodString>;
            root: z.ZodOptional<z.ZodString>;
            embedSandbox: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"strict">, z.ZodLiteral<"scripts">, z.ZodLiteral<"trusted">]>>;
            allowExternalEmbedUrls: z.ZodOptional<z.ZodBoolean>;
            allowedOrigins: z.ZodOptional<z.ZodArray<z.ZodString>>;
            dangerouslyAllowHostHeaderOriginFallback: z.ZodOptional<z.ZodBoolean>;
            allowInsecureAuth: z.ZodOptional<z.ZodBoolean>;
            dangerouslyDisableDeviceAuth: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        auth: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"token">, z.ZodLiteral<"password">, z.ZodLiteral<"trusted-proxy">]>>;
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
            allowTailscale: z.ZodOptional<z.ZodBoolean>;
            rateLimit: z.ZodOptional<z.ZodObject<{
                maxAttempts: z.ZodOptional<z.ZodNumber>;
                windowMs: z.ZodOptional<z.ZodNumber>;
                lockoutMs: z.ZodOptional<z.ZodNumber>;
                exemptLoopback: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            trustedProxy: z.ZodOptional<z.ZodObject<{
                userHeader: z.ZodString;
                requiredHeaders: z.ZodOptional<z.ZodArray<z.ZodString>>;
                allowUsers: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        trustedProxies: z.ZodOptional<z.ZodArray<z.ZodString>>;
        allowRealIpFallback: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        webchat: z.ZodOptional<z.ZodObject<{
            chatHistoryMaxChars: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        channelHealthCheckMinutes: z.ZodOptional<z.ZodNumber>;
        channelStaleEventThresholdMinutes: z.ZodOptional<z.ZodNumber>;
        channelMaxRestartsPerHour: z.ZodOptional<z.ZodNumber>;
        tailscale: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"serve">, z.ZodLiteral<"funnel">]>>;
            resetOnExit: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        remote: z.ZodOptional<z.ZodObject<{
            url: z.ZodOptional<z.ZodString>;
            transport: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"ssh">, z.ZodLiteral<"direct">]>>;
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
            tlsFingerprint: z.ZodOptional<z.ZodString>;
            sshTarget: z.ZodOptional<z.ZodString>;
            sshIdentity: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        reload: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"restart">, z.ZodLiteral<"hot">, z.ZodLiteral<"hybrid">]>>;
            debounceMs: z.ZodOptional<z.ZodNumber>;
            deferralTimeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        tls: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            autoGenerate: z.ZodOptional<z.ZodBoolean>;
            certPath: z.ZodOptional<z.ZodString>;
            keyPath: z.ZodOptional<z.ZodString>;
            caPath: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        http: z.ZodOptional<z.ZodObject<{
            endpoints: z.ZodOptional<z.ZodObject<{
                chatCompletions: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxBodyBytes: z.ZodOptional<z.ZodNumber>;
                    maxImageParts: z.ZodOptional<z.ZodNumber>;
                    maxTotalImageBytes: z.ZodOptional<z.ZodNumber>;
                    images: z.ZodOptional<z.ZodObject<{
                        allowUrl: z.ZodOptional<z.ZodBoolean>;
                        urlAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        allowedMimes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        maxBytes: z.ZodOptional<z.ZodNumber>;
                        maxRedirects: z.ZodOptional<z.ZodNumber>;
                        timeoutMs: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                responses: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxBodyBytes: z.ZodOptional<z.ZodNumber>;
                    maxUrlParts: z.ZodOptional<z.ZodNumber>;
                    files: z.ZodOptional<z.ZodObject<{
                        maxChars: z.ZodOptional<z.ZodNumber>;
                        pdf: z.ZodOptional<z.ZodObject<{
                            maxPages: z.ZodOptional<z.ZodNumber>;
                            maxPixels: z.ZodOptional<z.ZodNumber>;
                            minTextChars: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        allowUrl: z.ZodOptional<z.ZodBoolean>;
                        urlAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        allowedMimes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        maxBytes: z.ZodOptional<z.ZodNumber>;
                        maxRedirects: z.ZodOptional<z.ZodNumber>;
                        timeoutMs: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    images: z.ZodOptional<z.ZodObject<{
                        allowUrl: z.ZodOptional<z.ZodBoolean>;
                        urlAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        allowedMimes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        maxBytes: z.ZodOptional<z.ZodNumber>;
                        maxRedirects: z.ZodOptional<z.ZodNumber>;
                        timeoutMs: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            securityHeaders: z.ZodOptional<z.ZodObject<{
                strictTransportSecurity: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodLiteral<false>]>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        push: z.ZodOptional<z.ZodObject<{
            apns: z.ZodOptional<z.ZodObject<{
                relay: z.ZodOptional<z.ZodObject<{
                    baseUrl: z.ZodOptional<z.ZodString>;
                    timeoutMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        nodes: z.ZodOptional<z.ZodObject<{
            browser: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"manual">, z.ZodLiteral<"off">]>>;
                node: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            pairing: z.ZodOptional<z.ZodObject<{
                autoApproveCidrs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            allowCommands: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyCommands: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    memory: z.ZodOptional<z.ZodObject<{
        backend: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"builtin">, z.ZodLiteral<"qmd">]>>;
        citations: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
        qmd: z.ZodOptional<z.ZodObject<{
            command: z.ZodOptional<z.ZodString>;
            mcporter: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                serverName: z.ZodOptional<z.ZodString>;
                startDaemon: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            searchMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"query">, z.ZodLiteral<"search">, z.ZodLiteral<"vsearch">]>>;
            searchTool: z.ZodOptional<z.ZodString>;
            includeDefaultMemory: z.ZodOptional<z.ZodBoolean>;
            paths: z.ZodOptional<z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                pattern: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            sessions: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                exportDir: z.ZodOptional<z.ZodString>;
                retentionDays: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            update: z.ZodOptional<z.ZodObject<{
                interval: z.ZodOptional<z.ZodString>;
                debounceMs: z.ZodOptional<z.ZodNumber>;
                onBoot: z.ZodOptional<z.ZodBoolean>;
                waitForBootSync: z.ZodOptional<z.ZodBoolean>;
                embedInterval: z.ZodOptional<z.ZodString>;
                commandTimeoutMs: z.ZodOptional<z.ZodNumber>;
                updateTimeoutMs: z.ZodOptional<z.ZodNumber>;
                embedTimeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            limits: z.ZodOptional<z.ZodObject<{
                maxResults: z.ZodOptional<z.ZodNumber>;
                maxSnippetChars: z.ZodOptional<z.ZodNumber>;
                maxInjectedChars: z.ZodOptional<z.ZodNumber>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                    match: z.ZodOptional<z.ZodObject<{
                        channel: z.ZodOptional<z.ZodString>;
                        chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                        keyPrefix: z.ZodOptional<z.ZodString>;
                        rawKeyPrefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    mcp: z.ZodOptional<z.ZodObject<{
        servers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            command: z.ZodOptional<z.ZodString>;
            args: z.ZodOptional<z.ZodArray<z.ZodString>>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
            cwd: z.ZodOptional<z.ZodString>;
            workingDirectory: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodString>;
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
        }, z.core.$catchall<z.ZodUnknown>>>>;
        sessionIdleTtlMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    skills: z.ZodOptional<z.ZodObject<{
        allowBundled: z.ZodOptional<z.ZodArray<z.ZodString>>;
        load: z.ZodOptional<z.ZodObject<{
            extraDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            watch: z.ZodOptional<z.ZodBoolean>;
            watchDebounceMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        install: z.ZodOptional<z.ZodObject<{
            preferBrew: z.ZodOptional<z.ZodBoolean>;
            nodeManager: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"pnpm">, z.ZodLiteral<"yarn">, z.ZodLiteral<"bun">]>>;
        }, z.core.$strict>>;
        limits: z.ZodOptional<z.ZodObject<{
            maxCandidatesPerRoot: z.ZodOptional<z.ZodNumber>;
            maxSkillsLoadedPerSource: z.ZodOptional<z.ZodNumber>;
            maxSkillsInPrompt: z.ZodOptional<z.ZodNumber>;
            maxSkillsPromptChars: z.ZodOptional<z.ZodNumber>;
            maxSkillFileBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        entries: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
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
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    plugins: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        load: z.ZodOptional<z.ZodObject<{
            paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        slots: z.ZodOptional<z.ZodObject<{
            memory: z.ZodOptional<z.ZodString>;
            contextEngine: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        entries: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            hooks: z.ZodOptional<z.ZodObject<{
                allowPromptInjection: z.ZodOptional<z.ZodBoolean>;
                allowConversationAccess: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            subagent: z.ZodOptional<z.ZodObject<{
                allowModelOverride: z.ZodOptional<z.ZodBoolean>;
                allowedModels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strict>>>;
        installs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            source: z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"archive">, z.ZodLiteral<"path">, z.ZodLiteral<"clawhub">]>, z.ZodLiteral<"marketplace">]>;
            marketplaceName: z.ZodOptional<z.ZodString>;
            marketplaceSource: z.ZodOptional<z.ZodString>;
            marketplacePlugin: z.ZodOptional<z.ZodString>;
            spec: z.ZodOptional<z.ZodString>;
            sourcePath: z.ZodOptional<z.ZodString>;
            installPath: z.ZodOptional<z.ZodString>;
            version: z.ZodOptional<z.ZodString>;
            resolvedName: z.ZodOptional<z.ZodString>;
            resolvedVersion: z.ZodOptional<z.ZodString>;
            resolvedSpec: z.ZodOptional<z.ZodString>;
            integrity: z.ZodOptional<z.ZodString>;
            shasum: z.ZodOptional<z.ZodString>;
            resolvedAt: z.ZodOptional<z.ZodString>;
            installedAt: z.ZodOptional<z.ZodString>;
            clawhubUrl: z.ZodOptional<z.ZodString>;
            clawhubPackage: z.ZodOptional<z.ZodString>;
            clawhubFamily: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"code-plugin">, z.ZodLiteral<"bundle-plugin">]>>;
            clawhubChannel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"official">, z.ZodLiteral<"community">, z.ZodLiteral<"private">]>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    surfaces: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        silentReply: z.ZodOptional<z.ZodObject<{
            direct: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
            group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
            internal: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
        }, z.core.$strict>>;
        silentReplyRewrite: z.ZodOptional<z.ZodObject<{
            direct: z.ZodOptional<z.ZodBoolean>;
            group: z.ZodOptional<z.ZodBoolean>;
            internal: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;

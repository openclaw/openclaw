import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

type ProviderUnderTest =
	| "brave"
	| "gemini"
	| "grok"
	| "kimi"
	| "perplexity"
	| "duckduckgo";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
	resolvePluginWebSearchProvidersMock: vi.fn(() =>
		buildTestWebSearchProviders(),
	),
}));

const { resolveBundledPluginWebSearchProvidersMock } = vi.hoisted(() => ({
	resolveBundledPluginWebSearchProvidersMock: vi.fn(() =>
		buildTestWebSearchProviders(),
	),
}));

const mockedModuleIds = [
	"../plugins/web-search-providers.js",
	"../plugins/web-search-providers.runtime.js",
] as const;

let bundledWebSearchProviders: typeof import("../plugins/web-search-providers.js");
let runtimeWebSearchProviders: typeof import("../plugins/web-search-providers.runtime.js");
let secretResolve: typeof import("./resolve.js");
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;

vi.mock("../plugins/web-search-providers.js", () => ({
	resolveBundledPluginWebSearchProviders:
		resolveBundledPluginWebSearchProvidersMock,
}));

vi.mock(
	"../plugins/web-search-providers.runtime.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../plugins/web-search-providers.runtime.js")
			>();
		return {
			...actual,
			resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
		};
	},
);

function asConfig(value: unknown): OpenClawConfig {
	return value as OpenClawConfig;
}

function providerPluginId(provider: ProviderUnderTest): string {
	switch (provider) {
		case "duckduckgo":
			return "duckduckgo";
		case "gemini":
			return "google";
		case "grok":
			return "xai";
		case "kimi":
			return "moonshot";
		default:
			return provider;
	}
}

function ensureRecord(
	target: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const current = target[key];
	if (
		typeof current === "object" &&
		current !== null &&
		!Array.isArray(current)
	) {
		return current as Record<string, unknown>;
	}
	const next: Record<string, unknown> = {};
	target[key] = next;
	return next;
}

function setConfiguredProviderKey(
	configTarget: OpenClawConfig,
	pluginId: string,
	value: unknown,
): void {
	const plugins = ensureRecord(
		configTarget as Record<string, unknown>,
		"plugins",
	);
	const entries = ensureRecord(plugins, "entries");
	const pluginEntry = ensureRecord(entries, pluginId);
	const config = ensureRecord(pluginEntry, "config");
	const webSearch = ensureRecord(config, "webSearch");
	webSearch.apiKey = value;
}

function createTestProvider(params: {
	provider: ProviderUnderTest;
	pluginId: string;
	order: number;
}): PluginWebSearchProviderEntry {
	const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
	return {
		pluginId: params.pluginId,
		id: params.provider,
		label: params.provider,
		hint: `${params.provider} test provider`,
		requiresCredential: params.provider === "duckduckgo" ? false : undefined,
		envVars:
			params.provider === "duckduckgo"
				? []
				: [`${params.provider.toUpperCase()}_API_KEY`],
		placeholder:
			params.provider === "duckduckgo"
				? "(no key needed)"
				: `${params.provider}-...`,
		signupUrl: `https://example.com/${params.provider}`,
		autoDetectOrder: params.order,
		credentialPath: params.provider === "duckduckgo" ? "" : credentialPath,
		inactiveSecretPaths:
			params.provider === "duckduckgo" ? [] : [credentialPath],
		getCredentialValue: (searchConfig) =>
			params.provider === "duckduckgo"
				? "duckduckgo-no-key-needed"
				: searchConfig?.apiKey,
		setCredentialValue: (searchConfigTarget, value) => {
			searchConfigTarget.apiKey = value;
		},
		getConfiguredCredentialValue: (config) => {
			const entryConfig = config?.plugins?.entries?.[params.pluginId]?.config;
			return entryConfig && typeof entryConfig === "object"
				? (entryConfig as { webSearch?: { apiKey?: unknown } }).webSearch
						?.apiKey
				: undefined;
		},
		setConfiguredCredentialValue: (configTarget, value) => {
			setConfiguredProviderKey(configTarget, params.pluginId, value);
		},
		resolveRuntimeMetadata:
			params.provider === "perplexity"
				? () => ({
						perplexityTransport: "search_api" as const,
					})
				: undefined,
		createTool: () => null,
	};
}

function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
	return [
		createTestProvider({ provider: "brave", pluginId: "brave", order: 10 }),
		createTestProvider({ provider: "gemini", pluginId: "google", order: 20 }),
		createTestProvider({ provider: "grok", pluginId: "xai", order: 30 }),
		createTestProvider({ provider: "kimi", pluginId: "moonshot", order: 40 }),
		createTestProvider({
			provider: "perplexity",
			pluginId: "perplexity",
			order: 50,
		}),
		createTestProvider({
			provider: "duckduckgo",
			pluginId: "duckduckgo",
			order: 100,
		}),
	];
}

async function runRuntimeWebTools(params: {
	config: OpenClawConfig;
	env?: NodeJS.ProcessEnv;
}) {
	const sourceConfig = structuredClone(params.config);
	const resolvedConfig = structuredClone(params.config);
	const context = createResolverContext({
		sourceConfig,
		env: params.env ?? {},
	});
	const metadata = await resolveRuntimeWebTools({
		sourceConfig,
		resolvedConfig,
		context,
	});
	return { metadata, resolvedConfig, context };
}

function createProviderSecretRefConfig(
	provider: ProviderUnderTest,
	envRefId: string,
): OpenClawConfig {
	return asConfig({
		tools: {
			web: {
				search: {
					enabled: true,
					provider,
				},
			},
		},
		plugins: {
			entries: {
				[providerPluginId(provider)]: {
					enabled: true,
					config: {
						webSearch: {
							apiKey: { source: "env", provider: "default", id: envRefId },
						},
					},
				},
			},
		},
	});
}

function readProviderKey(
	config: OpenClawConfig,
	provider: ProviderUnderTest,
): unknown {
	const pluginConfig = config.plugins?.entries?.[providerPluginId(provider)]
		?.config as { webSearch?: { apiKey?: unknown } } | undefined;
	return pluginConfig?.webSearch?.apiKey;
}

function expectInactiveFirecrawlSecretRef(params: {
	resolveSpy: ReturnType<typeof vi.spyOn>;
	metadata: Awaited<ReturnType<typeof runRuntimeWebTools>>["metadata"];
	context: Awaited<ReturnType<typeof runRuntimeWebTools>>["context"];
}) {
	expect(params.resolveSpy).not.toHaveBeenCalled();
	expect(params.metadata.fetch.firecrawl.active).toBe(false);
	expect(params.metadata.fetch.firecrawl.apiKeySource).toBe("secretRef");
	expect(params.context.warnings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
				path: "tools.web.fetch.firecrawl.apiKey",
			}),
		]),
	);
}

describe("runtime web tools resolution", () => {
	beforeAll(async () => {
		vi.resetModules();
		bundledWebSearchProviders = await import(
			"../plugins/web-search-providers.js"
		);
		runtimeWebSearchProviders = await import(
			"../plugins/web-search-providers.runtime.js"
		);
		secretResolve = await import("./resolve.js");
		({ createResolverContext } = await import("./runtime-shared.js"));
		({ resolveRuntimeWebTools } = await import("./runtime-web-tools.js"));
	});

	beforeEach(() => {
		runtimeWebSearchProviders.__testing.resetWebSearchProviderSnapshotCacheForTests();
		vi.mocked(
			bundledWebSearchProviders.resolveBundledPluginWebSearchProviders,
		).mockClear();
		vi.mocked(
			runtimeWebSearchProviders.resolvePluginWebSearchProviders,
		).mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		for (const id of mockedModuleIds) {
			vi.doUnmock(id);
		}
	});

	it("keeps web search disabled when search config is absent", async () => {
		const bundledProviderSpy = vi.mocked(
			bundledWebSearchProviders.resolveBundledPluginWebSearchProviders,
		);
		const runtimeProviderSpy = vi.mocked(
			runtimeWebSearchProviders.resolvePluginWebSearchProviders,
		);

		const { metadata } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						fetch: {
							firecrawl: {
								apiKey: {
									source: "env",
									provider: "default",
									id: "FIRECRAWL_API_KEY_REF",
								},
							},
						},
					},
				},
			}),
			env: {
				FIRECRAWL_API_KEY: "firecrawl-runtime-key", // pragma: allowlist secret
			},
		});

		expect(bundledProviderSpy).not.toHaveBeenCalled();
		expect(runtimeProviderSpy).not.toHaveBeenCalled();
		expect(metadata.search.selectedProvider).toBeUndefined();
		expect(metadata.search.providerSource).toBe("none");
		expect(metadata.fetch.firecrawl.active).toBe(true);
		expect(metadata.fetch.firecrawl.apiKeySource).toBe("env");
	});

	it("auto-selects a keyless provider when no credentials are configured", async () => {
		const { metadata } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						search: {
							enabled: true,
						},
					},
				},
			}),
		});

		expect(metadata.search.selectedProvider).toBe("duckduckgo");
		expect(metadata.search.providerSource).toBe("auto-detect");
		expect(metadata.search.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "WEB_SEARCH_AUTODETECT_SELECTED",
					message: expect.stringContaining('keyless provider "duckduckgo"'),
				}),
			]),
		);
	});

	it.each([
		{
			provider: "brave" as const,
			envRefId: "BRAVE_PROVIDER_REF",
			resolvedKey: "brave-provider-key",
		},
		{
			provider: "gemini" as const,
			envRefId: "GEMINI_PROVIDER_REF",
			resolvedKey: "gemini-provider-key",
		},
		{
			provider: "grok" as const,
			envRefId: "GROK_PROVIDER_REF",
			resolvedKey: "grok-provider-key",
		},
		{
			provider: "kimi" as const,
			envRefId: "KIMI_PROVIDER_REF",
			resolvedKey: "kimi-provider-key",
		},
		{
			provider: "perplexity" as const,
			envRefId: "PERPLEXITY_PROVIDER_REF",
			resolvedKey: "pplx-provider-key",
		},
	])("resolves configured provider SecretRef for $provider", async ({
		provider,
		envRefId,
		resolvedKey,
	}) => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: createProviderSecretRefConfig(provider, envRefId),
			env: {
				[envRefId]: resolvedKey,
			},
		});

		expect(metadata.search.providerConfigured).toBe(provider);
		expect(metadata.search.providerSource).toBe("configured");
		expect(metadata.search.selectedProvider).toBe(provider);
		expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
		expect(readProviderKey(resolvedConfig, provider)).toBe(resolvedKey);
		expect(context.warnings.map((warning) => warning.code)).not.toContain(
			"WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
		);
		if (provider === "perplexity") {
			expect(metadata.search.perplexityTransport).toBe("search_api");
		}
	});

	it("auto-detects provider precedence across all configured providers", async () => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						search: {
							enabled: true,
						},
					},
				},
				plugins: {
					entries: {
						brave: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "BRAVE_REF",
									},
								},
							},
						},
						google: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "GEMINI_REF",
									},
								},
							},
						},
						xai: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "GROK_REF",
									},
								},
							},
						},
						moonshot: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "KIMI_REF",
									},
								},
							},
						},
						perplexity: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "PERPLEXITY_REF",
									},
								},
							},
						},
					},
				},
			}),
			env: {
				BRAVE_REF: "brave-precedence-key",
				GEMINI_REF: "gemini-precedence-key",
				GROK_REF: "grok-precedence-key",
				KIMI_REF: "kimi-precedence-key",
				PERPLEXITY_REF: "pplx-precedence-key",
			},
		});

		expect(metadata.search.providerSource).toBe("auto-detect");
		expect(metadata.search.selectedProvider).toBe("brave");
		expect(readProviderKey(resolvedConfig, "brave")).toBe(
			"brave-precedence-key",
		);
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "plugins.entries.google.config.webSearch.apiKey",
				}),
				expect.objectContaining({
					path: "plugins.entries.xai.config.webSearch.apiKey",
				}),
				expect.objectContaining({
					path: "plugins.entries.moonshot.config.webSearch.apiKey",
				}),
				expect.objectContaining({
					path: "plugins.entries.perplexity.config.webSearch.apiKey",
				}),
			]),
		);
	});

	it("auto-detects first available provider and keeps lower-priority refs inactive", async () => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						search: {
							enabled: true,
						},
					},
				},
				plugins: {
					entries: {
						brave: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "BRAVE_API_KEY_REF",
									},
								},
							},
						},
						google: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "MISSING_GEMINI_API_KEY_REF",
									},
								},
							},
						},
					},
				},
			}),
			env: {
				BRAVE_API_KEY_REF: "brave-runtime-key", // pragma: allowlist secret
			},
		});

		expect(metadata.search.providerSource).toBe("auto-detect");
		expect(metadata.search.selectedProvider).toBe("brave");
		expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
		expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-runtime-key");
		expect(readProviderKey(resolvedConfig, "gemini")).toEqual({
			source: "env",
			provider: "default",
			id: "MISSING_GEMINI_API_KEY_REF",
		});
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
					path: "plugins.entries.google.config.webSearch.apiKey",
				}),
			]),
		);
		expect(context.warnings.map((warning) => warning.code)).not.toContain(
			"WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
		);
	});

	it("auto-detects the next provider when a higher-priority ref is unresolved", async () => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						search: {
							enabled: true,
						},
					},
				},
				plugins: {
					entries: {
						brave: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "MISSING_BRAVE_API_KEY_REF",
									},
								},
							},
						},
						google: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "GEMINI_API_KEY_REF",
									},
								},
							},
						},
					},
				},
			}),
			env: {
				GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
			},
		});

		expect(metadata.search.providerSource).toBe("auto-detect");
		expect(metadata.search.selectedProvider).toBe("gemini");
		expect(readProviderKey(resolvedConfig, "gemini")).toBe(
			"gemini-runtime-key",
		);
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
					path: "plugins.entries.brave.config.webSearch.apiKey",
				}),
			]),
		);
		expect(context.warnings.map((warning) => warning.code)).not.toContain(
			"WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
		);
	});

	it("warns when provider is invalid and falls back to auto-detect", async () => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						search: {
							provider: "invalid-provider",
						},
					},
				},
				plugins: {
					entries: {
						google: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "GEMINI_API_KEY_REF",
									},
								},
							},
						},
					},
				},
			}),
			env: {
				GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
			},
		});

		expect(metadata.search.providerConfigured).toBeUndefined();
		expect(metadata.search.providerSource).toBe("auto-detect");
		expect(metadata.search.selectedProvider).toBe("gemini");
		expect(readProviderKey(resolvedConfig, "gemini")).toBe(
			"gemini-runtime-key",
		);
		expect(metadata.search.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
					path: "tools.web.search.provider",
				}),
			]),
		);
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
					path: "tools.web.search.provider",
				}),
			]),
		);
	});

	it("fails fast when configured provider ref is unresolved with no fallback", async () => {
		const sourceConfig = asConfig({
			tools: {
				web: {
					search: {
						provider: "gemini",
					},
				},
			},
			plugins: {
				entries: {
					google: {
						enabled: true,
						config: {
							webSearch: {
								apiKey: {
									source: "env",
									provider: "default",
									id: "MISSING_GEMINI_API_KEY_REF",
								},
							},
						},
					},
				},
			},
		});
		const resolvedConfig = structuredClone(sourceConfig);
		const context = createResolverContext({
			sourceConfig,
			env: {},
		});

		await expect(
			resolveRuntimeWebTools({
				sourceConfig,
				resolvedConfig,
				context,
			}),
		).rejects.toThrow("[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]");
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
					path: "plugins.entries.google.config.webSearch.apiKey",
				}),
			]),
		);
	});

	it("uses bundled provider resolution for configured bundled providers", async () => {
		const bundledSpy = vi.mocked(
			bundledWebSearchProviders.resolveBundledPluginWebSearchProviders,
		);
		const genericSpy = vi.mocked(
			runtimeWebSearchProviders.resolvePluginWebSearchProviders,
		);

		const { metadata } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						search: {
							enabled: true,
							provider: "gemini",
						},
					},
				},
				plugins: {
					entries: {
						google: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "GEMINI_PROVIDER_REF",
									},
								},
							},
						},
					},
				},
			}),
			env: {
				GEMINI_PROVIDER_REF: "gemini-provider-key",
			},
		});

		expect(metadata.search.selectedProvider).toBe("gemini");
		expect(bundledSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				bundledAllowlistCompat: true,
				onlyPluginIds: ["google"],
			}),
		);
		expect(genericSpy).not.toHaveBeenCalled();
	});

	it("does not resolve Firecrawl SecretRef when Firecrawl is inactive", async () => {
		const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
		const { metadata, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						fetch: {
							enabled: false,
							firecrawl: {
								apiKey: {
									source: "env",
									provider: "default",
									id: "MISSING_FIRECRAWL_REF",
								},
							},
						},
					},
				},
			}),
		});

		expectInactiveFirecrawlSecretRef({ resolveSpy, metadata, context });
	});

	it("does not resolve Firecrawl SecretRef when Firecrawl is disabled", async () => {
		const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
		const { metadata, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						fetch: {
							enabled: true,
							firecrawl: {
								enabled: false,
								apiKey: {
									source: "env",
									provider: "default",
									id: "MISSING_FIRECRAWL_REF",
								},
							},
						},
					},
				},
			}),
		});

		expectInactiveFirecrawlSecretRef({ resolveSpy, metadata, context });
	});

	it("keeps configured provider metadata and inactive warnings when search is disabled", async () => {
		const { metadata, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						search: {
							enabled: false,
							provider: "gemini",
						},
					},
				},
				plugins: {
					entries: {
						google: {
							enabled: true,
							config: {
								webSearch: {
									apiKey: {
										source: "env",
										provider: "default",
										id: "GEMINI_PROVIDER_REF",
									},
								},
							},
						},
					},
				},
			}),
		});

		expect(metadata.search.providerConfigured).toBe("gemini");
		expect(metadata.search.providerSource).toBe("configured");
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
					path: "plugins.entries.google.config.webSearch.apiKey",
				}),
			]),
		);
	});

	it("does not auto-enable search when tools.web.search is absent", async () => {
		const { metadata } = await runRuntimeWebTools({
			config: asConfig({}),
		});

		expect(metadata.search.providerSource).toBe("none");
		expect(metadata.search.selectedProvider).toBeUndefined();
	});

	it("uses env fallback for unresolved Firecrawl SecretRef when active", async () => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						fetch: {
							firecrawl: {
								apiKey: {
									source: "env",
									provider: "default",
									id: "MISSING_FIRECRAWL_REF",
								},
							},
						},
					},
				},
			}),
			env: {
				FIRECRAWL_API_KEY: "firecrawl-fallback-key", // pragma: allowlist secret
			},
		});

		expect(metadata.fetch.firecrawl.active).toBe(true);
		expect(metadata.fetch.firecrawl.apiKeySource).toBe("env");
		expect(resolvedConfig.tools?.web?.fetch?.firecrawl?.apiKey).toBe(
			"firecrawl-fallback-key",
		);
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_FALLBACK_USED",
					path: "tools.web.fetch.firecrawl.apiKey",
				}),
			]),
		);
	});

	it("fails fast when active Firecrawl SecretRef is unresolved with no fallback", async () => {
		const sourceConfig = asConfig({
			tools: {
				web: {
					fetch: {
						firecrawl: {
							apiKey: {
								source: "env",
								provider: "default",
								id: "MISSING_FIRECRAWL_REF",
							},
						},
					},
				},
			},
		});
		const resolvedConfig = structuredClone(sourceConfig);
		const context = createResolverContext({
			sourceConfig,
			env: {},
		});

		await expect(
			resolveRuntimeWebTools({
				sourceConfig,
				resolvedConfig,
				context,
			}),
		).rejects.toThrow("[WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK]");
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK",
					path: "tools.web.fetch.firecrawl.apiKey",
				}),
			]),
		);
	});

	it("resolves x_search SecretRef and writes the resolved key into runtime config", async () => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						x_search: {
							apiKey: {
								source: "env",
								provider: "default",
								id: "X_SEARCH_REF",
							},
						},
					},
				},
			}),
			env: {
				X_SEARCH_REF: "x-search-runtime-key",
			},
		});

		expect(metadata.xSearch.active).toBe(true);
		expect(metadata.xSearch.apiKeySource).toBe("secretRef");
		expect(resolvedConfig.tools?.web?.x_search?.apiKey).toBe(
			"x-search-runtime-key",
		);
		expect(context.warnings.map((warning) => warning.code)).not.toContain(
			"WEB_X_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
		);
	});

	it("uses env fallback for unresolved x_search SecretRef when active", async () => {
		const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
			config: asConfig({
				tools: {
					web: {
						x_search: {
							apiKey: {
								source: "env",
								provider: "default",
								id: "MISSING_X_SEARCH_REF",
							},
						},
					},
				},
			}),
			env: {
				XAI_API_KEY: "x-search-fallback-key", // pragma: allowlist secret
			},
		});

		expect(metadata.xSearch.active).toBe(true);
		expect(metadata.xSearch.apiKeySource).toBe("env");
		expect(resolvedConfig.tools?.web?.x_search?.apiKey).toBe(
			"x-search-fallback-key",
		);
		expect(context.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "WEB_X_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
					path: "tools.web.x_search.apiKey",
				}),
			]),
		);
	});
});

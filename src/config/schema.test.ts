// Covers canonical config schema defaults, validation, and sensitive redaction.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it } from "vitest";
import { buildConfigSchemaCore, lookupConfigSchema } from "./schema.js";
import { asSchemaObject } from "./schema.shared.js";
import { validateConfigObjectRaw } from "./validation.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { OpenClawSchema } from "./zod-schema.js";

const mcpConfig = (server: Record<string, unknown>) => ({ mcp: { servers: { docs: server } } });
const mcpUrl = "https://mcp.example.com/mcp";
const reviewerTools = (reviewer: Record<string, unknown>) => ({ exec: { reviewer } });
const tupleSchema = {
  schema: {
    type: "object",
    properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
  },
  uiHints: {},
  version: "test",
  generatedAt: "test",
} as unknown as Parameters<typeof lookupConfigSchema>[0];

describe("config schema", () => {
  type SchemaInput = NonNullable<Parameters<typeof buildConfigSchemaCore>[0]>;
  let baseSchema: ReturnType<typeof buildConfigSchemaCore>;
  let pluginUiHintInput: SchemaInput;
  let heartbeatChannelInput: SchemaInput;
  let cachedMergeInput: SchemaInput;

  beforeAll(() => {
    baseSchema = buildConfigSchemaCore();
    pluginUiHintInput = {
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          description: "Outbound voice calls",
          configUiHints: {
            provider: { label: "Provider" },
            "twilio.authToken": { label: "Original Token", sensitive: true },
            " .twilio.authToken ": { label: "Auth Token", help: "Twilio credential" },
          },
        },
      ],
    };
    heartbeatChannelInput = {
      channels: [{ id: "imessage", label: "iMessage", configSchema: { type: "object" } }],
    };
    cachedMergeInput = {
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          configSchema: { type: "object", properties: { provider: { type: "string" } } },
        },
      ],
      channels: [
        {
          id: "matrix",
          label: "Matrix",
          configSchema: { type: "object", properties: { accessToken: { type: "string" } } },
        },
      ],
    };
  });

  it("accepts node-host MCP servers with the shared MCP server schema", () => {
    const result = OpenClawSchema.safeParse({
      nodeHost: mcpConfig({
        command: "node",
        args: ["server.mjs"],
        toolFilter: { include: ["read_*"] },
      }),
    });
    expect(result.success).toBe(true);
    const invalid = OpenClawSchema.safeParse({
      nodeHost: { mcp: { servers: { broken: { transport: "stdio" } } } },
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]?.message).toBe(
        '"stdio" transport requires a non-empty command',
      );
    }
  });

  it("rejects the reserved __proto__ MCP server name without tightening other names", () => {
    for (const raw of [
      '{"mcp":{"servers":{"__proto__":{"command":"server"}}}}',
      '{"nodeHost":{"mcp":{"servers":{"__proto__":{"command":"server"}}}}}',
    ]) {
      const result = OpenClawSchema.safeParse(JSON.parse(raw));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            message: 'MCP server name "__proto__" is reserved; rename the server',
          }),
        );
      }
    }

    for (const serverName of ["docs", "_internal"]) {
      expect(
        OpenClawSchema.safeParse({
          mcp: { servers: { [serverName]: { command: "server" } } },
          nodeHost: { mcp: { servers: { [serverName]: { command: "server" } } } },
        }).success,
      ).toBe(true);
    }
  });

  it("rejects reserved MCP server names from the pre-normalization config", () => {
    const sourceRaw = JSON.parse('{"mcp":{"servers":{"__proto__":{"command":"server"}}}}');
    const result = validateConfigObjectRaw({ mcp: { servers: {} } }, { sourceRaw });

    expect(result).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "mcp.servers.__proto__",
          message: 'MCP server name "__proto__" is reserved; rename the server',
        }),
      ],
    });

    const directResult = validateConfigObjectRaw(sourceRaw);
    expect(directResult.ok).toBe(false);
    if (!directResult.ok) {
      expect(
        directResult.issues.filter((issue) => issue.path === "mcp.servers.__proto__"),
      ).toHaveLength(1);
    }
  });

  it("rejects empty Codex MCP agent scopes", () => {
    for (const agents of [[], ["  "], ["!!!"]]) {
      expect(() =>
        OpenClawSchema.parse(
          mcpConfig({
            url: mcpUrl,
            transport: "streamable-http",
            codex: { agents },
          }),
        ),
      ).toThrow();
    }
  });

  it("validates MCP OAuth client metadata URLs against the SDK contract", () => {
    const configWithMetadataUrl = (clientMetadataUrl: string) =>
      mcpConfig({
        url: mcpUrl,
        transport: "streamable-http",
        auth: "oauth",
        oauth: { clientMetadataUrl },
      });
    expect(() =>
      OpenClawSchema.parse(configWithMetadataUrl("https://client.example.com/openclaw-mcp.json")),
    ).not.toThrow();
    for (const clientMetadataUrl of [
      "http://client.example.com/openclaw-mcp.json",
      "https://client.example.com/",
      "not a url",
      "https://[invalid]/openclaw-mcp.json",
      "",
    ]) {
      expect(validateConfigObjectRaw(configWithMetadataUrl(clientMetadataUrl))).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "mcp.servers.docs.oauth.clientMetadataUrl",
            message: "Expected https:// URL with a non-root pathname",
          }),
        ]),
      });
    }
  });

  it("validates MCP OAuth credential identity", () => {
    for (const identity of ["shared", "per-requester"] as const) {
      expect(
        OpenClawSchema.safeParse(mcpConfig({ url: mcpUrl, auth: "oauth", oauth: { identity } }))
          .success,
      ).toBe(true);
    }

    const oauth = { identity: "per-requester" };
    const missingAuth = OpenClawSchema.safeParse(mcpConfig({ url: mcpUrl, oauth }));
    expect(missingAuth.success).toBe(false);
    if (missingAuth.success) {
      throw new Error("Expected per-requester OAuth without auth mode to fail validation");
    }
    expect(missingAuth.error.issues).toContainEqual(
      expect.objectContaining({
        message: 'oauth.identity "per-requester" requires auth: "oauth"',
        path: ["mcp", "servers", "docs", "oauth", "identity"],
      }),
    );

    for (const server of [
      { url: mcpUrl, oauth: { ...oauth, authProfileId: "docs:mcp" } },
      { command: "docs-mcp", oauth },
      // URL plus command resolves stdio and would strand the server silently.
      { url: mcpUrl, command: "docs-mcp", oauth },
      { url: mcpUrl, transport: "stdio", oauth },
    ]) {
      expect(OpenClawSchema.safeParse(mcpConfig({ auth: "oauth", ...server })).success).toBe(false);
    }
  });

  it("requires a bare HTTPS Gateway public origin except on loopback", () => {
    for (const publicOrigin of [
      "https://gateway.example.com",
      "https://gateway.example.com:443",
      "http://localhost:80",
      "http://localhost:18789/",
      "http://127.0.0.1:18789",
      "http://[::1]:18789",
    ]) {
      expect(OpenClawSchema.safeParse({ gateway: { publicOrigin } }).success).toBe(true);
    }
    // Built via URL so no credential-shaped literal lands in source (secret scanners).
    const userinfoOrigin = new URL("https://gateway.example.com");
    userinfoOrigin.username = "operator";
    for (const publicOrigin of [
      "https://gateway.example.com/path",
      "https://gateway.example.com?query=1",
      "https://gateway.example.com/#fragment",
      "http://gateway.example.com",
      userinfoOrigin.href,
      "data:text/html,hello",
    ]) {
      expect(OpenClawSchema.safeParse({ gateway: { publicOrigin } }).success).toBe(false);
    }
  });

  it("rejects stdio transport with whitespace-only command", () => {
    const result = OpenClawSchema.safeParse(mcpConfig({ command: "   ", transport: "stdio" }));
    expect(result.success).toBe(false);
  });

  it("merges plugin ui hints", () => {
    const res = buildConfigSchemaCore(pluginUiHintInput);

    expect(res.uiHints["plugins.entries.voice-call"]?.label).toBe("Voice Call");
    expect(res.uiHints["plugins.entries.voice-call.config"]?.label).toBe("Voice Call Config");
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]).toMatchObject({
      label: "Auth Token",
      help: "Twilio credential",
      sensitive: true,
    });
  });

  it("keeps core channel settings discoverable with bundled metadata", () => {
    const schema = baseSchema;
    const channels = lookupConfigSchema(schema, "channels");
    expect(channels?.children.map((child) => child.key)).toEqual(
      expect.arrayContaining(["defaults", "modelByChannel", "matrix"]),
    );
    expect(channels?.children.map((child) => child.key)).not.toContain("*");
    expect(lookupConfigSchema(schema, "channels.unknownChannel")).toBeNull();
    expect(lookupConfigSchema(schema, "channels.defaults.groupPolicy")?.schema).toMatchObject({
      enum: ["open", "disabled", "allowlist"],
    });
    expect(
      lookupConfigSchema(schema, "channels.defaults.botLoopProtection.maxEventsPerWindow")?.schema,
    ).toMatchObject({ type: "integer" });
    expect(lookupConfigSchema(schema, "channels.modelByChannel.matrix.room")?.schema).toMatchObject(
      { type: "string" },
    );
  });

  it("omits later plugin schemas after the aggregate extension schema budget is exhausted", () => {
    const res = buildConfigSchemaCore({
      cache: false,
      plugins: Array.from({ length: 40 }, (_, index) => ({
        id: `plugin-${index}`,
        configSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: `schema-${index}-${"x".repeat(60_000)}`,
            },
          },
        },
      })),
    });

    const first = lookupConfigSchema(res, "plugins.entries.plugin-0.config.value");
    const last = lookupConfigSchema(res, "plugins.entries.plugin-39.config");
    expect(first?.schema).toMatchObject({ type: "string" });
    expect(last?.schema).toMatchObject({ type: "object", additionalProperties: true });
    expect(last?.schema?.description).toContain("omitted");
  });

  it("adds heartbeat target hints with dynamic channels", () => {
    const res = buildConfigSchemaCore(heartbeatChannelInput);

    const defaultsHint = res.uiHints["agents.defaults.heartbeat.target"];
    const entryHint = res.uiHints["agents.entries.*.heartbeat.target"];
    expect(defaultsHint?.help).toContain("imessage");
    expect(defaultsHint?.help).toContain("owner");
    expect(defaultsHint?.help).toContain("last");
    expect(defaultsHint?.placeholder).toBe("owner");
    expect(entryHint?.help).toContain("imessage");
  });

  it("caches merged schemas for identical plugin/channel metadata", () => {
    const first = buildConfigSchemaCore(cachedMergeInput);
    const plugin = expectDefined(cachedMergeInput.plugins?.[0], "cached plugin metadata");
    const channel = expectDefined(cachedMergeInput.channels?.[0], "cached channel metadata");
    const second = buildConfigSchemaCore({ plugins: [{ ...plugin }], channels: [{ ...channel }] });
    expect(second).toBe(first);
  });

  it("keeps merged plugin schema fragments independent of manifest metadata", () => {
    const value = { type: "string" };
    const result = buildConfigSchemaCore({
      plugins: [
        {
          id: "independent-schema",
          configSchema: { type: "object", properties: { value } },
        },
      ],
    });
    value.type = "number";
    expect(
      lookupConfigSchema(result, "plugins.entries.independent-schema.config.value")?.schema.type,
    ).toBe("string");
  });

  it("refreshes sensitive hints when only a plugin's SecretInput paths change", () => {
    const plugin = {
      id: "secret-path-cache",
      configSchema: { type: "object", additionalProperties: true },
    };
    const build = (path: string) =>
      buildConfigSchemaCore({ plugins: [{ ...plugin, configSecretInputPaths: [path] }] });
    const first = build("routes.*.credential");
    const second = build("routes.*.replacement");
    expect(
      first.uiHints["plugins.entries.secret-path-cache.config.routes.*.credential"]?.sensitive,
    ).toBe(true);
    expect(
      second.uiHints["plugins.entries.secret-path-cache.config.routes.*.replacement"]?.sensitive,
    ).toBe(true);
    expect(
      second.uiHints["plugins.entries.secret-path-cache.config.routes.*.credential"],
    ).toBeUndefined();
  });

  it("accepts exec reviewer model config in global and agent scopes", () => {
    const reviewer = ToolsSchema.parse(
      reviewerTools({
        model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
        thinking: "low",
        fastMode: true,
        timeoutMs: 15_000,
      }),
    )?.exec?.reviewer;
    expect(reviewer).toMatchObject({ thinking: "low", fastMode: true });
    expect(reviewer?.model).toEqual({
      primary: "openrouter/anthropic/claude-sonnet-4-6",
    });

    const tools = reviewerTools({ model: "openai/gpt-5.5", thinking: "high", fastMode: false });
    const config = OpenClawSchema.parse({ agents: { entries: { main: { tools } } } });
    expect(config.agents?.entries?.main?.tools?.exec?.reviewer).toMatchObject({
      model: "openai/gpt-5.5",
      thinking: "high",
      fastMode: false,
    });
    for (const invalid of [{ fastMode: "priority" }, { thinking: "turbo" }]) {
      expect(ToolsSchema.safeParse(reviewerTools(invalid)).success).toBe(false);
    }
  });

  it.each([
    { policy: { security: "full", ask: "off" }, hint: 'Replace security/ask with mode="full"' },
    { policy: { security: "full", ask: "on-miss" }, hint: "no exact mode equivalent" },
    { policy: { ask: "off" }, hint: "legacy policy is incomplete" },
  ])("rejects mixed exec policy with accurate repair guidance: $policy", ({ policy, hint }) => {
    for (const scope of ["root", "agent"]) {
      const exec = { mode: "auto", ...policy };
      const result = OpenClawSchema.safeParse(
        scope === "root"
          ? { tools: { exec } }
          : { agents: { entries: { worker: { tools: { exec } } } } },
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          path:
            scope === "root"
              ? ["tools", "exec", "mode"]
              : ["agents", "entries", "worker", "tools", "exec", "mode"],
          message: expect.stringContaining(hint),
        }),
      ]);
      const message = result.error?.issues[0]?.message;
      expect(message).toContain("same exec object");
      expect(message).toContain("deploy script, template, or patch at this scope");
      expect(message).toContain('run "openclaw doctor --fix"');
      if (!hint.startsWith("Replace")) {
        expect(message).not.toContain("the equivalent of");
      }
    }
  });

  it("looks up root config schema children without returning the full schema tree", () => {
    const lookup = lookupConfigSchema(baseSchema, ".");
    expect(lookup?.path).toBe(".");
    expect(lookup?.children.map((child) => child.key)).toContain("gateway");
    expect(lookup?.children.find((child) => child.key === "gateway")?.path).toBe("gateway");
    const schema = lookup?.schema as { properties?: unknown } | undefined;
    expect(schema?.properties).toBeUndefined();
  });

  it("includes reload metadata when a resolver is provided", () => {
    const lookup = lookupConfigSchema(baseSchema, "gateway", (path) => {
      if (path === "gateway.auth.mode") {
        return { kind: "hot" };
      }
      if (path.startsWith("gateway")) {
        return { kind: "restart" };
      }
      return { kind: "none" };
    });

    expect(lookup?.reloadKind).toBe("restart");
    for (const path of ["gateway.port", "gateway.auth"]) {
      expect(lookup?.children.find((child) => child.path === path)?.reloadKind).toBe("restart");
    }
  });

  it("keeps scoped record entry schemas for form editing", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.entries");
    expect(lookup?.schema).toHaveProperty("additionalProperties");
    const entry = asSchemaObject(lookup?.schema?.additionalProperties);
    expect(entry?.properties).toHaveProperty("runtime");
    const runtimeVariants = entry?.properties?.runtime?.anyOf ?? [];
    expect(runtimeVariants.length).toBeGreaterThan(0);
    expect(runtimeVariants.some((variant) => variant.properties?.type)).toBe(true);
  });

  it("uses the indexed tuple item schema for positional array lookups", () => {
    const lookup = lookupConfigSchema(tupleSchema, "pair.1");
    expect(lookup?.path).toBe("pair.1");
    expect(lookup?.schema?.type).toBe("number");
    expect((lookup?.schema as { items?: unknown } | undefined)?.items).toBeUndefined();
  });

  it("rejects impractical numeric tuple lookup indexes", () => {
    expect(lookupConfigSchema(tupleSchema, "pair.4294967294")).toBeNull();
  });

  it("rejects prototype-chain lookup segments", () => {
    expect(lookupConfigSchema(baseSchema, "constructor")).toBeNull();
    expect(lookupConfigSchema(baseSchema, "__proto__.polluted")).toBeNull();
  });

  it("rejects overly deep lookup paths", () => {
    const deepPathSegments = Array.from({ length: 33 }, (_, index) => `a${index}`);
    const deepSchema = {
      schema: deepPathSegments.reduceRight<Record<string, unknown>>(
        (node, key) => ({ type: "object", properties: { [key]: node } }),
        { type: "string" },
      ),
      uiHints: {},
      version: "test",
      generatedAt: "test",
    } as unknown as Parameters<typeof lookupConfigSchema>[0];

    expect(lookupConfigSchema(deepSchema, deepPathSegments.join("."))).toBeNull();
  });
});

import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractHookToken,
  isHookAgentAllowed,
  normalizeHookDispatchSessionKey,
  resolveEffectiveHookTargetAgentId,
  resolveHookSessionKey,
  normalizeAgentPayload,
  normalizeWakePayload,
  publishHooksTokenEnvKey,
  resolveHooksConfig,
} from "./hooks.js";

function installChannel(id: string, aliases: string[] = []) {
  const plugin = createChannelTestPluginBase({ id, label: id, docsPath: `/channels/${id}` });
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: id, source: "test", plugin: { ...plugin, meta: { ...plugin.meta, aliases } } },
    ]),
  );
}

const hookConfig = (hooks: OpenClawConfig["hooks"] = {}): OpenClawConfig => ({
  hooks: { enabled: true, token: "secret", ...hooks },
});

const agentPayload = (payload: Record<string, unknown> = {}) =>
  normalizeAgentPayload({ message: "hello", ...payload });
const expectPayloadError = (payload: Record<string, unknown>, error: string) =>
  expect(agentPayload(payload)).toEqual({ ok: false, error });

describe("gateway hooks helpers", () => {
  const resolveHooksConfigOrThrow = (cfg: OpenClawConfig) => {
    const resolved = resolveHooksConfig(cfg);
    if (!resolved) {
      throw new Error("hooks config missing");
    }
    expect(resolved.token).toBe(cfg.hooks?.token);
    return resolved;
  };

  const buildHookAgentConfig = (allowedAgentIds?: string[]) =>
    ({
      ...hookConfig({ allowedAgentIds }),
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, hooks: {} },
      },
    }) as OpenClawConfig;

  beforeEach(() => setActivePluginRegistry(emptyRegistry));
  afterEach(() => setActivePluginRegistry(emptyRegistry));
  test("resolveHooksConfig normalizes paths + requires token", () => {
    expect(resolveHooksConfig(hookConfig({ path: "hooks///" }))).toMatchObject({
      basePath: "/hooks",
      token: "secret",
      sessionPolicy: { allowRequestSessionKey: false },
    });
  });

  test("resolveHooksConfig refuses pending hook credentials from config resolution", () => {
    for (const token of [
      "${MISSING_HOOK_SECRET}",
      "prefix-${MISSING_HOOK_SECRET}",
      "$MISSING_HOOK_SECRET",
    ]) {
      for (const value of [undefined, ""]) {
        const resolution = resolveConfigForRead(
          { hooks: { enabled: true, token } },
          { MISSING_HOOK_SECRET: value },
        );
        const cfg = resolution.resolvedConfigRaw as OpenClawConfig;
        setConfigResolutionFacts(cfg, resolution.resolutionFacts);
        expect(() => resolveHooksConfig(cfg)).toThrow(
          "hooks.token has an unresolved environment reference",
        );
        cfg.hooks!.enabled = false;
        expect(resolveHooksConfig(cfg)).toBeNull();
      }
    }
  });

  test("resolveHooksConfig preserves resolved and intentionally literal credentials", () => {
    const cases: Array<[string, NodeJS.ProcessEnv, string]> = [
      ["${HOOK_SECRET}", { HOOK_SECRET: "synthetic-hook-secret" }, "synthetic-hook-secret"],
      ["$${HOOK_SECRET}", {}, "${HOOK_SECRET}"],
      ["${HOOK_SECRET}", { HOOK_SECRET: "${LITERAL_VALUE}" }, "${LITERAL_VALUE}"],
      ["${HOOK_SECRET:-synthetic-fallback}", {}, "synthetic-fallback"],
    ];
    for (const [token, env, expected] of cases) {
      const resolution = resolveConfigForRead({ hooks: { enabled: true, token } }, env);
      const cfg = resolution.resolvedConfigRaw as OpenClawConfig;
      setConfigResolutionFacts(cfg, resolution.resolutionFacts);
      expect(resolveHooksConfig(cfg)?.token).toBe(expected);
    }
    // Direct programmatic configs have no authored substitution provenance.
    expect(resolveHooksConfig({ hooks: { enabled: true, token: "${LITERAL_VALUE}" } })?.token).toBe(
      "${LITERAL_VALUE}",
    );
  });

  test("an env-sourced hook token is withheld from host exec children", () => {
    const env = { PATH: "/usr/bin:/bin", HOOK_SECRET: "synthetic-hook-secret" };
    const resolution = resolveConfigForRead(
      { hooks: { enabled: true, token: "${HOOK_SECRET}" } },
      env,
    );
    const cfg = resolution.resolvedConfigRaw as OpenClawConfig;
    setConfigResolutionFacts(cfg, resolution.resolutionFacts);
    const hooks = resolveHooksConfig(cfg);
    expect(hooks?.tokenEnvKey).toBe("HOOK_SECRET");
    // Literal tokens have no env source to withhold.
    expect(resolveHooksConfig(hookConfig())?.tokenEnvKey).toBeUndefined();
    try {
      publishHooksTokenEnvKey(hooks);
      expect(sanitizeHostExecEnv({ baseEnv: env })).not.toHaveProperty("HOOK_SECRET");
      // Reloading to hooks without an env source releases the name again.
      publishHooksTokenEnvKey(resolveHooksConfig(hookConfig()));
      expect(sanitizeHostExecEnv({ baseEnv: env }).HOOK_SECRET).toBe("synthetic-hook-secret");
    } finally {
      publishHooksTokenEnvKey(null);
    }
  });

  test("resolveHooksConfig rejects root path", () => {
    expect(() => resolveHooksConfig(hookConfig({ path: "/" }))).toThrow(
      "hooks.path may not be '/'",
    );
  });

  test("extractHookToken prefers bearer > header", () => {
    const extract = (headers: IncomingMessage["headers"]) =>
      extractHookToken({ headers } as IncomingMessage);
    expect(extract({ authorization: "Bearer top", "x-openclaw-token": "header" })).toBe("top");
    expect(extract({ "x-openclaw-token": "header" })).toBe("header");
    expect(extract({})).toBeUndefined();
  });

  test("normalizeWakePayload trims + validates", () => {
    expect(normalizeWakePayload({ text: "  hi " })).toEqual({
      ok: true,
      value: { text: "hi", mode: "now" },
    });
    expect(
      normalizeWakePayload({
        text: "wake later",
        mode: "next-heartbeat",
        sessionKey: "hook:wake:later",
      }),
    ).toEqual({
      ok: false,
      error: "sessionKey requires mode=now",
    });
    expect(normalizeWakePayload({ text: "  ", mode: "now" }).ok).toBe(false);
    expect(normalizeWakePayload({ text: "wake", agentId: 42 })).toEqual({
      ok: false,
      error: "agentId must be a non-empty string",
    });
    expect(normalizeWakePayload({ text: "wake", agentId: "  " })).toEqual({
      ok: false,
      error: "agentId must be a non-empty string",
    });
  });

  test("normalizeAgentPayload defaults + validates channel and agent", () => {
    expect(agentPayload({ timeoutSeconds: 0.5 })).toEqual({
      ok: true,
      value: expect.objectContaining({
        sessionKey: undefined,
        sessionMode: "isolated",
        timeoutSeconds: undefined,
        name: "Hook",
        deliver: true,
        delivery: { mode: "none" },
      }),
    });
    expect(agentPayload({ deliver: false })).toEqual({
      ok: true,
      value: expect.objectContaining({ deliver: false, delivery: { mode: "none" } }),
    });
    installChannel("imessage");
    expect(agentPayload({ channel: "imsg", to: "chat-1" })).toEqual({
      ok: true,
      value: expect.objectContaining({
        channel: "imessage",
        delivery: { mode: "announce", channel: "imessage", to: "chat-1" },
      }),
    });
    installChannel("demo-alias-channel", ["workspace-chat"]);
    expect(agentPayload({ channel: "workspace-chat", to: "room-1" })).toMatchObject({
      ok: true,
      value: { channel: "demo-alias-channel" },
    });
    expect(agentPayload({ channel: "sms" }).ok).toBe(false);
    expect(agentPayload({ sessionMode: "persistent" })).toMatchObject({
      ok: true,
      value: { sessionMode: "persistent" },
    });
    expectPayloadError({ sessionMode: "shared" }, "sessionMode must be isolated or persistent");
    expect(agentPayload()).toMatchObject({ ok: true, value: { agentId: undefined } });
    expectPayloadError({ agentId: 42 }, "agentId must be a non-empty string");
    expectPayloadError({ agentId: "  " }, "agentId must be a non-empty string");
  });

  test("normalizeAgentPayload binds delivery only to a concrete channel and recipient", () => {
    installChannel("demo-alias-channel", ["workspace-chat"]);
    expect(agentPayload()).toMatchObject({
      ok: true,
      value: { channel: "last", to: undefined, delivery: { mode: "none" } },
    });

    expectPayloadError(
      { to: "sensitive-recipient" },
      "channel and to must be set together for hook delivery",
    );
    for (const to of [123, "   "]) {
      expectPayloadError({ to }, "to must be a non-empty string for hook delivery");
    }

    expectPayloadError(
      { channel: "demo-alias-channel" },
      "channel and to must be set together for hook delivery",
    );
    expect(agentPayload({ deliver: false, channel: "stale-channel" })).toMatchObject({
      ok: true,
      value: {
        deliver: false,
        channel: "last",
        to: undefined,
        delivery: { mode: "none" },
      },
    });
    expectPayloadError(
      { channel: "last", to: "123456" },
      "channel must name a concrete channel for hook delivery",
    );
    expectPayloadError(
      { accountId: "work" },
      "accountId requires channel and to for hook delivery",
    );
    for (const accountId of [123, "   "]) {
      expectPayloadError(
        { channel: "demo-alias-channel", to: "123456", accountId },
        "accountId must be a non-empty string for hook delivery",
      );
    }

    expect(
      agentPayload({
        channel: "demo-alias-channel",
        to: "123456",
        accountId: " work ",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        channel: "demo-alias-channel",
        to: "123456",
        accountId: "work",
        delivery: {
          mode: "announce",
          channel: "demo-alias-channel",
          to: "123456",
          accountId: "work",
        },
      },
    });
  });

  test.each([1, 1.9])("normalizeAgentPayload agent and timeout %s", (timeoutSeconds) => {
    expect(agentPayload({ agentId: "hooks", timeoutSeconds })).toMatchObject({
      ok: true,
      value: { agentId: "hooks", timeoutSeconds: 1 },
    });
  });

  test("hook target resolution keeps config fallback out of request payloads", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig());
    const unknownAgent = (input: string, agentId: string) =>
      expect(resolveEffectiveHookTargetAgentId(resolved, input, "request")).toEqual({
        ok: false,
        code: "unknown-agent",
        agentId,
        error: `unknown agentId "${agentId}"`,
      });
    expect(resolveEffectiveHookTargetAgentId(resolved, "missing-agent", "mapping")).toEqual({
      ok: true,
      selectedAgentId: "main",
      effectiveAgentId: "main",
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "!!!", "mapping")).toEqual({
      ok: true,
      selectedAgentId: "main",
      effectiveAgentId: "main",
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "hooks", "request")).toEqual({
      ok: true,
      selectedAgentId: "hooks",
      effectiveAgentId: "hooks",
    });
    unknownAgent("missing-agent", "missing-agent");
    unknownAgent("Missing Agent", "missing-agent");
    unknownAgent("!!!", "!!!");
    expect(resolveEffectiveHookTargetAgentId(resolved, undefined, "request")).toEqual({
      ok: true,
      effectiveAgentId: "main",
    });
  });

  test.each([undefined, "explicit"] as const)(
    "hook dispatch uses a recorded designation only with explicit ownership (%s)",
    (ownership) => {
      const resolved = resolveHooksConfigOrThrow({
        hooks: { enabled: true, token: "synthetic-hook-token" },
        agents: {
          ownership,
          defaults: { systemAgent: { agentId: "research" } },
          entries: { ops: {}, research: {} },
        },
      });
      expect(resolveEffectiveHookTargetAgentId(resolved, undefined, "request")).toEqual(
        ownership === "explicit"
          ? { ok: true, effectiveAgentId: "research" }
          : {
              ok: false,
              code: "agent-required",
              error: "agentId is required when multiple agents are configured",
            },
      );
    },
  );

  test("hook dispatch cannot use migration provenance as an explicit fleet default", () => {
    const resolved = resolveHooksConfigOrThrow(
      retainLegacyDefaultAgentId(
        {
          hooks: { enabled: true, token: "synthetic-hook-token" },
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        },
        "ops",
      ),
    );
    expect(resolveEffectiveHookTargetAgentId(resolved, undefined, "request")).toMatchObject({
      ok: false,
      code: "agent-required",
    });
  });

  test.each([undefined, "research"])(
    "global hook dispatch honors the persisted fixed-store owner (runtime default: %s)",
    (runtimeDefault) => {
      const resolved = resolveHooksConfigOrThrow({
        hooks: { enabled: true, token: "secret" },
        session: { scope: "global", store: "/tmp/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: {
            sessionStore: { agentId: "ops" },
            ...(runtimeDefault ? { systemAgent: { agentId: runtimeDefault } } : {}),
          },
          entries: { ops: {}, research: {} },
        },
      });

      expect(resolveEffectiveHookTargetAgentId(resolved, undefined, "request")).toEqual({
        ok: true,
        effectiveAgentId: "ops",
      });
      expect(resolveEffectiveHookTargetAgentId(resolved, undefined, "mapping")).toEqual({
        ok: true,
        effectiveAgentId: "ops",
      });
      expect(resolveEffectiveHookTargetAgentId(resolved, "research", "request")).toEqual({
        ok: false,
        code: "owner-conflict",
        agentId: "research",
        ownerAgentId: "ops",
        error:
          'agentId "research" conflicts with global session-store owner "ops"; use agentId "ops" or update agents.defaults.sessionStore.agentId',
      });
    },
  );

  test.each<[string, string[], boolean, boolean]>([
    ["honors effective target routing", ["hooks"], true, false],
    ["treats an empty allowlist as deny-all", [], false, false],
    ["treats a wildcard allowlist as allow-all", ["*"], true, true],
  ])("isHookAgentAllowed %s", (_name, allowed, hooksAllowed, mainAllowed) => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(allowed));
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(hooksAllowed);
    expect(isHookAgentAllowed(resolved, "main")).toBe(mainAllowed);
  });

  test.each<{
    name: string;
    hooks?: OpenClawConfig["hooks"];
    source: Parameters<typeof resolveHookSessionKey>[0]["source"];
    sessionKey?: string;
    expected: object;
  }>([
    {
      name: "resolveHookSessionKey disables request sessionKey by default",
      source: "request",
      sessionKey: "agent:main:dm:u99999",
      expected: { ok: false },
    },
    {
      name: "resolveHookSessionKey enforces allowed prefixes: blocked request",
      hooks: { allowRequestSessionKey: true, allowedSessionKeyPrefixes: ["hook:"] },
      source: "request",
      sessionKey: "agent:main:main",
      expected: { ok: false },
    },
    {
      name: "resolveHookSessionKey enforces allowed prefixes: allowed static mapping",
      hooks: { allowRequestSessionKey: true, allowedSessionKeyPrefixes: ["hook:"] },
      source: "mapping-static",
      sessionKey: "hook:gmail:1",
      expected: { ok: true, value: "hook:gmail:1" },
    },
    {
      name: "resolveHookSessionKey blocks templated mapping sessionKey when request overrides are disabled",
      hooks: { allowedSessionKeyPrefixes: ["hook:", "hook:gmail:"] },
      source: "mapping-templated",
      sessionKey: "hook:gmail:attacker",
      expected: { ok: false },
    },
    {
      name: "resolveHookSessionKey uses defaultSessionKey when request key is absent",
      hooks: { defaultSessionKey: "hook:ingress" },
      source: "request",
      expected: { ok: true, value: "hook:ingress" },
    },
  ])("$name", ({ hooks, source, sessionKey, expected }) => {
    const result = resolveHookSessionKey({
      hooksConfig: resolveHooksConfigOrThrow(hookConfig(hooks)),
      source,
      sessionKey,
    });
    expect(result).toMatchObject(expected);
    if (result.ok) {
      expect(result).toEqual(expected);
    }
  });

  test("normalizeHookDispatchSessionKey rebinds non-target agent scoped keys to the target agent", () => {
    expect(
      normalizeHookDispatchSessionKey({
        sessionKey: "agent:main:slack:channel:c123",
        targetAgentId: "hooks",
      }),
    ).toBe("agent:hooks:slack:channel:c123");
  });

  test.each([
    {
      name: "resolveHooksConfig validates defaultSessionKey against prefixes",
      hooks: { defaultSessionKey: "agent:main:main", allowedSessionKeyPrefixes: ["hook:"] },
      error: "hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes",
    },
    {
      name: "resolveHooksConfig validates generated fallback against prefixes",
      hooks: { allowedSessionKeyPrefixes: ["agent:"] },
      error:
        "hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset",
    },
    ...(["agent", "wake"] as const).map((action) => ({
      name:
        action === "agent"
          ? "resolveHooksConfig requires prefixes for templated mapping session keys"
          : "resolveHooksConfig applies templated session-key policy to wake mappings",
      hooks: {
        allowRequestSessionKey: action === "agent",
        mappings: [
          {
            match: { path: action },
            action,
            messageTemplate: "Subject: {{messages[0].subject}}",
            textTemplate: "ping",
            sessionKey: `hook:${action}:{{payload.id}}`,
          },
        ],
      },
      error:
        "hooks.allowedSessionKeyPrefixes is required when a hook mapping sessionKey uses templates, even if hooks.allowRequestSessionKey=true",
    })),
  ])("$name", ({ hooks, error }) => {
    expect(() => resolveHooksConfig(hookConfig(hooks))).toThrow(error);
  });

  test.each([
    {
      name: "resolveHooksConfig allows a static explicit mapping to shadow the templated gmail preset",
      hooks: {
        presets: ["gmail"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent" as const,
            messageTemplate: "Subject: {{messages[0].subject}}",
            sessionKey: "hook:gmail:static",
          },
        ],
      },
      field: "sessionKey" as const,
      expected: ["hook:gmail:static", "hook:gmail:{{messages[0].id}}"],
    },
    ...(["path", "source"] as const).map((kind) => ({
      name:
        kind === "path"
          ? "resolveHooksConfig treats '/' match.path as a catch-all for shadowing"
          : "resolveHooksConfig treats empty match.source as a wildcard for shadowing",
      hooks: {
        mappings: [
          {
            match: kind === "path" ? { path: "/" } : { path: "gmail", source: "" },
            action: "agent" as const,
            messageTemplate: "catch-all",
            sessionKey: "hook:static",
          },
          {
            match: { path: "gmail", ...(kind === "source" ? { source: "gmail" } : {}) },
            action: "agent" as const,
            messageTemplate: "Subject: {{messages[0].subject}}",
            sessionKey: "hook:gmail:{{messages[0].id}}",
          },
        ],
      },
      field: kind === "path" ? ("matchPath" as const) : ("matchSource" as const),
      expected: ["", "gmail"],
    })),
  ])("$name", ({ hooks, field, expected }) => {
    const resolved = resolveHooksConfigOrThrow(hookConfig(hooks));
    expect(resolved.mappings.map((mapping) => mapping[field])).toEqual(expected);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });
});

const emptyRegistry = createTestRegistry([]);

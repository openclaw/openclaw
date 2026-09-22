import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import type { OpenClawPluginApi } from "../../plugins/plugin-api.types.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { createTestPluginApi } from "../plugin-test-api.js";
import { createMeetingBrowserFixture, createMeetingLogger } from "./meeting-browser.js";

type GatewayHandler = (options: {
  client?: { internal?: { pluginRuntimeOwnerId?: string } };
  params?: Record<string, unknown>;
  respond(ok: boolean, payload?: unknown, error?: unknown): void;
}) => Promise<void>;

type MeetingPluginFixtureOptions = {
  plugin: { register(api: OpenClawPluginApi): void };
  id: string;
  name: string;
  url: string;
  title: string;
  tabId: string;
  methodPrefix: string;
  toolName: string;
  nodeCommand: string;
  descriptor: NonNullable<
    NonNullable<Parameters<OpenClawPluginApi["registerCli"]>[1]>["descriptors"]
  >[number];
  transcriptSource: { id: string; aliases: string[] };
};

export function createMeetingPluginFixture(options: MeetingPluginFixtureOptions) {
  const createApi = (overrides: Partial<OpenClawPluginApi> = {}) =>
    createTestPluginApi({
      id: options.id,
      name: options.name,
      description: "test",
      version: "0",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {
        gateway: { isAvailable: vi.fn(async () => false), request: vi.fn() },
      } as unknown as OpenClawPluginApi["runtime"],
      logger: createMeetingLogger(),
      ...overrides,
    });
  const authorizationHarness = (browserOptions?: { browserError?: Error }) => {
    const methods = new Map<string, GatewayHandler>();
    const browser = createMeetingBrowserFixture({ ...options, ...browserOptions });
    options.plugin.register(
      createApi({
        pluginConfig: { defaultMode: "transcribe", chrome: { waitForInCallMs: 1 } },
        runtime: { gateway: browser.runtime.gateway } as OpenClawPluginApi["runtime"],
        registerGatewayMethod: (method, handler) => methods.set(method, handler as GatewayHandler),
      }),
    );
    const invoke = async (
      method: string,
      params: Record<string, unknown>,
      pluginRuntimeOwnerId?: string,
    ) => {
      const handler = methods.get(method);
      if (!handler) {
        throw new Error(`missing handler ${method}`);
      }
      let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
      await handler({
        params,
        ...(pluginRuntimeOwnerId ? { client: { internal: { pluginRuntimeOwnerId } } } : {}),
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      return response;
    };
    const call = async (
      method: string,
      params: Record<string, unknown>,
      pluginRuntimeOwnerId?: string,
    ) => {
      const response = await invoke(method, params, pluginRuntimeOwnerId);
      if (!response?.ok) {
        throw new Error(`gateway call failed: ${JSON.stringify(response)}`);
      }
      return response.payload as Record<string, unknown>;
    };
    return { call, invoke };
  };
  return { ...options, createApi, authorizationHarness };
}

export function defineMeetingPluginSurfaceTests(
  fixture: ReturnType<typeof createMeetingPluginFixture>,
) {
  it("registers the bounded gateway, tool, CLI, and node surfaces", () => {
    const methods = new Map<string, unknown>();
    const tools: Array<Record<string, unknown>> = [];
    const cli: Array<Parameters<OpenClawPluginApi["registerCli"]>[1]> = [];
    const nodeCommands: unknown[] = [];
    const policies: unknown[] = [];
    const transcriptProviders: TranscriptSourceProvider[] = [];
    const api = fixture.createApi({
      registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
      registerTool: (tool: unknown) => {
        tools.push(
          (typeof tool === "function"
            ? (tool as (context: Record<string, unknown>) => Record<string, unknown>)({})
            : tool) as Record<string, unknown>,
        );
      },
      registerCli: (_registrar, options) => cli.push(options),
      registerNodeHostCommand: (command: unknown) => nodeCommands.push(command),
      registerNodeInvokePolicy: (policy: unknown) => policies.push(policy),
      registerTranscriptSourceProvider: (provider) => transcriptProviders.push(provider),
    });

    fixture.plugin.register(api);

    expect([...methods.keys()].toSorted()).toEqual(
      [
        `${fixture.methodPrefix}.join`,
        `${fixture.methodPrefix}.leave`,
        `${fixture.methodPrefix}.setup`,
        `${fixture.methodPrefix}.speak`,
        `${fixture.methodPrefix}.status`,
        `${fixture.methodPrefix}.testListen`,
        `${fixture.methodPrefix}.testSpeech`,
        `${fixture.methodPrefix}.transcript`,
      ].toSorted(),
    );
    expect(tools.map((tool) => tool.name)).toEqual([fixture.toolName]);
    expect(cli).toEqual([expect.objectContaining({ commands: [fixture.methodPrefix] })]);
    expect(cli[0]?.descriptors?.[0]).toBe(fixture.descriptor);
    expect(nodeCommands).toEqual([
      expect.objectContaining({ command: fixture.nodeCommand, cap: fixture.id }),
    ]);
    expect(policies).toHaveLength(1);
    expect(transcriptProviders).toEqual([
      expect.objectContaining({
        id: fixture.transcriptSource.id,
        aliases: fixture.transcriptSource.aliases,
        sourceKinds: ["live-caption"],
      }),
    ]);
  });

  it("scopes trusted tool session operations to the invoking agent", async () => {
    const { call } = fixture.authorizationHarness();
    const joined = await call(
      `${fixture.methodPrefix}.join`,
      { agentId: "support", mode: "transcribe", url: fixture.url },
      fixture.id,
    );
    const sessionId = (joined.session as { id: string }).id;

    expect(
      await call(`${fixture.methodPrefix}.status`, { agentId: "other" }, fixture.id),
    ).toMatchObject({ found: true, sessions: [] });
    for (const method of ["status", "leave", "transcript", "speak"] as const) {
      expect(
        await call(
          `${fixture.methodPrefix}.${method}`,
          { agentId: "other", message: "hello", sessionId },
          fixture.id,
        ),
      ).toMatchObject({ found: false });
    }

    expect(
      await call(`${fixture.methodPrefix}.status`, { agentId: "spoofed", sessionId }),
    ).toMatchObject({
      found: true,
      session: { agentId: "support", id: sessionId },
    });
    expect(
      await call(`${fixture.methodPrefix}.leave`, { agentId: "support", sessionId }, fixture.id),
    ).toMatchObject({ found: true, session: { id: sessionId, state: "ended" } });
  });

  it.each([
    ["mode", "observe-only", "mode must be agent, bidi, or transcribe"],
    ["transport", "desktop", "transport must be chrome or chrome-node"],
  ])("rejects an explicit invalid %s", async (field, value, message) => {
    const { invoke } = fixture.authorizationHarness();
    const response = await invoke(`${fixture.methodPrefix}.join`, {
      [field]: value,
      url: fixture.url,
    });

    expect(response).toMatchObject({
      error: { code: ErrorCodes.INVALID_REQUEST },
      ok: false,
      payload: { error: message },
    });
  });

  it("rejects timeoutMs on normal join instead of silently ignoring it", async () => {
    const { invoke } = fixture.authorizationHarness();
    const response = await invoke(`${fixture.methodPrefix}.join`, {
      mode: "transcribe",
      timeoutMs: 1,
      url: fixture.url,
    });

    expect(response).toMatchObject({
      ok: false,
      payload: { error: "timeoutMs is supported only by testSpeech or testListen" },
    });
  });

  it.each([
    [
      `${fixture.methodPrefix}.testSpeech`,
      "transcribe",
      "test_speech requires mode: agent or bidi",
    ],
    [`${fixture.methodPrefix}.testListen`, "agent", "test_listen requires mode: transcribe"],
  ])(
    "classifies invalid probe mode for %s as an invalid request",
    async (method, mode, message) => {
      const { invoke } = fixture.authorizationHarness();
      const response = await invoke(method, { mode, timeoutMs: 1, url: fixture.url });

      expect(response).toMatchObject({
        error: { code: ErrorCodes.INVALID_REQUEST },
        ok: false,
        payload: { error: message },
      });
    },
  );

  it("classifies browser failures as unavailable, not invalid requests", async () => {
    const { invoke } = fixture.authorizationHarness({
      browserError: new Error("browser unavailable"),
    });
    const response = await invoke(`${fixture.methodPrefix}.join`, {
      mode: "transcribe",
      url: fixture.url,
    });

    expect(response).toMatchObject({
      error: { code: ErrorCodes.UNAVAILABLE },
      ok: false,
      payload: { error: "browser unavailable" },
    });
  });
}

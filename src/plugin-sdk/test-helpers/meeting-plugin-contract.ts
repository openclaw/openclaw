import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import type { OpenClawPluginApi } from "../../plugins/plugin-api.types.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { createTestPluginApi } from "../plugin-test-api.js";
import { createMeetingBrowserFixture, createMeetingLogger } from "./meeting-browser.js";
import type { useMeetingTestState } from "./meeting-state.js";
import { createPluginGatewayRuntimeMock } from "./plugin-runtime-gateway-mock.js";

type GatewayHandler = (options: {
  client?: { internal?: { pluginRuntimeOwnerId?: string } };
  params?: Record<string, unknown>;
  respond(ok: boolean, payload?: unknown, error?: unknown): void;
}) => Promise<void>;

type MeetingPluginFixtureOptions = {
  testState: Pick<ReturnType<typeof useMeetingTestState>, "onCleanup">;
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
      pluginConfig: {},
      runtime: {
        gateway: createPluginGatewayRuntimeMock(),
      } as unknown as OpenClawPluginApi["runtime"],
      logger: createMeetingLogger(),
      ...overrides,
    });
  const authorizationHarness = (browserOptions?: { browserError?: Error }) => {
    const methods = new Map<string, GatewayHandler>();
    const browser = createMeetingBrowserFixture({ ...options, ...browserOptions });
    const logger = createMeetingLogger();
    let invoked = false;
    options.plugin.register(
      createApi({
        logger,
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
      invoked = true;
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
    options.testState.onCleanup(
      async () => {
        if (!invoked) {
          return;
        }
        const status = (await call(`${options.methodPrefix}.status`, {})) as {
          sessions: Array<{ id: string }>;
        };
        const errors: unknown[] = [];
        for (const session of status.sessions) {
          try {
            await call(`${options.methodPrefix}.leave`, { sessionId: session.id });
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Meeting plugin sessions did not finish cleanup");
        }
      },
      { readWarnings: () => vi.mocked(logger.warn).mock.calls },
    );
    return { call, invoke };
  };
  return { ...options, createApi, authorizationHarness };
}

export function defineMeetingPluginSurfaceTests(
  fixture: ReturnType<typeof createMeetingPluginFixture>,
) {
  const { methodPrefix, id, toolName, nodeCommand, descriptor, transcriptSource, url } = fixture;
  it("registers the bounded gateway, tool, CLI, and node surfaces", () => {
    const methods = new Set<string>();
    const tools: Array<Record<string, unknown>> = [];
    const cli: Array<Parameters<OpenClawPluginApi["registerCli"]>[1]> = [];
    const nodeCommands: unknown[] = [];
    const policies: unknown[] = [];
    const transcriptProviders: TranscriptSourceProvider[] = [];
    const api = fixture.createApi({
      registerGatewayMethod: (method) => methods.add(method),
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

    expect([...methods].toSorted()).toEqual(
      ["join", "leave", "setup", "speak", "status", "testListen", "testSpeech", "transcript"]
        .map((method) => `${methodPrefix}.${method}`)
        .toSorted(),
    );
    expect(tools.map((tool) => tool.name)).toEqual([toolName]);
    expect(cli).toEqual([expect.objectContaining({ commands: [methodPrefix] })]);
    expect(cli[0]?.descriptors?.[0]).toBe(descriptor);
    expect(nodeCommands).toEqual([expect.objectContaining({ command: nodeCommand, cap: id })]);
    expect(policies).toHaveLength(1);
    expect(transcriptProviders).toEqual([
      expect.objectContaining({
        id: transcriptSource.id,
        aliases: transcriptSource.aliases,
        sourceKinds: ["live-caption"],
      }),
    ]);
  });

  it("scopes trusted tool session operations to the invoking agent", async () => {
    const harness = fixture.authorizationHarness();
    const call = (method: string, params: Record<string, unknown>, owner?: string) =>
      harness.call(`${methodPrefix}.${method}`, params, owner);
    const joined = await call("join", { agentId: "support", mode: "transcribe", url }, id);
    const sessionId = (joined.session as { id: string }).id;

    expect(await call("status", { agentId: "other" }, id)).toMatchObject({
      found: true,
      sessions: [],
    });
    for (const method of ["status", "leave", "transcript", "speak"] as const) {
      expect(
        await call(method, { agentId: "other", message: "hello", sessionId }, id),
      ).toMatchObject({ found: false });
    }

    expect(await call("status", { agentId: "spoofed", sessionId })).toMatchObject({
      found: true,
      session: { agentId: "support", id: sessionId },
    });
    expect(await call("leave", { agentId: "support", sessionId }, id)).toMatchObject({
      found: true,
      session: { id: sessionId, state: "ended" },
    });
  });

  const invalid = ErrorCodes.INVALID_REQUEST;
  it.each([
    ["join", { mode: "observe-only" }, "mode must be agent, bidi, or transcribe", invalid],
    ["join", { transport: "desktop" }, "transport must be chrome or chrome-node", invalid],
    [
      "join",
      { mode: "transcribe", timeoutMs: 1 },
      "timeoutMs is supported only by testSpeech or testListen",
      undefined,
    ],
    [
      "testSpeech",
      { mode: "transcribe", timeoutMs: 1 },
      "test_speech requires mode: agent or bidi",
      invalid,
    ],
    [
      "testListen",
      { mode: "agent", timeoutMs: 1 },
      "test_listen requires mode: transcribe",
      invalid,
    ],
    ["join", { mode: "transcribe" }, "browser unavailable", ErrorCodes.UNAVAILABLE],
  ])("classifies %s request %j: %s", async (method, params, message, code) => {
    const { invoke } = fixture.authorizationHarness(
      code === ErrorCodes.UNAVAILABLE ? { browserError: new Error(message) } : undefined,
    );
    const response = await invoke(`${methodPrefix}.${method}`, {
      ...params,
      url,
    });
    expect(response).toMatchObject({
      ok: false,
      payload: { error: message },
      ...(code ? { error: { code } } : {}),
    });
  });
}

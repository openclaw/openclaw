// Regression coverage for native /new model selection with target session routing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  createGetReplyContinueDirectivesResult,
  buildGetReplyCtx,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

type ModelAliasIndex = import("../../agents/model-selection.js").ModelAliasIndex;

function emptyAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

const mocks = vi.hoisted(() => ({
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
}));

vi.doMock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));

vi.doMock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));

vi.doMock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
  resolveReplySessionPreprocessingState: () => ({
    sessionEntry: undefined,
    sessionKey: "agent:main:telegram:123",
    storePath: "/tmp/sessions.json",
  }),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let resolveSessionAgentIdMock: typeof import("../../agents/agent-scope.js").resolveSessionAgentId;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ resolveSessionAgentId: resolveSessionAgentIdMock } =
    await import("../../agents/agent-scope.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
}

describe("getReplyFromConfig native /new agent model selection", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [],
    });
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    vi.mocked(resolveSessionAgentIdMock).mockReset();
    vi.mocked(resolveSessionAgentIdMock).mockReturnValue("main");
    vi.mocked(resolveDefaultModelMock).mockReset();
    vi.mocked(resolveDefaultModelMock).mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: emptyAliasIndex(),
    });
    vi.mocked(runPreparedReplyMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cliBackendsTesting.resetDepsForTest();
    vi.unstubAllEnvs();
  });

  it("uses the native /new target session agent to resolve the runtime default model", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-new-agent-model-"));
    const targetSessionKey = "agent:main:telegram:direct:123";
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: path.join(home, "workspace"),
        },
        list: [
          {
            id: "main",
            model: {
              primary: "openai/gpt-5.6-sol",
              fallbacks: ["openai/gpt-5.6-terra", "openai/gpt-5.5"],
            },
          },
        ],
      },
      session: { store: path.join(home, "sessions.json") },
    } as OpenClawConfig);
    vi.mocked(resolveSessionAgentIdMock).mockImplementation((params) =>
      params.sessionKey === targetSessionKey ? "main" : "global",
    );
    vi.mocked(resolveDefaultModelMock).mockImplementation((params) =>
      params.agentId === "main"
        ? {
            defaultProvider: "openai",
            defaultModel: "gpt-5.6-sol",
            aliasIndex: emptyAliasIndex(),
          }
        : {
            defaultProvider: "openai",
            defaultModel: "gpt-5.5",
            aliasIndex: emptyAliasIndex(),
          },
    );
    mocks.resolveReplyDirectives.mockImplementationOnce(async (params: unknown) => {
      const directiveParams = params as { provider: string; model: string };
      return createGetReplyContinueDirectivesResult({
        body: "continue with the new session",
        abortKey: targetSessionKey,
        from: "telegram:user:42",
        to: "slash:123",
        senderId: "telegram:user:42",
        commandSource: "/new continue with the new session",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: directiveParams.provider,
        model: directiveParams.model,
      });
    });
    mocks.handleInlineActions.mockResolvedValueOnce({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
      cleanedBody: "continue with the new session",
    });

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx({
          Body: "/new continue with the new session",
          BodyForAgent: "/new continue with the new session",
          RawBody: "/new continue with the new session",
          CommandBody: "/new continue with the new session",
          CommandSource: "native",
          CommandAuthorized: true,
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: targetSessionKey,
        }),
        undefined,
        cfg,
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(resolveSessionAgentIdMock)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: targetSessionKey }),
    );
    expect(vi.mocked(resolveDefaultModelMock)).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
    expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      provider: "openai",
      model: "gpt-5.6-sol",
      defaultModel: "gpt-5.6-sol",
      isNewSession: true,
      resetTriggered: true,
      sessionKey: targetSessionKey,
    });
  });
});

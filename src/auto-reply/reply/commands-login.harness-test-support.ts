import { afterEach, beforeEach, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../../config/runtime-snapshot.js";
import type { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

type SessionPatchArguments = Parameters<typeof patchSessionEntryCore>;
type SessionPatchInvocation = SessionPatchArguments[0] &
  NonNullable<SessionPatchArguments[2]> & { update: SessionPatchArguments[1] };

const runModelsAuthLoginFlowMock = vi.hoisted(() => vi.fn());
const patchSessionEntryMock = vi.hoisted(() =>
  vi.fn<(params: SessionPatchInvocation) => ReturnType<typeof patchSessionEntryCore>>(),
);

vi.mock("../../commands/models/auth.js", () => ({
  runModelsAuthLoginFlowCore: (opts: unknown) => runModelsAuthLoginFlowMock(opts),
}));
vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    patchSessionEntryCore: (...[scope, update, options]: SessionPatchArguments) =>
      patchSessionEntryMock({ ...scope, update, ...options }),
  };
});

const { testing } = await import("./commands-login.test-support.js");

export function buildLoginParams(
  commandBody: string,
  overrides: {
    command?: Partial<HandleCommandsParams["command"]>;
    ctx?: Partial<HandleCommandsParams["ctx"]>;
    opts?: HandleCommandsParams["opts"];
    sessionKey?: string;
    sessionEntry?: HandleCommandsParams["sessionEntry"];
    sessionStore?: HandleCommandsParams["sessionStore"];
    storePath?: string;
    agentId?: string;
    provider?: string;
  } = {},
): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBody,
    {
      commands: { text: true, ownerAllowFrom: ["owner"] },
      channels: { slack: { allowFrom: ["owner"] } },
      session: { mainKey: "main" },
    } as OpenClawConfig,
    {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "direct:owner",
      AccountId: "workspace-a",
      ChatType: "direct",
      MessageThreadId: "thread-1",
      ...overrides.ctx,
    },
    { workspaceDir: "/tmp/openclaw-login-test" },
  );
  params.sessionKey = overrides.sessionKey ?? "agent:main:slack:channel:C123";
  params.agentId = overrides.agentId ?? params.agentId;
  params.provider = overrides.provider ?? "openai";
  params.command = {
    ...params.command,
    channel: "slack",
    channelId: "slack",
    accountId: "workspace-a",
    senderId: "owner",
    senderIsOwner: true,
    isAuthorizedSender: true,
    from: "slack:owner",
    to: "direct:owner",
    ...overrides.command,
  };
  params.opts = overrides.opts;
  if (overrides.sessionEntry !== undefined) {
    params.sessionEntry = overrides.sessionEntry;
    params.sessionStore = overrides.sessionStore ?? {
      [params.sessionKey]: overrides.sessionEntry,
    };
  }
  params.storePath = overrides.storePath;
  return params;
}

export function blockReplyOpts(): NonNullable<HandleCommandsParams["opts"]> {
  return { onBlockReply: vi.fn(async () => {}) };
}

export { runModelsAuthLoginFlowMock, patchSessionEntryMock };

export function setupLoginCommandTests() {
  beforeEach(() => {
    vi.clearAllMocks();
    runModelsAuthLoginFlowMock.mockReset();
    patchSessionEntryMock.mockReset();
    testing.clearActiveFlows();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setRuntimeConfigSnapshotRefreshHandler(null);
  });
}

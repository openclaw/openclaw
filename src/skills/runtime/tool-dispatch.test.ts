import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenClawToolsAsync } from "../../agents/openclaw-tools.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../../secrets/provider-env-vars.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { resolveSkillDispatchTools, type SkillToolDispatchDependencies } from "./tool-dispatch.js";

const makeTool = (name: string) => ({
  name,
  label: name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
  execute: vi.fn(),
});

const createOpenClawToolsAsyncMock = vi.fn<
  SkillToolDispatchDependencies["createOpenClawToolsAsync"]
>(async () => ["read", "cron", "exec", "conversations_send"].map(makeTool));
const dependencies = { createOpenClawToolsAsync: createOpenClawToolsAsyncMock };
const sessionDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "openclaw-skill-delegated-policy-",
);

const dispatchDefaults = {
  message: { surface: "telegram", senderId: "user-1" },
  cfg: {},
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:user-1",
  workspaceDir: "/tmp/openclaw-skill-tool-dispatch-test",
  provider: "openai",
  model: "gpt-5.5",
  senderIsOwner: true,
} satisfies Parameters<typeof resolveSkillDispatchTools>[0];
const dispatch = (
  params: Partial<Parameters<typeof resolveSkillDispatchTools>[0]> = {},
  deps: SkillToolDispatchDependencies = dependencies,
) => resolveSkillDispatchTools({ ...dispatchDefaults, ...params }, deps);
const toolNames = (tools: Awaited<ReturnType<typeof dispatch>>) => tools.map((tool) => tool.name);
const lastArgs = () => createOpenClawToolsAsyncMock.mock.calls.at(-1)?.[0];
const liveDispatch = (params: Parameters<typeof dispatch>[0]) =>
  dispatch(params, { createOpenClawToolsAsync });

beforeEach(() => {
  // Exercise auth-source preparation even on hosts with configured search providers.
  for (const name of listKnownProviderAuthEnvVarNamesCore({ config: {} })) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  [{ surface: "webchat" }, false, true],
  [{ surface: "whatsapp" }, false, false],
  [{ surface: "webchat" }, true, false],
  [{ surface: "unknown-channel", provider: "webchat" }, false, false],
] as const)(
  "gates ask_user on the inbound %j surface (deny: %s)",
  async (message, deny, available) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { allow: ["ask_user"], deny: deny ? ["ask_user"] : [] },
    };
    setRuntimeConfigSnapshot(cfg);
    const tools = await liveDispatch({ message, cfg });
    expect(tools.some((tool) => tool.name === "ask_user")).toBe(available);
  },
);

it.each([
  [{ profile: "coding" }, ["update.run"]],
  [{ profile: "full" }, ["config.get", "config.schema.lookup", "update.run"]],
  [
    { profile: "messaging", alsoAllow: ["gateway"] },
    ["config.get", "config.schema.lookup", "update.run"],
  ],
] satisfies Array<[OpenClawConfig["tools"], string[]]>)(
  "limits gateway actions to the skill dispatch policy: %j",
  async (toolPolicy, actions) => {
    const config: OpenClawConfig = { plugins: { enabled: false }, tools: toolPolicy };
    setRuntimeConfigSnapshot(config);
    const tools = await liveDispatch({
      message: { surface: "webchat" },
      cfg: config,
      sessionKey: "agent:main:main",
    });

    expect(tools.find((tool) => tool.name === "gateway")?.parameters).toHaveProperty(
      "properties.action.enum",
      actions,
    );
  },
);

it.each([
  { agentId: "isolated", expectedTools: ["read"] },
  { agentId: "direct", expectedTools: ["read", "cron", "exec", "conversations_send"] },
])(
  "applies $agentId sandbox policy to global skill dispatch",
  async ({ agentId, expectedTools }) => {
    const tools = await dispatch({
      message: { surface: "webchat" },
      cfg: {
        session: { scope: "global" },
        agents: {
          entries: {
            isolated: {
              sandbox: { mode: "all" },
              tools: { sandbox: { tools: { allow: ["read"] } } },
            },
            direct: { sandbox: { mode: "off" } },
          },
        },
      },
      agentId,
      sessionKey: "global",
      model: "gpt-5.6-luna",
    });

    expect(toolNames(tools)).toEqual(expectedTools);
  },
);

it("passes final filtered tool surface to cron jobs", async () => {
  const tools = await dispatch({
    message: { ...dispatchDefaults.message, nativeChannelId: "native-room-1" },
    cfg: { tools: { allow: ["read", "cron"] } },
    sessionKey: "agent:main:telegram:group:restricted-room",
  });

  expect(toolNames(tools)).toEqual(["read", "cron"]);
  expect(lastArgs()?.cronCreatorToolAllowlist).toEqual([{ name: "read" }, { name: "automations" }]);
  expect(lastArgs()).toMatchObject({
    nativeChannelId: "native-room-1",
    sessionConfigSource: "runtime",
  });
});

it("carries command skill file identity into tool diagnostics", async () => {
  await dispatch({
    skillCommand: {
      name: "daily-brief",
      skillFile: "/workspace/skills/daily-brief/SKILL.md",
      skillName: "Daily Brief",
      skillSource: "workspace",
      toolName: "read",
    },
  });

  expect(lastArgs()?.beforeToolCallHookContext?.skillCommand?.skillFile).toBe(
    "/workspace/skills/daily-brief/SKILL.md",
  );
});

it("uses persisted delegated policy instead of a sender wildcard", async () => {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const sessionKey = "agent:main:subagent:skill-child";
  const config: OpenClawConfig = {
    session: { store: storePath },
    tools: {
      toolsBySender: { "*": { deny: ["group:runtime", "group:fs"] }, "id:alice": {} },
    },
  };
  setRuntimeConfigSnapshot(config);
  await replaceSessionEntry({ storePath, sessionKey }, {
    sessionId: "skill-child-session",
    updatedAt: Date.now(),
    spawnedBy: "agent:main:telegram:direct:alice",
    spawnDepth: 1,
    subagentRole: "orchestrator",
    subagentControlScope: "children",
    inheritedToolPolicyVersion: 1,
  } as SessionEntry);

  const tools = await dispatch({ message: { surface: "telegram" }, cfg: config, sessionKey });

  expect(toolNames(tools)).toEqual(expect.arrayContaining(["read", "exec"]));
});

it.each([false, true])("filters owner-only tools with senderIsOwner=%s", async (senderIsOwner) => {
  const tools = await dispatch({
    message: { surface: "telegram", senderId: "allowed-user" },
    sessionKey: "agent:main:telegram:direct:allowed-user",
    senderIsOwner,
  });
  expect(toolNames(tools).includes("conversations_send")).toBe(senderIsOwner);
  expect(lastArgs()?.pluginToolDenylist).toEqual(expect.any(Array));
  expect(lastArgs()).toMatchObject({
    senderIsOwner,
    pluginToolDenylist: senderIsOwner
      ? expect.not.arrayContaining(["conversations_send"])
      : expect.arrayContaining([...GATEWAY_OWNER_ONLY_CORE_TOOLS]),
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async () => ({
    payloads: [{ text: "Dashboard prepared" }],
    meta: { durationMs: 1 },
  })),
}));

let state: OpenClawTestState | undefined;
const followupSessionKey = "agent:main:followup-payload-proof";
afterEach(async () => {
  await state?.cleanup();
  clearRuntimeConfigSnapshot();
  setAbortMemory(followupSessionKey, false);
  vi.clearAllMocks();
});

async function createCommandReplyFixture(label: string, sessionKey: string) {
  const fixture = await createOpenClawTestState({
    label,
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  state = fixture;
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        workspace: fixture.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    commands: { text: true },
  });
  await fixture.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  return {
    fixture,
    async reply(
      body: string,
      source: "text" | "native" | "omitted",
      opts?: InternalGetReplyOptions,
      authorized = true,
    ) {
      const reply = await getReplyFromConfig(
        finalizeInboundContext({
          Body: body,
          ...(source === "omitted" ? {} : { CommandSource: source }),
          CommandAuthorized: authorized,
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          SessionKey: sessionKey,
          ...(source === "native" ? { CommandTargetSessionKey: sessionKey } : {}),
        }),
        opts,
        cfg,
      );
      expect([reply].flat()).toEqual([
        expect.objectContaining({
          text: authorized ? "Dashboard prepared" : "You are not authorized to use this command.",
        }),
      ]);
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(authorized ? 1 : 0);
      return vi.mocked(runEmbeddedAgent).mock.calls[0]?.[0];
    },
  };
}

it.each([
  { source: "text", authorized: true },
  { source: "native", authorized: true },
  { source: "native", authorized: false },
] as const)(
  "preserves dashboard skill ownership for $source with authorized=$authorized",
  async ({ source, authorized }) => {
    const { fixture, reply } = await createCommandReplyFixture(
      "dashboard-reply",
      "agent:main:dashboard-proof",
    );
    const skillDir = path.join(fixture.workspaceDir, "skills", "control-ui");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: control-ui\ndescription: Workspace dashboard skill collision.\n---\nWorkspace-specific instructions.\n",
    );
    const input = await reply("/dashboard release health", source, undefined, authorized);
    if (!authorized) {
      return;
    }
    expect(input?.explicitSkillSelections).toEqual([
      { name: "control_ui", path: path.resolve("skills/control-ui/SKILL.md") },
    ]);
    expect(input?.prompt).toContain("release health");
    expect(input?.prompt.match(/Use the following explicitly referenced skills/gu)).toHaveLength(1);
  },
);

it.each([
  { source: "text", payload: "/queue interrupt" },
  { source: "native", payload: "/queue interrupt" },
  { source: "omitted", payload: "/queue interrupt" },
  { source: "text", payload: "/stop" },
  { source: "native", payload: "/stop" },
  { source: "omitted", payload: "/stop" },
] as const)(
  "passes /followup payload $payload literally through $source command admission",
  async ({ source, payload }) => {
    const { fixture, reply } = await createCommandReplyFixture(
      "followup-payload",
      followupSessionKey,
    );
    const target = {
      sessionKey: followupSessionKey,
      storePath: path.join(fixture.sessionsDir(), "sessions.json"),
    };
    await replaceSessionEntry(target, {
      sessionId: "followup-payload-session",
      updatedAt: Date.now(),
      queueMode: "collect",
      abortedLastRun: false,
    });
    const onBlockReply = vi.fn();
    const input = await reply(`/followup ${payload}`, source, { onBlockReply });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(input?.prompt).toContain(payload);
    expect(input?.prompt).not.toContain("/followup");
    expect(loadExactSessionEntry(target)?.entry).toMatchObject({
      sessionId: "followup-payload-session",
      queueMode: "collect",
      abortedLastRun: false,
    });
    expect(getAbortMemory(followupSessionKey)).toBeUndefined();
  },
);

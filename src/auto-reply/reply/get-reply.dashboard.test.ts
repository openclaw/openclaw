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

async function createCommandReplyFixture(label: string) {
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
  return { fixture, cfg };
}

it.each([
  { source: "text", authorized: true },
  { source: "native", authorized: true },
  { source: "native", authorized: false },
] as const)(
  "preserves dashboard skill ownership for $source with authorized=$authorized",
  async ({ source, authorized }) => {
    const { fixture, cfg } = await createCommandReplyFixture("dashboard-reply");
    const skillDir = path.join(fixture.workspaceDir, "skills", "control-ui");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: control-ui\ndescription: Workspace dashboard skill collision.\n---\nWorkspace-specific instructions.\n",
    );
    const body = "/dashboard release health";
    const sessionKey = "agent:main:dashboard-proof";
    const reply = await getReplyFromConfig(
      finalizeInboundContext({
        Body: body,
        RawBody: body,
        BodyForAgent: body,
        CommandBody: body,
        CommandSource: source,
        CommandAuthorized: authorized,
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: sessionKey,
        ...(source === "native" ? { CommandTargetSessionKey: sessionKey } : {}),
      }),
      undefined,
      cfg,
    );
    if (!authorized) {
      expect([reply].flat()).toEqual([
        expect.objectContaining({ text: "You are not authorized to use this command." }),
      ]);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      return;
    }
    expect([reply].flat()).toEqual([expect.objectContaining({ text: "Dashboard prepared" })]);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
    expect(input.explicitSkillSelections).toEqual([
      { name: "control_ui", path: path.resolve("skills/control-ui/SKILL.md") },
    ]);
    expect(input.prompt).toContain("release health");
    expect(input.prompt.match(/Use the following explicitly referenced skills/gu)).toHaveLength(1);
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
    const { fixture, cfg } = await createCommandReplyFixture("followup-payload");
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
    const body = `/followup ${payload}`;
    const onBlockReply = vi.fn();
    const reply = await getReplyFromConfig(
      finalizeInboundContext({
        Body: body,
        RawBody: body,
        BodyForAgent: body,
        CommandBody: body,
        ...(source === "omitted" ? {} : { CommandSource: source }),
        CommandAuthorized: true,
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: followupSessionKey,
        ...(source === "native" ? { CommandTargetSessionKey: followupSessionKey } : {}),
      }),
      { onBlockReply },
      cfg,
    );

    expect(onBlockReply).not.toHaveBeenCalled();
    expect([reply].flat()).toEqual([expect.objectContaining({ text: "Dashboard prepared" })]);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
    expect(input.prompt).toContain(payload);
    expect(input.prompt).not.toContain("/followup");
    expect(loadExactSessionEntry(target)?.entry).toMatchObject({
      sessionId: "followup-payload-session",
      queueMode: "collect",
      abortedLastRun: false,
    });
    expect(getAbortMemory(followupSessionKey)).toBeUndefined();
  },
);

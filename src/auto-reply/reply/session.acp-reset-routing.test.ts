import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
} from "../../infra/outbound/session-binding-service.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../../infra/channel-summary.js", () => ({ buildChannelSummary: vi.fn(async () => []) }));
const roots: string[] = [];
async function createStorePath(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return path.join(root, "sessions.json");
}
afterEach(async () => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  await closeOpenClawStateDatabaseAsync();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
describe("bound ACP reset routing", () => {
  it.each(["/new", "/reset", "/new continue", "/reset continue"])(
    "keeps the transport session unchanged before handling dynamically bound %s",
    async (body) => {
      const storePath = await createStorePath("openclaw-transport-acp-reset-");
      const sourceKey = "agent:main:main";
      const boundKey = "agent:main:acp:bound-reset";
      await writeSessionStoreFast(storePath, {
        [sourceKey]: { sessionId: "source-session", updatedAt: Date.now(), systemSent: true },
        [boundKey]: { sessionId: "bound-session", updatedAt: Date.now(), systemSent: true },
      });
      await getSessionBindingService().bind({
        targetSessionKey: boundKey,
        targetKind: "session",
        conversation: { channel: "webchat", accountId: "default", conversationId: "main" },
        placement: "current",
      });
      const result = await initSessionState({
        ctx: {
          RawBody: body,
          CommandBody: body,
          CommandSource: "text",
          CommandAuthorized: true,
          Provider: "webchat",
          Surface: "webchat",
          From: "main",
          To: "main",
          SessionKey: "main",
        },
        cfg: { session: { store: storePath } },
      });
      expect(result.sessionKey).toBe(sourceKey);
      expect(result.sessionId).toBe("source-session");
      expect(result.resetTriggered).toBe(false);
      expect(result.isNewSession).toBe(false);
    },
  );
  it.each([
    {
      name: "defers /new lifecycle rotation to the bound ACP reset handler",
      body: "/new",
      to: "1478836151241412759",
      includeBinding: true,
      expectedRotation: false,
    },
    {
      name: "defers /reset lifecycle rotation to the bound ACP reset handler",
      body: "/reset",
      to: "1478836151241412759",
      includeBinding: true,
      expectedRotation: false,
    },
    {
      name: "rotates local session state for ACP /new when no matching conversation binding exists",
      body: "/new",
      to: "user:12345",
      originatingTo: "user:12345",
      includeBinding: false,
      expectedRotation: true,
    },
    {
      name: "keeps custom reset triggers working on bound ACP sessions",
      body: "/fresh",
      to: "1478836151241412759",
      includeBinding: true,
      resetTriggers: ["/fresh"],
      expectedRotation: true,
    },
    {
      name: "keeps normal /new behavior for unbound ACP-shaped session keys",
      body: "/new",
      to: "1478836151241412759",
      includeBinding: false,
      expectedRotation: true,
    },
  ])("$name", async (scenario) => {
    const storePath = await createStorePath("openclaw-rawbody-acp-reset-");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: existingSessionId, updatedAt: Date.now(), systemSent: true },
    });
    const bindings = scenario.includeBinding
      ? [
          {
            type: "acp" as const,
            agentId: "codex",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel" as const, id: "1478836151241412759" },
            },
            acp: { mode: "persistent" as const },
          },
        ]
      : undefined;
    const result = await initSessionState({
      ctx: {
        RawBody: scenario.body,
        CommandBody: scenario.body,
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: scenario.to,
        OriginatingTo: "originatingTo" in scenario ? scenario.originatingTo : undefined,
        SessionKey: sessionKey,
      },
      cfg: {
        session: {
          store: storePath,
          ...("resetTriggers" in scenario ? { resetTriggers: scenario.resetTriggers } : {}),
        },
        ...(bindings ? { bindings } : {}),
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig,
    });

    expect(result.resetTriggered).toBe(scenario.expectedRotation);
    expect(result.isNewSession).toBe(scenario.expectedRotation);
    if (scenario.expectedRotation) {
      expect(result.sessionId).not.toBe(existingSessionId);
    } else {
      expect(result.sessionId).toBe(existingSessionId);
    }
  });
});

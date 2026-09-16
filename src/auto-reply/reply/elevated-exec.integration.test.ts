/** Channel directive reporting and real exec share the prepared elevation decision. */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExecHostResolver } from "../../agents/bash-tools.exec-support.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { createMockTypingController } from "./reply.test-helpers.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  createModelSelectionState: vi.fn(async (params) => createModelSelectionStateFixture(params)),
}));

describe("channel elevated execution reporting", () => {
  it("reports the same implicit host that the next normal exec actually uses", async () => {
    await withOpenClawTestState({ prefix: "elevated-exec-proof-" }, async (state) => {
      const cfg: OpenClawConfig = {
        commands: { text: true },
        agents: {
          entries: { main: { default: true } },
          defaults: { workspace: state.workspaceDir, sandbox: { mode: "all" } },
        },
        tools: {
          exec: { host: "auto", security: "full", ask: "off" },
          elevated: { allowFrom: { whatsapp: ["owner"] } },
        },
        session: { store: path.join(state.sessionsDir("main"), "sessions.sqlite") },
      };
      const sessionKey = "agent:main:whatsapp:default:direct:owner";
      const sessionEntry: SessionEntry = { sessionId: "elevated-proof", updatedAt: Date.now() };
      const resolve = (body: string) => {
        const ctx = buildTestCtx({
          Body: body,
          CommandBody: body,
          From: "whatsapp:owner",
          SenderId: "owner",
          CommandAuthorized: true,
          SessionKey: sessionKey,
          CommandTurn: body.startsWith("/")
            ? { kind: "text-slash", source: "text", authorized: true, body }
            : undefined,
        });
        return resolveReplyDirectives({
          ctx,
          cfg,
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          agentCfg: cfg.agents?.defaults,
          sessionCtx: ctx,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath: cfg.session?.store,
          sessionScope: "per-sender",
          conversation: prepareReplyConversation({ ctx, sessionEntry }),
          isGroup: false,
          triggerBodyNormalized: body,
          resetTriggered: false,
          commandAuthorized: true,
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4-6",
          provider: "anthropic",
          model: "claude-opus-4-6",
          aliasIndex: { byAlias: new Map(), byKey: new Map() },
          hasResolvedHeartbeatModelOverride: false,
          typing: createMockTypingController(),
        });
      };
      const query = await resolve("/exec");
      expect(query.kind).toBe("reply");
      if (query.kind !== "reply") {
        throw new Error("expected command reply");
      }
      expect(query.reply).toMatchObject({ text: expect.stringContaining("effective=gateway") });
      const turn = await resolve("print a marker");
      if (turn.kind !== "continue") {
        throw new Error("expected normal turn");
      }
      const defaults = {
        config: cfg,
        agentId: "main",
        host: "auto" as const,
        cwd: state.workspaceDir,
        security: "full" as const,
        ask: "off" as const,
        nonInteractiveApproval: true,
        elevated: {
          enabled: turn.result.elevatedEnabled,
          allowed: turn.result.elevatedAllowed,
          defaultLevel: turn.result.resolvedElevatedLevel,
        },
        sandbox: {
          containerName: "must-not-run",
          workspaceDir: state.workspaceDir,
          containerWorkdir: "/workspace",
          buildExecSpec: async () => {
            throw new Error("incorrect sandbox execution");
          },
        },
      };
      expect(createExecHostResolver(defaults)({ command: "printf elevated-proof" })).toBe(
        "gateway",
      );
      const result = await createExecTool(defaults).execute("elevated-proof", {
        command: "printf elevated-proof",
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("elevated-proof"),
          }),
        ]),
      );
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    });
  });
});

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { VisibleWorkSession } from "../get-reply-options.types.js";
import {
  rootDir,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

// Hoist mocks before loading the shared fixture's runtime dependencies.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});
await import("./agent-runner.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent visible work delivery", () => {
  it.each(["completed", "failed", "hidden"] as const)(
    "reports accepted visible work before final dispatch for a %s run",
    async (outcome) => {
      const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
      const { createReplyDispatcher } = await import("./reply-dispatcher.js");
      const order: string[] = [];
      const visibleWork: VisibleWorkSession[][] = [];
      const visible = {
        runId: "visible-run",
        childSessionKey: "agent:main:dashboard:visible-work",
        sessionUrl: "https://openclaw.example/chat/main/visible-work",
        label: "Review",
      };
      runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "Finished", ...(outcome === "failed" ? { isError: true } : {}) }],
        acceptedSessionSpawns: [
          { runId: "hidden-run", childSessionKey: "agent:main:subagent:hidden" },
          ...(outcome === "hidden" ? [] : [visible, { ...visible, runId: "duplicate-run" }]),
        ],
        meta: outcome === "failed" ? { error: { kind: "unknown", message: "Run failed" } } : {},
      });
      const storePath = path.join(rootDir, "sessions.sqlite");
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: rootDir } },
        session: { store: storePath },
        plugins: { enabled: false },
      };
      const sessionEntry = { sessionId: "session", updatedAt: Date.now() };
      await replaceSessionEntry({ storePath, sessionKey: "agent:main:main" }, sessionEntry);
      const ctx = buildTestCtx({
        Body: "Start visible work",
        SessionKey: "agent:main:main",
        MessageSid: `visible-work-${outcome}`,
      });
      const dispatcher = createReplyDispatcher({
        deliver: async (_payload, info) => {
          order.push(info.kind);
        },
      });
      try {
        await dispatchReplyFromConfig({
          ctx,
          cfg,
          dispatcher,
          replyOptions: {
            onVisibleWorkSessions: (sessions) => {
              visibleWork.push([...sessions]);
              order.push("visible-work");
            },
          },
          replyResolver: async (_ctx, opts) =>
            createBaseRun({
              context: ctx,
              run: { config: cfg, sessionKey: ctx.SessionKey },
              reply: {
                opts,
                replyOperation: opts?.replyOperation,
                sessionKey: ctx.SessionKey,
                storePath,
                sessionEntry,
                sessionStore: { "agent:main:main": sessionEntry },
              },
            }).run(),
        });
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }

      expect(visibleWork).toEqual(
        outcome === "hidden"
          ? []
          : [[{ sessionKey: visible.childSessionKey, url: visible.sessionUrl, label: "Review" }]],
      );
      expect(order).toEqual(outcome === "hidden" ? ["final"] : ["visible-work", "final"]);
    },
  );
});

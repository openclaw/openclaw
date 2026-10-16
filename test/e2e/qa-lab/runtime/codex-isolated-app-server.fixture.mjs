import path from "node:path";
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
  runFakeCodexAppServer,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";
const version = process.env.OPENCLAW_QA_CODEX_APP_SERVER_VERSION;
let account;
runFakeCodexAppServer({
  requestLog: process.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG,
  logMode: "messages",
  handlers: {
    initialize: ({ sendResult }) =>
      sendResult(
        createFakeInitializeResponse({
          name: "isolated-codex-proof",
          version,
          userAgent: `openclaw/${version} (test)`,
        }),
      ),
    "account/login/start": ({ params, sendResult }) => {
      account = params.chatgptAccountId;
      sendResult({ type: params.type });
    },
    "account/read": ({ sendResult }) =>
      sendResult({
        account: { type: "chatgpt", id: account, email: "synthetic@example.test", planType: "pro" },
        requiresOpenaiAuth: true,
      }),
    "config/read": ({ sendResult }) =>
      sendResult({
        config: { features: { hooks: true, plugins: false }, project_root_markers: [] },
        origins: {},
        layers: [
          {
            name: { type: "user", file: path.join(process.env.CODEX_HOME, "config.toml") },
            config: {},
          },
        ],
      }),
    "hooks/list": ({ params, sendResult }) =>
      sendResult({
        data: params.cwds.map((cwd) => ({ cwd, hooks: [], errors: [], warnings: [] })),
        nextCursor: null,
      }),
    "mcpServerStatus/list": ({ sendResult }) => sendResult({ data: [], nextCursor: null }),
    "skills/list": ({ sendResult }) => sendResult({ data: [] }),
    "model/list": ({ sendResult }) =>
      sendResult({
        data: [
          {
            id: "gpt-test",
            model: "gpt-test",
            displayName: "Synthetic model",
            description: "Synthetic",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
            inputModalities: ["text"],
          },
        ],
        nextCursor: null,
      }),
    "thread/start": ({ params, sendResult }) =>
      sendResult(
        createFakeThreadStartResponse({
          params,
          threadId: "synthetic-thread",
          sessionId: "synthetic-session",
          version,
        }),
      ),
    "turn/start": ({ params, sendResult, notify }) => {
      if (account !== "synthetic-allowed-account") {
        throw new Error("Inference reached a forbidden account");
      }
      const turnId = "synthetic-turn";
      sendResult({
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setImmediate(() => {
        const item = {
          type: "agentMessage",
          id: "synthetic-message",
          text: `Completed as ${account}`,
        };
        notify("item/completed", { item, threadId: params.threadId, turnId });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: {
            id: turnId,
            items: [item],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
          },
        });
      });
    },
  },
});

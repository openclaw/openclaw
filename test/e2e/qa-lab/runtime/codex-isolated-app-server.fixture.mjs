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
    "turn/start": ({ completeTextTurn }) => {
      if (account !== "synthetic-allowed-account") {
        throw new Error("Inference reached a forbidden account");
      }
      completeTextTurn(() => `Completed as ${account}`);
    },
  },
});

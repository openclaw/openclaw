import { expect, it, vi } from "vitest";
import {
  OPENCLAW_QA_CODEX_API_KEY_HANDOFF,
  resolveQaCodexApiKeyEnvPatch as resolveHandoff,
} from "../../scripts/lib/qa-codex-auth-env.mts";
import { runNodeMain } from "./run-node-boundary.test-support.js";
import {
  QA_LAB_PLUGIN_SDK_ENTRY,
  QA_RUNTIME_PLUGIN_SDK_ENTRY,
  createCurrentGitSpawnRecorder,
  createExitedProcess,
  it as fixtureIt,
  setupStampedProject,
} from "./run-node.test-support.js";

const liveSuiteArgs = ["qa", "suite", "--provider-mode", "live-frontier"] as const;
const callerEnv = { CODEX_HOME: "/host/.codex", OPENCLAW_RUNNER_LOG: "0" };
const apiKey = "synthetic-qa-api-key";
const keyReader = () =>
  vi.fn(() => ({ type: "api_key" as const, provider: "openai" as const, key: apiKey }));
const readOptions = { codexHome: callerEnv.CODEX_HOME, allowKeychainPrompt: false };

it("preserves missing-auth rejection by returning no handoff", () => {
  const readCodexApiKey = vi.fn(() => null);

  const patch = resolveHandoff({ args: liveSuiteArgs, env: callerEnv, readCodexApiKey });
  expect(patch).toBeUndefined();
  expect(readCodexApiKey).toHaveBeenCalledExactlyOnceWith(readOptions);
});

it.each([
  ["boolean root option", ["qa", "--no-color", "suite", "--provider-mode", "live-frontier"]],
  ["valued root option", ["qa", "--log-level", "debug", "suite", "--provider-mode=live-frontier"]],
] as const)("recognizes a live suite with a %s between command tokens", (_name, args) => {
  const readCodexApiKey = keyReader();
  expect(resolveHandoff({ args, env: callerEnv, readCodexApiKey })).toEqual({
    [OPENCLAW_QA_CODEX_API_KEY_HANDOFF]: apiKey,
  });
  expect(readCodexApiKey).toHaveBeenCalledOnce();
});

it.each([
  ["non-live QA", ["qa", "suite", "--provider-mode", "mock-openai"], {}],
  ["unrelated command", ["status"], {}],
  ["explicit OpenAI key", liveSuiteArgs, { OPENAI_API_KEY: "explicit-key" }],
  ["explicit Codex key", liveSuiteArgs, { CODEX_API_KEY: "explicit-key" }],
] as const)("does not read Codex auth for %s", (_name, args, env) => {
  const readCodexApiKey = vi.fn(() => {
    throw new Error("unexpected credential read");
  });

  expect(resolveHandoff({ args, env, readCodexApiKey })).toBeUndefined();
  expect(readCodexApiKey).not.toHaveBeenCalled();
});
fixtureIt(
  "passes an active API-key-only login through the real QA launcher child boundary",
  async ({ tmp }) => {
    await setupStampedProject(tmp, {
      trackConfig: true,
      files: {
        [QA_LAB_PLUGIN_SDK_ENTRY]: "export {};\n",
        [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export {};\n",
      },
    });
    const readCodexApiKey = keyReader();
    let launchedEnv: NodeJS.ProcessEnv | undefined;
    const spawn = vi.fn(
      (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        launchedEnv = options.env;
        return createExitedProcess(0);
      },
    );
    const { spawnSync } = createCurrentGitSpawnRecorder();

    await expect(
      runNodeMain({
        cwd: tmp,
        args: [...liveSuiteArgs],
        env: callerEnv,
        spawn,
        spawnSync,
        readCodexApiKey,
        runRuntimePostBuild: async () => {},
      }),
    ).resolves.toBe(0);
    expect(launchedEnv?.[OPENCLAW_QA_CODEX_API_KEY_HANDOFF]).toBe(apiKey);
    expect(launchedEnv).not.toHaveProperty("CODEX_API_KEY");
    expect(callerEnv).toEqual({ CODEX_HOME: "/host/.codex", OPENCLAW_RUNNER_LOG: "0" });
    expect(readCodexApiKey).toHaveBeenCalledExactlyOnceWith(readOptions);
  },
);

import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { providerResponse } from "../agents/embedded-agent-runner.wire.test-support.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

// Loopback stubs named by role: the pinned model always fails with 401 on purpose; the others answer.
const providerUrls = {
  pinned: "http://127.0.0.1:11434/v1",
  primary: "http://127.0.0.1:11435/v1",
  fallback: "http://127.0.0.1:11436/v1",
  jobfallback: "http://127.0.0.1:11437/v1",
} as const;

function stubProvider(baseUrl: string, id: string) {
  return {
    api: "openai-responses" as const,
    baseUrl,
    agentRuntime: { id: "openclaw" },
    models: [modelDefinition(id, { reasoning: false, contextWindow: 128_000, maxTokens: 1024 })],
  };
}

beforeEach(bindSessionMcpRuntimeTestScheduler);

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  vi.restoreAllMocks();
});

type ModelCase = [
  string,
  SessionEntry["modelOverrideSource"],
  { model?: string; fallbacks?: string[] } | undefined,
  string[],
];
it.each<ModelCase>([
  ["user pin", "user", undefined, []],
  ["legacy pin", undefined, undefined, []],
  ["explicit fallbacks", "user", { fallbacks: ["jobfallback/model-c"] }, ["jobfallback/model-c"]],
  ["its own model", "user", { model: "pinned/model-x" }, ["fallback/model-b"]],
])(
  "honors stored cron session fallback policy for %s",
  async (_name, modelOverrideSource, payload, expected) => {
    await withOpenClawTestState({ label: "cron-session-model" }, async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      const requests: string[] = [];
      const providerFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || !request.url.endsWith("/responses")) {
          throw new Error(`Unexpected external I/O in cron session model fixture: ${request.url}`);
        }
        const body = (await request.json()) as { model?: string };
        const route = Object.entries(providerUrls).find(([, url]) =>
          request.url.startsWith(url),
        )?.[0];
        requests.push(`${route ?? "unknown"}/${body.model}`);
        if (route === "pinned") {
          return Response.json(
            {
              error: {
                message: "Incorrect API key provided.",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            },
            { status: 401 },
          );
        }
        return providerResponse({
          api: "openai-responses",
          model: body.model ?? "unknown",
          id: "resp_synthetic",
          messageId: "msg_synthetic",
          text: "answered",
          calls: [],
        }).response;
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(providerFetch);
      vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(providerFetch);
      const routeParams = { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } };
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: {
            model: { primary: "primary/model-a", fallbacks: ["fallback/model-b"] },
            models: {
              "pinned/model-x": routeParams,
              "primary/model-a": routeParams,
              "fallback/model-b": routeParams,
              "jobfallback/model-c": routeParams,
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            // Credentialless loopback routes, so each route's own account check admits it.
            pinned: stubProvider(providerUrls.pinned, "model-x"),
            primary: stubProvider(providerUrls.primary, "model-a"),
            fallback: stubProvider(providerUrls.fallback, "model-b"),
            jobfallback: stubProvider(providerUrls.jobfallback, "model-c"),
          },
        },
        plugins: { allow: ["openai"], slots: { memory: "none" } },
        skills: { load: { watch: false } },
        tools: { deny: ["*"] },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const stored: CronStoredJob = cronTestJob({
        id: "session-model",
        agentId: "main",
        delivery: { mode: "none" },
        payload: {
          kind: "agentTurn",
          message: "Reply.",
          lightContext: true,
          ...payload,
        },
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:cron:session-model" },
        {
          sessionId: "pinned-session",
          updatedAt: Date.now(),
          providerOverride: "pinned",
          modelOverride: "model-x",
          modelOverrideSource,
        },
      );
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs: [stored] });
      const job = (await loadCronJobsStore(storePath)).jobs[0]!;
      const result = await runCronIsolatedAgentTurn({
        occurrence: TEST_SCHEDULED_OCCURRENCE,
        cfg,
        deps: {},
        job,
        deliveryAttemptFence: null,
        message: "Reply.",
        sessionKey: "cron:session-model",
        lane: "cron",
      });
      expect(requests).toEqual(["pinned/model-x", ...expected]);
      expect(result.status, result.error).toBe(expected.length ? "ok" : "error");
      if (!expected.length) {
        expect(result.error).toContain("invalid_api_key");
      }
    });
  },
);

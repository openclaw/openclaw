import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

// Loopback stubs named by role: the pinned model always fails with 401 on purpose; the others answer.
const providerUrls = {
  pinned: "http://127.0.0.1:11434/v1",
  primary: "http://127.0.0.1:11435/v1",
  fallback: "http://127.0.0.1:11436/v1",
  jobfallback: "http://127.0.0.1:11437/v1",
} as const;

function completedResponse(model: string): Response {
  const item = {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "answered", annotations: [] }],
  };
  const response = { id: "resp_synthetic", model, status: "in_progress", output: [] };
  const events = [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function stubProvider(baseUrl: string, model: string) {
  return {
    api: "openai-responses" as const,
    baseUrl,
    agentRuntime: { id: "openclaw" },
    models: [catalogModel(model)],
  };
}

function catalogModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1024,
  };
}

beforeEach(bindSessionMcpRuntimeTestScheduler);

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  vi.restoreAllMocks();
});

describe("stored cron session model selections through the real embedded runner", () => {
  async function runWithFailingPinnedModel(params: {
    storedSelection: Pick<SessionEntry, "modelOverrideSource">;
    payload?: { model?: string; fallbacks?: string[] };
  }) {
    return await withOpenClawTestState({ label: "cron-session-model" }, async (state) => {
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
        return completedResponse(body.model ?? "unknown");
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
      const stored: CronStoredJob = {
        id: "session-model",
        name: "Session model",
        agentId: "main",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        delivery: { mode: "none" },
        payload: {
          kind: "agentTurn",
          message: "Reply.",
          lightContext: true,
          ...params.payload,
        },
        state: {},
      };
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:cron:session-model" },
        {
          sessionId: "pinned-session",
          updatedAt: Date.now(),
          providerOverride: "pinned",
          modelOverride: "model-x",
          ...params.storedSelection,
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
      return { result, requests };
    });
  }

  it.each([
    { name: "user", storedSelection: { modelOverrideSource: "user" as const } },
    { name: "legacy", storedSelection: {} },
  ])(
    "reports a failed $name session selection instead of answering from a configured fallback",
    async ({ storedSelection }) => {
      const { result, requests } = await runWithFailingPinnedModel({ storedSelection });

      expect(requests).toEqual(["pinned/model-x"]);
      expect(result.status).toBe("error");
      expect(result.error).toContain("invalid_api_key");
    },
  );

  it.each([
    {
      // Distinct from the configured fallback, so the job's own list is what answers.
      name: "explicit fallbacks",
      payload: { fallbacks: ["jobfallback/model-c"] },
      expected: ["pinned/model-x", "jobfallback/model-c"],
    },
    {
      name: "its own model",
      payload: { model: "pinned/model-x" },
      expected: ["pinned/model-x", "fallback/model-b"],
    },
  ])(
    "keeps falling back for a pinned session when the job sets $name",
    async ({ payload, expected }) => {
      const { result, requests } = await runWithFailingPinnedModel({
        storedSelection: { modelOverrideSource: "user" },
        payload,
      });

      expect(requests).toEqual(expected);
      expect(result.status, result.error).toBe("ok");
    },
  );
});

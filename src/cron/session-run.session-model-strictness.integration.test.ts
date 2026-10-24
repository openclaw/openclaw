import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshSessionPatchQueuedSelection } from "../gateway/server-methods/sessions-patch-model-selection.js";
import "../llm/ai-transport-host.js";
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const admission = vi.hoisted(() => ({
  onEnqueued: undefined as ((sessionKey: string) => void) | undefined,
  whileQueuedAdmissionWaits: undefined as ((sessionKey: string) => Promise<void>) | undefined,
}));

// The real queue runs; this only reports when a turn has been queued behind an active one.
vi.mock("../auto-reply/reply/queue/enqueue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/reply/queue/enqueue.js")>();
  return {
    ...actual,
    enqueueFollowupRun: (...args: Parameters<typeof actual.enqueueFollowupRun>) => {
      const enqueued = actual.enqueueFollowupRun(...args);
      if (enqueued) {
        admission.onEnqueued?.(args[0]);
      }
      return enqueued;
    },
  };
});

// The real admission owner runs; a test may commit one settings write once a source has
// entered it, before its selection fence.
vi.mock("../auto-reply/reply/reply-turn-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/reply/reply-turn-admission.js")>();
  return {
    ...actual,
    admitReplyTurn: async (...args: Parameters<typeof actual.admitReplyTurn>) => {
      // Only reply-turn preparation passes the selection fence; dispatch admission does not.
      const write = args[0].captureRunSelection ? admission.whileQueuedAdmissionWaits : undefined;
      if (write) {
        admission.whileQueuedAdmissionWaits = undefined;
        await write(args[0].sessionKey);
      }
      return await actual.admitReplyTurn(...args);
    },
  };
});

// Match Gateway startup: scheduled session turns settle through the real reply runtime.
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

// Loopback stubs named by role: the pinned model always fails with 401 on purpose; the others answer.
const providerUrls = {
  pinned: "http://127.0.0.1:11434/v1",
  primary: "http://127.0.0.1:11435/v1",
  fallback: "http://127.0.0.1:11436/v1",
  jobfallback: "http://127.0.0.1:11437/v1",
} as const;

const namedSessionKey = "agent:main:scheduled-pin";

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
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 1024,
      },
    ],
  };
}

beforeEach(bindSessionMcpRuntimeTestScheduler);

afterEach(async () => {
  admission.onEnqueued = undefined;
  admission.whileQueuedAdmissionWaits = undefined;
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  // Each case has its own state root; a prior case's controller would make the key ambiguous.
  resetSessionControllerStateForTest();
  vi.restoreAllMocks();
});

describe("stored session model selections in scheduled session turns", () => {
  async function runWithFailingPinnedModel(params: {
    storedSelection: Pick<SessionEntry, "modelOverrideSource">;
    target?: "main" | "session";
    payload?: { model?: string; fallbacks?: string[] };
    /** A system-event job carries text only: no job model, fallbacks or model policy. */
    payloadKind?: "systemEvent";
    storedPin?: { provider: string; model: string } | null;
    defaultPrimary?: string;
    modelAllow?: string[];
    /**
     * Queue the scheduled turn behind an active turn, then commit a sessions.patch model change
     * while the drained turn waits in admission.
     */
    retargetWhileAdmitting?: { pin: { provider: string; model: string } | null };
  }) {
    return await withOpenClawTestState({ label: "cron-session-turn-model" }, async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      const requests: string[] = [];
      const activeTurn = params.retargetWhileAdmitting && {
        pin: params.retargetWhileAdmitting.pin,
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      const providerFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || !request.url.endsWith("/responses")) {
          throw new Error(`Unexpected external I/O in scheduled session fixture: ${request.url}`);
        }
        const body = (await request.json()) as { model?: string };
        const route = Object.entries(providerUrls).find(([, url]) =>
          request.url.startsWith(url),
        )?.[0];
        requests.push(`${route ?? "unknown"}/${body.model}`);
        if (activeTurn && requests.length === 1) {
          // The first request belongs to the active turn; hold the session until the next one queues.
          activeTurn.started.resolve();
          await activeTurn.release.promise;
        }
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
            model: {
              primary: params.defaultPrimary ?? "primary/model-a",
              fallbacks: ["fallback/model-b"],
            },
            ...(params.modelAllow ? { modelPolicy: { allow: params.modelAllow } } : {}),
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
      // `main` resolves to the agent's main conversation, as the Gateway target resolver does.
      const sessionKey =
        params.target === "main"
          ? resolveAgentMainSessionKey({ cfg, agentId: "main" })
          : namedSessionKey;
      const stored: CronStoredJob = {
        id: "session-turn-model",
        name: "Session turn model",
        agentId: "main",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: params.target === "main" ? "main" : `session:${sessionKey}`,
        wakeMode: "now",
        delivery: { mode: "none" },
        payload:
          params.payloadKind === "systemEvent"
            ? { kind: "systemEvent", text: "Reply." }
            : { kind: "agentTurn", message: "Reply.", ...params.payload },
        state: {},
      };
      const conversation = {
        sessionId: "pinned-conversation",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
      };
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        params.storedPin === null
          ? conversation
          : {
              ...conversation,
              providerOverride: params.storedPin?.provider ?? "pinned",
              modelOverride: params.storedPin?.model ?? "model-x",
              ...params.storedSelection,
            },
      );
      const storePath = state.statePath("cron", "jobs.json");
      const activeJob: CronStoredJob = { ...stored, id: "active-turn", name: "Active turn" };
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: activeTurn ? [stored, activeJob] : [stored],
      });
      const [job, loadedActiveJob] = (await loadCronJobsStore(storePath)).jobs;
      const runTurn = (scheduled: CronStoredJob) =>
        runCronSessionTurn({
          occurrence: TEST_SCHEDULED_OCCURRENCE,
          cfg,
          agentId: "main",
          sessionKey,
          job: scheduled,
          text: "Reply.",
          admissionSource: "operator-schedule",
          deliveryAttemptFence: null,
          assertCurrent() {},
        });
      if (!activeTurn) {
        return { result: await runTurn(job!), requests };
      }
      let retargeted = false;
      admission.whileQueuedAdmissionWaits = async (admittedSessionKey) => {
        expect(admittedSessionKey).toBe(sessionKey);
        // Commit, then refresh waiting work, as sessions.patch does for a model change.
        const { pin } = activeTurn;
        const entry: SessionEntry = pin
          ? {
              ...conversation,
              providerOverride: pin.provider,
              modelOverride: pin.model,
              modelOverrideSource: "user",
            }
          : conversation;
        await replaceSessionEntry({ agentId: "main", sessionKey }, entry);
        refreshSessionPatchQueuedSelection({
          cfg,
          entry,
          patch: { key: sessionKey, model: pin ? `${pin.provider}/${pin.model}` : null },
          sessionKey,
          agentId: "main",
        });
        retargeted = true;
      };
      const queued = Promise.withResolvers<void>();
      admission.onEnqueued = (queuedSessionKey) => {
        if (queuedSessionKey === sessionKey) {
          queued.resolve();
        }
      };
      // A turn settling before its signal reports its own outcome instead of hanging the wait.
      const settledEarly = (turn: string) => (outcome: unknown) => {
        throw new Error(`${turn} turn settled early: ${JSON.stringify(outcome)}`);
      };
      const activeResult = runTurn(loadedActiveJob!);
      let pending: ReturnType<typeof runTurn> | undefined;
      try {
        await Promise.race([activeTurn.started.promise, activeResult.then(settledEarly("active"))]);
        pending = runTurn(job!);
        await Promise.race([queued.promise, pending.then(settledEarly("scheduled"))]);
      } finally {
        activeTurn.release.resolve();
        // Join both turns before the state root is torn down, on failure paths too.
        await Promise.allSettled([activeResult, pending]);
      }
      expect((await activeResult).status).toBe("ok");
      const result = await pending;
      expect(retargeted).toBe(true);
      return { result, requests };
    });
  }

  it.each([
    {
      name: "user",
      target: "session" as const,
      storedSelection: { modelOverrideSource: "user" as const },
    },
    { name: "legacy", target: "session" as const, storedSelection: {} },
    {
      name: "user",
      target: "main" as const,
      storedSelection: { modelOverrideSource: "user" as const },
    },
    { name: "legacy", target: "main" as const, storedSelection: {} },
  ])(
    "reports a failed $name selection in a $target turn instead of answering from a configured fallback",
    async ({ storedSelection, target }) => {
      const { result, requests } = await runWithFailingPinnedModel({ storedSelection, target });

      expect(requests).toEqual(["pinned/model-x"]);
      expect(result.status).toBe("error");
      // Session turns report the pinned model's 401 through the ordinary reply failure text.
      expect(result.error).toContain("Couldn't sign in to the AI service");
    },
  );

  it.each([
    { name: "user", storedSelection: { modelOverrideSource: "user" as const } },
    { name: "legacy", storedSelection: {} },
  ])(
    "reports a failed $name selection in a main system-event turn instead of answering from a configured fallback",
    async ({ storedSelection }) => {
      const { result, requests } = await runWithFailingPinnedModel({
        storedSelection,
        target: "main",
        payloadKind: "systemEvent",
      });

      expect(requests).toEqual(["pinned/model-x"]);
      expect(result.status).toBe("error");
      expect(result.error).toContain("Couldn't sign in to the AI service");
    },
  );

  it.each([
    {
      name: "an automatic session selection",
      storedSelection: { modelOverrideSource: "auto" as const },
      expected: ["pinned/model-x", "fallback/model-b"],
    },
    {
      // The session has no pin, so the failing default keeps the configured chain.
      name: "an unpinned session in a main system-event turn",
      storedSelection: {},
      storedPin: null,
      defaultPrimary: "pinned/model-x",
      target: "main" as const,
      payloadKind: "systemEvent" as const,
      expected: ["pinned/model-x", "fallback/model-b"],
    },
    {
      // Distinct from the configured fallback, so the job's own list is what answers.
      name: "a user selection with explicit job fallbacks",
      storedSelection: { modelOverrideSource: "user" as const },
      payload: { fallbacks: ["jobfallback/model-c"] },
      expected: ["pinned/model-x", "jobfallback/model-c"],
    },
    {
      name: "a user selection when the job sets its own model",
      storedSelection: { modelOverrideSource: "user" as const },
      payload: { model: "pinned/model-x" },
      expected: ["pinned/model-x", "fallback/model-b"],
    },
    {
      // Only the session-selection gate separates this from a strict run: the stored user pin
      // is disallowed, so the configured default (the failing stub here) runs instead.
      name: "a disallowed user selection that falls through to the default",
      storedSelection: { modelOverrideSource: "user" as const },
      storedPin: { provider: "primary", model: "model-a" },
      defaultPrimary: "pinned/model-x",
      modelAllow: ["pinned/*", "fallback/*"],
      expected: ["pinned/model-x", "fallback/model-b"],
    },
  ])("keeps falling back for $name", async ({ expected, ...selection }) => {
    const { result, requests } = await runWithFailingPinnedModel(selection);

    expect(requests).toEqual(expected);
    expect(result.status, result.error).toBe("ok");
  });

  describe("when the session model changes while a queued turn waits for admission", () => {
    it("falls back once the user pin is cleared", async () => {
      // The answering pin is cleared, so the failing default runs with its configured fallback.
      const { result, requests } = await runWithFailingPinnedModel({
        storedSelection: { modelOverrideSource: "user" },
        storedPin: { provider: "primary", model: "model-a" },
        defaultPrimary: "pinned/model-x",
        retargetWhileAdmitting: { pin: null },
      });

      // The active turn answers from the old pin; the queued turn runs the new selection.
      expect(requests).toEqual(["primary/model-a", "pinned/model-x", "fallback/model-b"]);
      expect(result.status, result.error).toBe("ok");
    });

    it("stays strict once the user pins a model", async () => {
      const { result, requests } = await runWithFailingPinnedModel({
        storedSelection: {},
        storedPin: null,
        retargetWhileAdmitting: { pin: { provider: "pinned", model: "model-x" } },
      });

      expect(requests).toEqual(["primary/model-a", "pinned/model-x"]);
      expect(result.status).toBe("error");
      expect(result.error).toContain("Couldn't sign in to the AI service");
    });

    it("keeps a queued main system-event turn strict once the user pins a model", async () => {
      const { result, requests } = await runWithFailingPinnedModel({
        storedSelection: {},
        storedPin: null,
        target: "main",
        payloadKind: "systemEvent",
        retargetWhileAdmitting: { pin: { provider: "pinned", model: "model-x" } },
      });

      expect(requests).toEqual(["primary/model-a", "pinned/model-x"]);
      expect(result.status).toBe("error");
      expect(result.error).toContain("Couldn't sign in to the AI service");
    });
  });
});

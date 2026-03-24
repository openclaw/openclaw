import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLegacyQueueSupervisorRelationClassifier,
  resolveSupervisorRelationClassifier,
} from "./classify.js";
import { SUPERVISOR_TAXONOMY_VERSION } from "./taxonomy.js";

describe("createLegacyQueueSupervisorRelationClassifier", () => {
  it("classifies using the legacy queue translation layer", async () => {
    const classifier = createLegacyQueueSupervisorRelationClassifier({
      queueMode: "steer",
    });

    await expect(
      classifier.classify({
        taxonomyVersion: SUPERVISOR_TAXONOMY_VERSION,
        event: {
          type: "user_message",
          category: "user",
          source: "slack",
          timestamp: 1,
          payload: { text: "not that, focus on performance" },
          urgency: "normal",
          scope: "foreground",
        },
        taskState: {
          sessionKey: "agent:main:thread-1",
          sessionId: "sess-1",
          phase: "acting",
          interruptPreference: "avoid",
          interruptibility: "interruptible",
          isActive: true,
          isStreaming: true,
          laneSize: 0,
        },
      }),
    ).resolves.toMatchObject({
      relation: "same_task_correction",
      classifierKind: "legacy_queue_translation",
    });
  });
});

describe("resolveSupervisorRelationClassifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseInput = {
    taxonomyVersion: SUPERVISOR_TAXONOMY_VERSION,
    event: {
      type: "user_message",
      category: "user" as const,
      source: "feishu",
      timestamp: 1,
      payload: { text: "actually switch to the outage instead" },
      urgency: "normal" as const,
      scope: "foreground" as const,
    },
    taskState: {
      sessionKey: "agent:main:thread-1",
      sessionId: "sess-1",
      phase: "acting" as const,
      interruptPreference: "avoid" as const,
      interruptibility: "interruptible" as const,
      isActive: true,
      isStreaming: true,
      laneSize: 0,
    },
  };

  it("falls back to legacy translation when no local arbitrator is enabled", async () => {
    const classifier = resolveSupervisorRelationClassifier({
      cfg: {},
      queueMode: "interrupt",
    });

    await expect(classifier.classify(baseInput)).resolves.toMatchObject({
      relation: "new_task_replace",
      classifierKind: "legacy_queue_translation",
    });
  });

  it("uses the local relation model when queue arbitrator is enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"relation":"new_task_parallel","confidence":0.84,"rationale":"This is a side task, not a replacement."}',
              },
            },
          ],
        }),
      }),
    );

    const classifier = resolveSupervisorRelationClassifier({
      cfg: {
        messages: {
          queue: {
            arbitrator: {
              enabled: true,
              provider: "lmstudio",
              model: "qwen3.5-2b",
              baseUrl: "http://127.0.0.1:1234",
            },
          },
        },
      } as never,
      queueMode: "collect",
    });

    await expect(classifier.classify(baseInput)).resolves.toMatchObject({
      relation: "new_task_parallel",
      classifierKind: "model_relation_classifier",
      model: "qwen3.5-2b",
      confidence: 0.84,
    });
  });

  it("falls back to legacy translation when the local model response is unusable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"oops":"not-a-relation"}' } }],
        }),
      }),
    );

    const classifier = resolveSupervisorRelationClassifier({
      cfg: {
        messages: {
          queue: {
            arbitrator: {
              enabled: true,
              provider: "lmstudio",
            },
          },
        },
      } as never,
      queueMode: "steer",
    });

    await expect(classifier.classify(baseInput)).resolves.toMatchObject({
      relation: "same_task_correction",
      classifierKind: "legacy_queue_translation",
    });
  });

  it("accepts qwen-style thinking wrappers and classification alias", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '<think>internal reasoning</think>\n{"classification":"new_task_replace","confidence":0.91,"rationale":"This is a different task."}',
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const classifier = resolveSupervisorRelationClassifier({
      cfg: {
        messages: {
          queue: {
            arbitrator: {
              enabled: true,
              provider: "lmstudio",
              model: "qwen/qwen3-1.7b",
            },
          },
        },
      } as never,
      queueMode: "collect",
    });

    await expect(classifier.classify(baseInput)).resolves.toMatchObject({
      relation: "new_task_replace",
      classifierKind: "model_relation_classifier",
      model: "qwen/qwen3-1.7b",
      confidence: 0.91,
    });
    const firstFetchCall = fetchMock.mock.calls[0];
    expect(firstFetchCall).toBeDefined();
    const requestInit = firstFetchCall?.[1] as RequestInit;
    const body = JSON.parse(requestInit.body as string);
    expect(body.messages[1].content).toContain("/no_think");
  });

  it("reconciles invalid same-task relations when the task is idle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"relation":"same_task_supplement","confidence":0.8,"rationale":"Adds more detail."}',
              },
            },
          ],
        }),
      }),
    );

    const classifier = resolveSupervisorRelationClassifier({
      cfg: {
        messages: {
          queue: {
            arbitrator: {
              enabled: true,
              provider: "lmstudio",
              model: "qwen/qwen3-1.7b",
            },
          },
        },
      } as never,
      queueMode: "collect",
    });

    await expect(
      classifier.classify({
        ...baseInput,
        taskState: {
          ...baseInput.taskState,
          phase: "idle",
          isActive: false,
          isStreaming: false,
        },
      }),
    ).resolves.toMatchObject({
      relation: "new_task_replace",
      classifierKind: "model_relation_classifier",
    });
  });
});

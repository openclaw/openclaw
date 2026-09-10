import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createContext,
  createGateway,
  deferred,
  type TasksPageTestElement,
} from "./tasks-page.test-fixtures.ts";
import "./tasks-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("supervised task controls", () => {
  function supervisedTask(overrides: Record<string, unknown> = {}) {
    return {
      flowId: "supervised-one",
      episode: 2,
      revision: 7,
      agentId: "main",
      runtime: "codex",
      phase: "input_required",
      continuation: "stopped",
      observedAt: Date.now(),
      supervisorExpiresAt: null,
      operatorRequired: true,
      title: "Review the repaired fixture",
      attempts: 2,
      maxAttempts: 4,
      deadlineAt: Date.now() + 60_000,
      endpoint: { reason: "Ready for operator review", effects: "attempt_completed" },
      artifact: { versionId: "00000000-0000-4000-8000-000000000001", sourceHash: "a".repeat(64) },
      operatorCriteria: [{ criterionId: "reviewed", accepted: false }],
      operations: [],
      notifications: [{ id: "notice", episode: 2, state: "failed", updatedAt: Date.now() }],
      ...overrides,
    };
  }
  async function mountSupervision(
    request: ReturnType<typeof vi.fn>,
    scopes = ["operator.read", "operator.write"],
  ) {
    const source = createGateway(
      { request } as unknown as GatewayBrowserClient,
      { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
    );
    const page = document.createElement("openclaw-tasks-page") as TasksPageTestElement;
    page.context = createContext(source.gateway);
    page.context.sessions.state.result = {
      ts: 1,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          displayName: "Fixture conversation",
        },
      ],
    };
    document.body.append(page);
    await waitForFast(() =>
      expect(page.querySelector('select[aria-label="Source conversation"]')).not.toBeNull(),
    );
    const select = page.querySelector<HTMLSelectElement>(
      'select[aria-label="Source conversation"]',
    )!;
    select.value = "agent:main:main";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { page, source };
  }
  function button(page: HTMLElement, label: string) {
    const selected = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(selected, label).toBeDefined();
    return selected!;
  }
  it("requires artifact inspection and sends acceptance for the exact displayed version and revision", async () => {
    const task = supervisedTask();
    const request = vi.fn(async (method: string) => {
      if (method === "tasks.supervision.list") {
        return { tasks: [task] };
      }
      if (method === "tasks.supervision.artifact") {
        return {
          ...task.artifact,
          files: [{ path: "answer.txt", sha256: "b".repeat(64), bytes: 4, executable: false }],
        };
      }
      if (method === "tasks.supervision.control") {
        return {
          acknowledgement: {
            flowId: task.flowId,
            episode: task.episode,
            revision: task.revision,
            phase: task.phase,
          },
          currentTask: {
            ...task,
            revision: task.revision + 1,
            operatorCriteria: [{ criterionId: "reviewed", accepted: true }],
          },
        };
      }
      return { tasks: [] };
    });
    const { page } = await mountSupervision(request);
    await waitForFast(() => expect(page.textContent).toContain("Review the repaired fixture"));
    button(page, "Details and controls").click();
    await waitForFast(() =>
      expect(button(page, "I reviewed and accept this artifact").disabled).toBe(true),
    );
    expect(page.textContent).toContain("Notification delivery: Failed");
    button(page, "Inspect retained files").click();
    await waitForFast(() =>
      expect(button(page, "I reviewed and accept this artifact").disabled).toBe(false),
    );
    button(page, "I reviewed and accept this artifact").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "tasks.supervision.control",
        expect.objectContaining({
          flowId: "supervised-one",
          episode: 2,
          revision: 7,
          inputId: expect.any(String),
          action: { kind: "approve", sourceHash: "a".repeat(64), criterionIds: ["reviewed"] },
        }),
      ),
    );
    await waitForFast(() =>
      expect(page.textContent).not.toContain("I reviewed and accept this artifact"),
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
  it("drops an old-session list response after reconnect and does not display stale custody", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "tasks.supervision.list" ? pending.promise : Promise.resolve({ tasks: [] }),
    );
    const { page, source } = await mountSupervision(request);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "tasks.supervision.list",
        expect.anything(),
        expect.anything(),
      ),
    );
    source.emitConnected(false);
    source.emitConnected(true);
    pending.resolve({
      tasks: [
        supervisedTask({
          phase: "running",
          continuation: "armed",
          supervisorExpiresAt: Date.now() + 60_000,
        }),
      ],
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(page.textContent).not.toContain("Review the repaired fixture");
  });
  it("allows read-only artifact inspection without exposing mutation controls", async () => {
    const request = vi.fn(async (method: string) =>
      method === "tasks.supervision.list" ? { tasks: [supervisedTask()] } : { tasks: [] },
    );
    const { page } = await mountSupervision(request, ["operator.read"]);
    await waitForFast(() => expect(page.textContent).toContain("Review the repaired fixture"));
    button(page, "Details and controls").click();
    await waitForFast(() => expect(page.textContent).toContain("Inspect retained files"));
    expect(page.textContent).not.toContain("I reviewed and accept this artifact");
    expect(page.textContent).not.toContain("Start the next episode");
  });
});

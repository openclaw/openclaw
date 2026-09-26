/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunReadRecord } from "../../../../../src/agents/subagents/registry/subagent-registry-read.types.js";
import { buildSessionSwarmSummary } from "../../../../../src/gateway/session-swarm-summary.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { pt_BR } from "../../../i18n/locales/pt-BR.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../../lib/sessions/session-capability.test-support.ts";
import { SwarmRosterHydrator } from "../../../lib/sessions/swarm-roster.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { renderChatSwarmProgress } from "./chat-swarm-progress.ts";

const parentSessionKey = "agent:main:parent";
const parentRunId = "11111111-2222-4333-8444-555555555555";
const swarmGroupId = `swarm:${parentSessionKey}:${parentRunId}`;
const childSessionKey = "agent:main:subagent:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type SwarmTestSession = GatewaySessionRow & {
  swarmLog?: string;
  swarmPhase?: string;
  swarmPhaseRank?: number;
};

function session(overrides: Partial<SwarmTestSession>): SwarmTestSession {
  return {
    key: "agent:main:child",
    kind: "direct",
    updatedAt: 1,
    parentSessionKey,
    swarmGroupId,
    ...overrides,
  };
}

function withSummary(sessions: readonly GatewaySessionRow[]): GatewaySessionRow[] {
  const runs: SubagentRunReadRecord[] = sessions
    .filter((child) => child.swarmGroupId)
    .map((child) => ({
      runId: child.key,
      childSessionKey: child.key,
      requesterSessionKey: parentSessionKey,
      requesterAgentId: "main",
      swarmRequesterSessionKey: parentSessionKey,
      collect: true,
      groupId: child.swarmGroupId,
      createdAt: child.updatedAt ?? 1,
      execution: { status: child.status === "queued" ? "queued" : "running" },
      collectorCompletion:
        child.status === "done" ||
        child.status === "failed" ||
        child.status === "killed" ||
        child.status === "timeout"
          ? { status: child.status }
          : undefined,
    }));
  return [
    {
      key: parentSessionKey,
      kind: "direct",
      swarm: buildSessionSwarmSummary(runs, parentSessionKey, "main", { includeChildren: true }),
    },
    ...sessions,
  ];
}

function renderProgress(sessions: readonly GatewaySessionRow[]) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions: withSummary(sessions) }),
    container,
  );
  return container;
}

afterEach(async () => {
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("chat Swarm progress", () => {
  it("renders completion progress from the active locale", async () => {
    i18n.registerTranslation("pt-BR", {
      labsPage: {
        swarm: {
          title: "Enxame",
          groupTitle: "Tarefas paralelas",
          progress: "{complete} de {total}",
          failedOrStopped: "Falhou ou foi interrompida",
        },
      },
      tasksPage: {
        status: {
          running: "Em execução",
          completed: "Concluído",
        },
      },
    });
    await i18n.setLocale("pt-BR");

    const container = renderProgress([
      session({ key: "running", status: "running" }),
      session({ key: "done", status: "done" }),
      session({ key: "stopped", status: "killed" }),
    ]);

    expect(
      container.querySelector(".chat-swarm__header")?.textContent?.replace(/\s+/g, " "),
    ).toContain("2 de 3");
    expect(container.querySelector(".chat-swarm__header strong")?.textContent).toBe(
      "Tarefas paralelas",
    );
    expect(
      [...container.querySelectorAll('[role="listitem"]')].map((row) =>
        row.querySelector('[role="img"]')?.getAttribute("aria-label"),
      ),
    ).toEqual(["Em execução", "Concluído", "Falhou ou foi interrompida"]);
  });

  it("groups live collector children and maps their task states", () => {
    const container = renderProgress([
      session({
        key: "queued",
        label: "Queued child",
        status: "queued",
        hasActiveRun: true,
      }),
      session({ key: "running", label: "Running child", status: "running" }),
      session({ key: "done", label: "Done child", status: "done" }),
      session({ key: "failed", label: "Timed out child", status: "timeout" }),
    ]);

    const group = container.querySelector("[data-swarm-group]");
    expect(group?.getAttribute("data-swarm-group")).toBe(swarmGroupId);
    expect(group?.querySelector(".chat-swarm__header strong")?.textContent).toBe("Parallel tasks");
    expect(group?.textContent).not.toContain(parentRunId);
    expect(group?.textContent?.replace(/\s+/g, " ")).toContain("2 of 4");
    expect(
      [...container.querySelectorAll(".chat-swarm__task-icon")].map((icon) => icon.className),
    ).toEqual([
      "chat-swarm__task-icon chat-swarm__task-icon--queued",
      "chat-swarm__task-icon chat-swarm__task-icon--running",
      "chat-swarm__task-icon chat-swarm__task-icon--done",
      "chat-swarm__task-icon chat-swarm__task-icon--failed",
    ]);
    expect(
      [...container.querySelectorAll('[role="listitem"]')].map((row) =>
        row.querySelector('[role="img"]')?.getAttribute("aria-label"),
      ),
    ).toEqual(["Queued", "Running", "Completed", "Failed or stopped"]);
  });

  it.each([
    {
      name: "explicit label",
      fields: { label: " Review CI ", displayName: "Other name" },
      expected: "Review CI",
    },
    {
      name: "key-shaped names",
      fields: { label: childSessionKey, displayName: childSessionKey },
      expected: "Subagent:",
    },
  ])("names a single child from $name without exposing identifiers", ({ fields, expected }) => {
    const container = renderProgress([
      session({ key: childSessionKey, status: "running", ...fields }),
    ]);
    const heading = container.querySelector(".chat-swarm__header strong");
    expect(heading?.textContent).toBe(expected);
    expect(heading?.getAttribute("title")).toBe(expected);
    expect(container.querySelector(".chat-swarm__task-name")?.textContent).toBe(expected);
    expect(container.textContent).not.toContain(parentRunId);
    expect(container.textContent).not.toContain(childSessionKey);
    expect(container.querySelector("[data-swarm-group]")?.getAttribute("data-swarm-group")).toBe(
      swarmGroupId,
    );
  });

  it("updates the same group heading through live rows, hydration, and a second child", async () => {
    vi.useFakeTimers();
    const child = session({ key: childSessionKey, status: "running" });
    const hydrated = { ...child, sessionId: "child-session", label: "Review CI", updatedAt: 2 };
    let serverRows: GatewaySessionRow[] = [hydrated];
    const hydrator = new SwarmRosterHydrator();
    const client = createTestGatewayClient(async (method) =>
      method === "sessions.list"
        ? { ...sessionsResult(serverRows, 2), hasMore: false }
        : { subscribed: true },
    );
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    const container = document.createElement("div");
    document.body.append(container);
    const params = {
      sessions,
      parentKey: parentSessionKey,
      readParent: async () => ({
        key: parentSessionKey,
        sessionId: "parent-session",
        kind: "direct" as const,
      }),
      sourceEpoch: 1,
      currentRows: () => [child],
      onRows: (rows: GatewaySessionRow[]) =>
        render(
          renderChatSwarmProgress({
            sessionKey: parentSessionKey,
            sessions: withSummary(rows),
          }),
          container,
        ),
    };
    try {
      hydrator.update(params);
      const group = container.querySelector("[data-swarm-group]");
      expect(group?.querySelector("strong")?.textContent).toBe("Subagent:");
      await vi.runAllTimersAsync();
      expect(group?.querySelector("strong")?.textContent).toBe("Review CI");
      serverRows = [
        hydrated,
        {
          ...session({
            key: "agent:main:subagent:second",
            label: "Check types",
            status: "running",
          }),
          sessionId: "second-child-session",
        },
      ];
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { agentId: "main", session: serverRows[1], reason: "create" },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(container.querySelectorAll("[data-swarm-group]")).toHaveLength(1);
      expect(group?.getAttribute("data-swarm-group")).toBe(swarmGroupId);
      expect(group?.querySelector("strong")?.textContent).toBe("Parallel tasks");
      expect(
        [...group!.querySelectorAll(".chat-swarm__task-name")].map((el) => el.textContent),
      ).toEqual(["Review CI", "Check types"]);
      expect(container.textContent).not.toContain(parentRunId);
    } finally {
      hydrator.dispose();
      sessions.dispose();
    }
  });

  it("renders every child beyond the ordinary 50-row session page", () => {
    const container = renderProgress(
      Array.from({ length: 55 }, (_, index) =>
        session({ key: `child-${index}`, status: "running" }),
      ),
    );

    expect(container.querySelectorAll(".chat-swarm__task")).toHaveLength(55);
  });

  it("caps historical tasks while keeping active workers visible", () => {
    const container = renderProgress([
      ...Array.from({ length: 300 }, (_, index) =>
        session({ key: `done-${index}`, status: "done" }),
      ),
      session({ key: "running", status: "running" }),
    ]);

    expect(container.querySelectorAll(".chat-swarm__task")).toHaveLength(64);
    expect(container.querySelector(".chat-swarm__task-icon--running")).not.toBeNull();
    expect(
      container.querySelector(".chat-swarm__header")?.textContent?.replace(/\s+/g, " "),
    ).toContain("300 of 301");
  });

  it("exposes a task list and disappears when no group is active", () => {
    const container = renderProgress([session({ label: "Worker A", status: "running" })]);

    const widget = container.querySelector("[data-test-id=chat-swarm]");
    const task = container.querySelector<HTMLElement>(".chat-swarm__task");
    expect(widget?.getAttribute("role")).toBe("status");
    expect(widget?.getAttribute("aria-live")).toBe("off");
    expect(task?.getAttribute("role")).toBe("listitem");
    expect(task?.textContent).toContain("Worker A");

    render(renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions: [] }), container);
    expect(container.querySelector("[data-test-id=chat-swarm]")).toBeNull();
  });

  it.each([
    { name: "failed", statuses: ["failed"], completed: 1 },
    { name: "stopped", statuses: Array.from({ length: 9 }, () => "killed" as const), completed: 0 },
    { name: "mixed", statuses: ["failed", "killed", "timeout"], completed: 1 },
  ] as const)(
    "labels $name outcomes as a combined count through completion",
    ({ statuses, completed }) => {
      const terminal = [
        ...Array.from({ length: completed }, (_, index) =>
          session({ key: `completed-${index}`, status: "done", hasActiveRun: true }),
        ),
        ...statuses.map((status, index) =>
          session({ key: `unsuccessful-${index}`, status, hasActiveRun: true }),
        ),
      ];
      const container = renderProgress([
        session({ key: "running", status: "running" }),
        ...terminal,
      ]);
      const activeCounts = `1 running · 0 queued · ${statuses.length} failed or stopped`;

      expect(container.querySelector(".chat-swarm__counts")?.textContent).toBe(activeCounts);
      expect(container.querySelector(".chat-swarm__markers")?.getAttribute("aria-label")).toBe(
        activeCounts,
      );
      expect(container.querySelectorAll(".chat-swarm__task-icon--running")).toHaveLength(1);
      expect(container.querySelectorAll(".chat-swarm__task-icon--done")).toHaveLength(completed);
      expect(container.querySelectorAll(".chat-swarm__task-icon--failed")).toHaveLength(
        statuses.length,
      );

      render(
        renderChatSwarmProgress({
          sessionKey: parentSessionKey,
          sessions: withSummary(terminal),
        }),
        container,
      );
      const finishedCounts = `${completed} completed · ${statuses.length} failed or stopped`;
      expect(container.querySelector("[data-test-id=chat-swarm]")).not.toBeNull();
      expect(container.querySelector(".chat-swarm__counts")?.textContent).toBe(finishedCounts);
      expect(container.querySelector(".chat-swarm__markers")?.getAttribute("aria-label")).toBe(
        finishedCounts,
      );
      expect(container.textContent).toContain("Check the conversation for the final response");
    },
  );

  it("says the parent is processing while child runs are finished but the parent is still active", () => {
    const completed = session({ key: "completed", status: "done", hasActiveRun: true });
    const parentActive: (typeof completed)[] = [];
    for (const row of withSummary([completed])) {
      parentActive.push(
        row.key === parentSessionKey
          ? { ...row, status: "running" as const, hasActiveRun: true }
          : row,
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions: parentActive }),
      container,
    );
    expect(container.textContent).toContain("The parent is processing their results");
    expect(container.textContent).not.toContain("Check the conversation for the final response");
  });

  it("directs to the final response when child runs are finished and the parent is not active", () => {
    const completed = session({ key: "completed", status: "done", hasActiveRun: false });
    const parentDone: (typeof completed)[] = [];
    for (const row of withSummary([completed])) {
      parentDone.push(
        row.key === parentSessionKey
          ? { ...row, status: "done" as const, hasActiveRun: false }
          : row,
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatSwarmProgress({ sessionKey: parentSessionKey, sessions: parentDone }),
      container,
    );
    expect(container.textContent).toContain("Check the conversation for the final response");
    expect(container.textContent).not.toContain("The parent is processing their results");
  });

  it("orders phase buckets by observation rank, not canonical row order", () => {
    const container = renderProgress([
      session({
        key: "builder",
        label: "Builder",
        status: "running",
        swarmPhase: "Build",
        swarmPhaseRank: 1,
      }),
      session({ key: "late-unphased", label: "Late child", status: "running" }),
      session({
        key: "planner",
        label: "Planner",
        status: "done",
        swarmPhase: "Plan",
        swarmPhaseRank: 0,
      }),
    ]);

    expect(
      [...container.querySelectorAll(".chat-swarm__task-name")].map((task) =>
        task.textContent?.trim(),
      ),
    ).toEqual(["Planner", "Builder", "Late child"]);
  });

  it("uses session runtime fields instead of the last row update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const container = renderProgress([
      session({
        key: "running",
        label: "Running",
        status: "running",
        startedAt: 90_000,
        updatedAt: 99_000,
      }),
      session({
        key: "sampled",
        label: "Sampled",
        status: "running",
        runtimeMs: 4_000,
        runtimeSampledAt: 98_000,
        updatedAt: 50_000,
      }),
      session({
        key: "done",
        label: "Done",
        status: "done",
        startedAt: 10_000,
        endedAt: 17_000,
        updatedAt: 99_999,
      }),
    ]);

    expect(
      [...container.querySelectorAll(".chat-swarm__task")].map((task) => ({
        label: task.querySelector(".chat-swarm__task-name")?.textContent,
        duration: task.querySelector(".chat-swarm__task-duration")?.textContent,
      })),
    ).toEqual([
      { label: "Running", duration: "10s" },
      { label: "Sampled", duration: "6s" },
      { label: "Done", duration: "7s" },
    ]);
  });
  it.each(["global", "unknown"])(
    "keeps raw %s owners separate from ordinary qualified keys",
    (raw) => {
      const makeParent = (key: string, agentId: string, done: number): GatewaySessionRow => ({
        key,
        agentId,
        kind: "direct",
        swarm: {
          groups: [{ groupId: "custom", createdAt: 1, queued: 0, running: 0, done, failed: 0 }],
          otherActiveGroups: 0,
        },
      });
      const sessions = [
        makeParent(raw, "main", 1),
        makeParent(raw, "research", 2),
        makeParent(`agent:main:${raw}`, "main", 3),
      ];
      const container = document.createElement("div");
      document.body.append(container);
      for (const target of [
        { sessionKey: raw, agentId: "main", count: 1 },
        { sessionKey: raw, agentId: "research", count: 2 },
        { sessionKey: `agent:main:${raw}`, agentId: "main", count: 3 },
      ]) {
        render(renderChatSwarmProgress({ ...target, sessions }), container);
        expect(container.querySelector("summary")?.textContent).toContain(
          `${target.count} completed`,
        );
        expect(container.textContent).toContain("Child details are unavailable");
      }
      render(renderChatSwarmProgress({ sessionKey: raw, sessions }), container);
      expect(container.querySelector("[data-test-id=chat-swarm]")).toBeNull();
    },
  );
});

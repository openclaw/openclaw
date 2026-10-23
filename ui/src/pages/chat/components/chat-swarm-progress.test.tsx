/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { SubagentRunReadRecord as Run } from "../../../../../src/agents/subagents/registry/subagent-registry-read.types.js";
import { buildSessionSwarmSummary } from "../../../../../src/gateway/session-swarm-summary.js";
import { GatewayChatEvents } from "../../../api/gateway-chat-events.ts";
import type { GatewaySessionRow as Row } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { pt_BR } from "../../../i18n/locales/pt-BR.ts";
import { reconcileSessionChangedRow } from "../../../lib/sessions/reconcile.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../../lib/sessions/session-capability.test-support.ts";
import { SwarmRosterHydrator } from "../../../lib/sessions/swarm-roster.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { ChatSwarmProgressProps } from "./chat-swarm-progress-types.ts";
import { ChatSwarmProgress } from "./chat-swarm-progress.solid.tsx";

const parentSessionKey = "agent:main:parent";
const parentRunId = "11111111-2222-4333-8444-555555555555";
const swarmGroupId = `swarm:${parentSessionKey}:${parentRunId}`;
const childSessionKey = "agent:main:subagent:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const stoppedLabel = "Falhou ou foi interrompido";

function session(key: string, status: Row["status"] = "running", fields: Partial<Row> = {}): Row {
  return {
    key,
    status,
    kind: "direct",
    updatedAt: 1,
    parentSessionKey,
    swarmGroupId,
    ...fields,
  };
}

function withSummary(sessions: readonly Row[]): Row[] {
  const runs: Run[] = sessions.map(({ key, status, swarmGroupId: groupId, updatedAt }) => ({
    runId: key,
    childSessionKey: key,
    requesterSessionKey: parentSessionKey,
    requesterAgentId: "main",
    swarmRequesterSessionKey: parentSessionKey,
    collect: true,
    groupId,
    createdAt: updatedAt ?? 1,
    execution: { status: status === "queued" ? "queued" : "running" },
    collectorCompletion:
      status === "done" || status === "failed" || status === "killed" || status === "timeout"
        ? { status }
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

type ProgressProps = Pick<ChatSwarmProgressProps, "sessions"> & Partial<ChatSwarmProgressProps>;
function mountProgress(props: ProgressProps) {
  const [current, setCurrent] = createSignal({ sessionKey: parentSessionKey, ...props });
  const { container } = mountSolid(() => <ChatSwarmProgress {...current()} />);
  return {
    container,
    update: (next: ProgressProps) => {
      setCurrent({ sessionKey: parentSessionKey, ...next });
      flush();
    },
  };
}

const renderProgress = (sessions: readonly Row[]) =>
  mountProgress({ sessions: withSummary(sessions) }).container;

const text = (container: ParentNode, part: string) =>
  container.querySelector(`.chat-swarm__${part}`)?.textContent;
const all = (container: ParentNode, part: string) => [
  ...container.querySelectorAll(`.chat-swarm__${part}`),
];
const progress = (container: ParentNode) => text(container, "header")?.replace(/\s+/g, " ");
const taskLabels = (container: ParentNode) =>
  [...container.querySelectorAll('[role="listitem"]')].map((row) =>
    row.querySelector('[role="img"]')?.getAttribute("aria-label"),
  );
function expectCounts(container: ParentNode, counts: string) {
  expect(text(container, "counts")).toBe(counts);
  expect(container.querySelector(".chat-swarm__markers")?.getAttribute("aria-label")).toBe(counts);
}

afterEach(async () => {
  await i18n.setLocale("en");
  vi.useRealTimers();
});

it.each([
  ["en", 1, "Parallel tasks", "3 of 5"],
  ["pt-BR", 2, "Tarefas paralelas", "3 de 5"],
] as const)("localizes collector states: %s", async (locale, labelColumn, title, complete) => {
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale(locale);
  const states = [
    ["queued", "Queued", "Na fila", "queued"],
    ["running", "Running", "Em execução", "running"],
    ["done", "Completed", "Concluída", "done"],
    ["timeout", "Failed or stopped", stoppedLabel, "failed"],
    ["killed", "Failed or stopped", stoppedLabel, "failed"],
  ] as const;
  const container = renderProgress(
    states.map(([status]) =>
      session(status, status, { label: `${status} child`, hasActiveRun: status === "queued" }),
    ),
  );
  const group = container.querySelector("[data-swarm-group]");
  expect(group).toMatchObject({ dataset: { swarmGroup: swarmGroupId } });
  expect(text(group!, "header strong")).toBe(title);
  expect(group?.textContent).not.toContain(parentRunId);
  expect(progress(container)).toContain(complete);
  expect(all(container, "task-icon").map((icon) => icon.className)).toEqual(
    states.map((state) => `chat-swarm__task-icon chat-swarm__task-icon--${state[3]}`),
  );
  expect(taskLabels(container)).toEqual(states.map((state) => state[labelColumn]));
});

it("names a single child from key-shaped names without exposing identifiers", () => {
  const expected = "Subagent";
  const container = renderProgress([
    session(childSessionKey, "running", { label: childSessionKey, displayName: childSessionKey }),
  ]);
  const heading = container.querySelector(".chat-swarm__header strong");
  expect(heading).toMatchObject({ textContent: expected, title: expected });
  expect(text(container, "task-name")).toBe(expected);
  expect(container.textContent).not.toContain(parentRunId);
  expect(container.textContent).not.toContain(childSessionKey);
  const group = container.querySelector("[data-swarm-group]");
  expect(group).toMatchObject({ dataset: { swarmGroup: swarmGroupId } });
});

it("updates the same group heading through live rows, hydration, and a second child", async () => {
  vi.useFakeTimers();
  const child = session(childSessionKey);
  const hydrated = { ...child, sessionId: "child-session", label: "Review CI", updatedAt: 2 };
  let serverRows: Row[] = [hydrated];
  const hydrator = new SwarmRosterHydrator();
  const client = createTestGatewayClient(async (method) =>
    method === "sessions.list"
      ? { ...sessionsResult(serverRows, 2), hasMore: false }
      : { subscribed: true },
  );
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const { container, update } = mountProgress({ sessions: [] });
  const stop = hydrator.subscribe(() => update({ sessions: withSummary(hydrator.rows) }));
  try {
    hydrator.update({
      sessions,
      parentKey: parentSessionKey,
      readParent: async () => ({
        key: parentSessionKey,
        sessionId: "parent-session",
        kind: "direct",
      }),
      sourceEpoch: 1,
      currentRows: () => [child],
    });
    const group = container.querySelector("[data-swarm-group]");
    expect(group?.querySelector("strong")?.textContent).toBe("Subagent");
    await vi.runAllTimersAsync();
    expect(group?.querySelector("strong")?.textContent).toBe("Review CI");
    serverRows = [
      hydrated,
      session("agent:main:subagent:second", "running", {
        label: "Check types",
        sessionId: "second-child-session",
      }),
    ];
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { agentId: "main", session: serverRows[1], reason: "create" },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(container.querySelectorAll("[data-swarm-group]")).toHaveLength(1);
    expect(group).toMatchObject({ dataset: { swarmGroup: swarmGroupId } });
    expect(group?.querySelector("strong")?.textContent).toBe("Parallel tasks");
    expect(all(group!, "task-name").map((el) => el.textContent)).toEqual([
      "Review CI",
      "Check types",
    ]);
    expect(container.textContent).not.toContain(parentRunId);
  } finally {
    stop();
    hydrator.dispose();
    sessions.dispose();
  }
});

it("caps historical tasks while keeping active workers visible", () => {
  const container = renderProgress([
    ...Array.from({ length: 300 }, (_, index) => session(`done-${index}`, "done")),
    session("running"),
  ]);

  expect(all(container, "task")).toHaveLength(64);
  expect(container.querySelector(".chat-swarm__task-icon--running")).not.toBeNull();
  expect(progress(container)).toContain("300 of 301");
});

it("labels mixed outcomes as a combined count through completion", () => {
  const terminal = (["done", "failed", "killed", "timeout"] as const).map((status) =>
    session(status, status, { hasActiveRun: true }),
  );
  const { container, update } = mountProgress({
    sessions: withSummary([session("running"), ...terminal]),
  });
  expectCounts(container, "1 running · 0 queued · 3 failed or stopped");
  expect(
    ["running", "done", "failed"].map((state) => all(container, `task-icon--${state}`).length),
  ).toEqual([1, 1, 3]);

  update({ sessions: withSummary(terminal) });
  expect(container.querySelector("[data-test-id=chat-swarm]")).not.toBeNull();
  expectCounts(container, "1 completed · 3 failed or stopped");
  expect(container.textContent).toContain("Check the conversation for the final response");
});

it("says the parent is processing while child runs are finished but the parent is still active", () => {
  const parentActive = withSummary([session("completed", "done", { hasActiveRun: true })]);
  Object.assign(parentActive[0]!, { status: "running", hasActiveRun: true });
  const { container } = mountProgress({ sessions: parentActive });
  expect(container.textContent).toContain("The parent is processing their results");
  expect(container.textContent).not.toContain("Check the conversation for the final response");
});

it("uses session runtime fields instead of the last row update", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const samples: [string, Row["status"], Partial<Row>, string][] = [
    ["Running", "running", { startedAt: 90_000, updatedAt: 99_000 }, "10s"],
    ["Sampled", "running", { runtimeMs: 4_000, runtimeSampledAt: 98_000, updatedAt: 50_000 }, "6s"],
    ["Done", "done", { startedAt: 10_000, endedAt: 17_000, updatedAt: 99_999 }, "7s"],
  ];
  const container = renderProgress(
    samples.map(([label, status, runtime]) =>
      session(label.toLowerCase(), status, { label, ...runtime }),
    ),
  );

  expect(
    all(container, "task").map((task) => [text(task, "task-name"), text(task, "task-duration")]),
  ).toEqual(samples.map((sample) => [sample[0], sample[3]]));
});

it("renders the same live and settled timers after row-delta ingress", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const initial = session(childSessionKey, "running", {
    sessionId: "child-session",
    label: "Sampled child",
    hasActiveRun: true,
    runtimeMs: 4_000,
    runtimeSampledAt: 98_000,
    snapshotAt: 100_000,
  });
  let reconstructed = initial;
  const reconnect = vi.fn();
  const ingress = new GatewayChatEvents(reconnect);
  const receive = (wire: unknown) => {
    ingress.dispatch(
      {
        type: "event",
        event: "sessions.changed",
        payload: { key: childSessionKey, session: wire, ancestorSessions: [] },
      },
      (frame) => {
        const applied = reconcileSessionChangedRow(reconstructed, frame.payload);
        expect(applied.row).toMatchObject({ key: childSessionKey });
        reconstructed = applied.row!;
      },
    );
  };
  receive({ key: childSessionKey, version: 1, full: initial });
  const capable = mountProgress({ sessions: withSummary([reconstructed]) });
  const legacy = mountProgress({ sessions: withSummary([initial]) });
  const durations = () =>
    [capable, legacy].map(({ container }) => text(container, "task-duration"));
  expect(durations()).toEqual(["6s", "6s"]);

  const changes: Partial<Row>[] = [
    { runtimeMs: 9_000, runtimeSampledAt: 102_000, snapshotAt: 103_000 },
    {
      runtimeSampledAt: 104_000,
      snapshotAt: 104_000,
      status: "done",
      hasActiveRun: false,
    },
  ];
  const legacyRow = { ...initial };
  for (const [index, set] of changes.entries()) {
    vi.setSystemTime(103_000 + index * 1_000);
    receive({ key: childSessionKey, base: index + 1, version: index + 2, set, remove: [] });
    Object.assign(legacyRow, set);
    capable.update({ sessions: withSummary([reconstructed]) });
    legacy.update({ sessions: withSummary([legacyRow]) });
    expect(durations()).toEqual(index === 0 ? ["10s", "10s"] : ["9s", "9s"]);
  }
  expect(reconnect).not.toHaveBeenCalled();
});
it("keeps raw unknown owners separate from ordinary qualified keys", () => {
  const raw = "unknown";
  const targets = [
    [raw, "main", 1],
    [raw, "research", 2],
    [`agent:main:${raw}`, "main", 3],
  ] as const;
  const sessions = targets.map(([key, agentId, done]): Row => ({
    key,
    agentId,
    kind: "direct",
    swarm: {
      groups: [{ groupId: "custom", createdAt: 1, queued: 0, running: 0, done, failed: 0 }],
      otherActiveGroups: 0,
    },
  }));
  const { container, update } = mountProgress({ sessionKey: raw, sessions });
  for (const [sessionKey, agentId, count] of targets) {
    update({ sessionKey, agentId, sessions });
    expect(container.querySelector("summary")?.textContent).toContain(`${count} completed`);
    expect(container.textContent).toContain("Child details are unavailable");
  }
  update({ sessionKey: raw, sessions });
  expect(container.querySelector("[data-test-id=chat-swarm]")).toBeNull();
});

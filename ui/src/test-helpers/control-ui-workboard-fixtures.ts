import type { CronJob } from "../api/types.ts";
import {
  createControlUiChatHistoryMessage as chatHistoryMessage,
  createControlUiMockSessionRow as sessionRow,
} from "./control-ui-session-fixtures.ts";

export function buildWorkboardMocks(baseTime: number, actor: { id: string; label: string }) {
  const boardId = "peter-tasks";
  const briefSessionKey = "agent:main:workboard-brief";
  const launchSessionKey = "agent:main:workboard-launch";
  const stagingSessionKey = "agent:main:workboard-staging";
  const handoffSessionKey = "agent:main:workboard-handoff";
  const onboardingSessionKey = "agent:main:workboard-onboarding";
  const accessibilitySessionKey = "agent:main:workboard-accessibility";
  const card = (
    id: string,
    title: string,
    status: string,
    priority: string,
    position: number,
    labels: string[],
    notes = "",
    sessionKey?: string,
  ) => ({
    id,
    title,
    status,
    priority,
    labels,
    notes,
    sessionKey,
    position,
    createdAt: baseTime - 86_400_000,
    updatedAt: baseTime - position * 1_000,
    metadata: { automation: { boardId } },
  });
  const cards = [
    card("card-inbox", "Capture customer feedback themes", "todo", "normal", 1, ["research"]),
    card(
      "card-brief",
      "Draft weekly product brief",
      "todo",
      "low",
      2,
      ["writing"],
      "",
      briefSessionKey,
    ),
    card(
      "card-ready",
      "Prepare launch readiness checklist",
      "ready",
      "high",
      1,
      ["launch"],
      "",
      launchSessionKey,
    ),
    card(
      "card-running",
      "Validate onboarding flow",
      "running",
      "urgent",
      1,
      ["quality"],
      "",
      onboardingSessionKey,
    ),
    card(
      "card-review",
      "Review accessibility audit",
      "review",
      "high",
      1,
      ["frontend"],
      "",
      accessibilitySessionKey,
    ),
    card(
      "card-blocked",
      "Confirm staging environment access",
      "blocked",
      "normal",
      1,
      ["ops"],
      "",
      stagingSessionKey,
    ),
    card(
      "card-done",
      "Publish support handoff notes",
      "done",
      "low",
      1,
      ["docs"],
      "",
      handoffSessionKey,
    ),
  ];
  const statuses = ["todo", "ready", "running", "review", "blocked", "done"];
  const summarizeBoard = (entries: readonly { status: string }[]) => ({
    total: entries.length,
    active: entries.length,
    archived: 0,
    byStatus: Object.fromEntries(
      statuses.map((status) => [status, entries.filter((entry) => entry.status === status).length]),
    ),
    updatedAt: baseTime,
  });
  const board = {
    id: boardId,
    name: "Product Operations",
    description: "Shared product delivery queue",
    automationJobId: "job-product-operations-daily",
    ...summarizeBoard(cards),
  };
  const stateCard = (
    id: string,
    title: string,
    status: string,
    position: number,
    session = true,
  ) => ({
    ...card(
      `state-${id}`,
      title,
      status,
      "normal",
      position,
      ["synthetic"],
      "",
      session ? `agent:main:card-states-${id}` : undefined,
    ),
    metadata: { automation: { boardId: "card-states" } },
  });
  const stateCards = [
    {
      ...stateCard(
        "rich",
        "Review the complete release handoff, including accessibility findings, localization notes, and the final owner checklist ✨",
        "review",
        1000,
      ),
      priority: "high",
      labels: [
        "release",
        "long-label-for-layout-coverage-without-any-spaces",
        "アクセシビリティ ✨",
        "localization",
        "owner-review",
      ],
      notes:
        "Synthetic design fixture. Review the handoff as a complete package.\n\nCheck keyboard navigation, translated strings, empty states, and the operator recovery path. Preserve context when opening supporting evidence.",
      metadata: {
        automation: { boardId: "card-states" },
        templateId: "release",
        comments: [
          {
            id: "state-comment",
            body: "The first pass is ready. Please verify the recovery instructions before signing off.",
            createdAt: baseTime - 180_000,
          },
        ],
        proof: [
          {
            id: "state-proof-failed",
            status: "failed",
            label: "Initial keyboard check",
            note: "Synthetic earlier failed evidence.",
            createdAt: baseTime - 1_000_000,
          },
          {
            id: "state-proof-skipped",
            status: "skipped",
            label: "Mobile device check",
            note: "No device attached to this synthetic example.",
            createdAt: baseTime - 150_000,
          },
          {
            id: "state-proof",
            status: "passed",
            label: "Synthetic accessibility review",
            note: "Illustrative evidence only; no test was executed.",
            createdAt: baseTime - 120_000,
          },
        ],
        failureCount: 1,
        attempts: [
          {
            id: "state-first-attempt",
            status: "failed",
            startedAt: baseTime - 1_200_000,
            endedAt: baseTime - 1_000_000,
            error: "Synthetic first pass did not complete.",
          },
          {
            id: "state-attempt",
            status: "succeeded",
            startedAt: baseTime - 900_000,
            endedAt: baseTime - 240_000,
          },
        ],
        claim: {
          ownerId: "main",
          token: "synthetic-claim",
          claimedAt: baseTime - 900_000,
          lastHeartbeatAt: baseTime - 240_000,
        },
      },
    },
    {
      ...stateCard(
        "dependency",
        "Publish the release after the handoff is approved",
        "blocked",
        1000,
        false,
      ),
      agentId: "release-reviewer",
      metadata: {
        automation: { boardId: "card-states" },
        links: [
          {
            id: "state-parent",
            type: "parent",
            targetCardId: "state-rich",
            createdAt: baseTime - 600_000,
          },
        ],
        workerProtocol: {
          state: "blocked",
          detail: "Waiting for the release owner to approve the handoff.",
          updatedAt: baseTime - 120_000,
        },
        diagnostics: [
          {
            kind: "missing_proof",
            severity: "critical",
            title: "Release verification is missing",
            detail: "Attach the final deployment verification before publishing.",
            firstSeenAt: baseTime - 600_000,
            lastSeenAt: baseTime - 120_000,
            count: 1,
            actions: [],
          },
        ],
      },
    },
    {
      ...stateCard("stale", "Investigate a run with no recent session activity", "running", 1000),
      labels: [],
      metadata: {
        automation: { boardId: "card-states" },
        stale: {
          detectedAt: baseTime - 60_000,
          lastSessionUpdatedAt: baseTime - 45 * 60_000,
          reason: "The synthetic session has not reported activity for 45 minutes.",
        },
      },
    },
    stateCard("missing", "Reconnect a session that is absent from the directory", "todo", 1000),
    stateCard("queued", "Wait for the task worker to accept the request", "ready", 1000),
    stateCard("running", "Collect the remaining release checklist findings", "running", 2000),
    stateCard("timeout", "Retry the environment check after its deadline", "blocked", 2000),
    stateCard("stopped", "Resume a task stopped by the operator", "blocked", 3000),
    stateCard("completed", "Review a completed background task", "review", 2000),
    {
      ...stateCard(
        "failed",
        "Inspect a failed task after its session was stopped",
        "blocked",
        4000,
      ),
      runId: "state-current-failed-run",
      metadata: {
        automation: { boardId: "card-states" },
        notifications: [
          {
            id: "state-current-failure",
            kind: "failed",
            createdAt: baseTime - 60_000,
            runId: "state-current-failed-run",
            message: "The current task failed while checking the release environment.",
          },
          {
            id: "state-old-completion",
            kind: "completed",
            createdAt: baseTime - 30_000,
            runId: "state-previous-run",
            message: "An earlier execution completed; this is not the current blocker.",
          },
        ],
      },
    },
    {
      ...stateCard(
        "ambiguous",
        "Choose the owner of an ambiguous shared session link",
        "todo",
        2000,
      ),
      sessionKey: "global",
    },
  ];
  const allCards = [...cards, ...stateCards];
  const statesBoard = {
    id: "card-states",
    name: "Card states",
    description: "Synthetic examples of card content and execution states",
    ...summarizeBoard(stateCards),
  };
  const boards = [board, statesBoard];
  const tasks = ["queued", "running", "timeout", "stopped", "completed", "failed"].map((id) =>
    Object.assign(
      {
        id: `task-card-states-${id}`,
        taskId: `task-card-states-${id}`,
        agentId: "main",
        sessionKey: `agent:main:card-states-${id}`,
        status: id === "timeout" ? "timed_out" : id === "stopped" ? "cancelled" : id,
        title: `Synthetic ${id} task`,
        createdAt: baseTime - 600_000,
        updatedAt: baseTime - 60_000,
        progressSummary:
          id === "queued" ? "Waiting for an available worker." : "Checking the release checklist.",
        terminalSummary:
          id === "timeout"
            ? "The environment did not respond before the deadline."
            : id === "stopped"
              ? "Stopped by the operator."
              : id === "completed"
                ? "The synthetic task completed its release review."
                : id === "failed"
                  ? "The synthetic task failed before its session was stopped."
                  : "",
      },
      id === "failed" ? { runId: "state-current-failed-run" } : {},
    ),
  );
  const automationJob: CronJob = {
    id: board.automationJobId,
    agentId: "main",
    name: "Review product operations",
    description:
      "Review this board and summarize priorities, blockers, and work ready for handoff.",
    enabled: true,
    createdAtMs: baseTime - 86_400_000,
    updatedAtMs: baseTime,
    schedule: { kind: "every", everyMs: 86_400_000, anchorMs: baseTime },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message:
        "Review the peter-tasks Workboard. Summarize current priorities and blockers without starting new work.",
    },
    delivery: { mode: "none" },
    state: { nextRunAtMs: baseTime + 86_400_000 },
  };
  const sessionKey = "agent:main:workboard-proof";
  const cardSessions = [
    sessionRow(briefSessionKey, "Weekly product brief", baseTime - 2 * 60_000, {
      status: "queued",
      hasActiveRun: false,
    }),
    sessionRow(launchSessionKey, "Launch readiness", baseTime - 12 * 60_000, {
      status: undefined,
      hasActiveRun: false,
      totalTokens: 2_400,
    }),
    sessionRow(stagingSessionKey, "Staging access", baseTime - 5 * 60_000, {
      status: "failed",
      hasActiveRun: false,
      totalTokens: 1_800,
    }),
    sessionRow(handoffSessionKey, "Support handoff", baseTime - 30 * 60_000, {
      status: "done",
      hasActiveRun: false,
      totalTokens: 4_200,
    }),
    sessionRow(onboardingSessionKey, "Onboarding validation", baseTime, {
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["workboard-onboarding-run"],
      startedAt: baseTime - 8 * 60_000,
      totalTokens: 12_400,
    }),
    sessionRow(accessibilitySessionKey, "Accessibility audit", baseTime - 3 * 60_000, {
      status: "done",
      hasActiveRun: false,
      totalTokens: 8_600,
    }),
  ];
  cardSessions.push(
    sessionRow("agent:main:card-states-rich", "Release handoff review", baseTime - 240_000, {
      status: "done",
      hasActiveRun: false,
    }),
    sessionRow("agent:main:card-states-stale", "Release investigation", baseTime - 45 * 60_000, {
      status: "running",
      hasActiveRun: false,
    }),
    ...tasks.map((task) =>
      sessionRow(task.sessionKey, task.title, task.updatedAt, {
        status: task.status === "failed" ? "killed" : undefined,
        hasActiveRun: false,
      }),
    ),
  );
  const history = (...messages: Parameters<typeof chatHistoryMessage>[]) => ({
    messages: messages.map((message) => chatHistoryMessage(...message)),
  });
  const cardSessionHistories = {
    ...Object.fromEntries(
      cardSessions
        .filter((session) => session.key.includes(":card-states-"))
        .map((session) => [
          session.key,
          history([
            "user",
            "Synthetic card-state example: inspect this execution and its recorded outcome.",
            baseTime - 700_000,
          ]),
        ]),
    ),
    [briefSessionKey]: history([
      "user",
      "Draft this week's product brief from the latest feedback and delivery notes.",
      baseTime - 2 * 60_000,
    ]),
    [launchSessionKey]: history(
      [
        "user",
        "Prepare the launch readiness checklist. I will provide the release scope before we start.",
        baseTime - 15 * 60_000,
      ],
      [
        "assistant",
        "The checklist outline is ready. Share the release scope when you are ready to continue.",
        baseTime - 12 * 60_000,
      ],
    ),
    [stagingSessionKey]: history(
      [
        "user",
        "Confirm that the staging environment is accessible for the release review.",
        baseTime - 7 * 60_000,
      ],
      [
        "assistant",
        "The staging access check failed: the environment returned HTTP 403. An operator needs to restore access before I can retry.",
        baseTime - 5 * 60_000,
      ],
    ),
    [handoffSessionKey]: history(
      [
        "user",
        "Prepare the support handoff notes covering the launch checklist and known limitations.",
        baseTime - 40 * 60_000,
      ],
      [
        "assistant",
        "The support handoff notes are complete, including escalation contacts and known limitations. The operator has reviewed and published them.",
        baseTime - 30 * 60_000,
      ],
    ),
    [onboardingSessionKey]: {
      ...history(
        [
          "user",
          "Validate the onboarding flow, including account setup and the first successful task.",
          baseTime - 8 * 60_000,
        ],
        [
          "assistant",
          "Account setup is working. I am checking the first-task flow and its empty and error states.",
          baseTime - 60_000,
        ],
      ),
      inFlightRun: {
        runId: "workboard-onboarding-run",
        text: "Checking first-task navigation and recovery after a validation error…",
        startedAt: baseTime - 8 * 60_000,
        events: [],
      },
    },
    [accessibilitySessionKey]: history(
      [
        "user",
        "Review keyboard navigation, focus visibility, and form labels in the onboarding flow.",
        baseTime - 20 * 60_000,
      ],
      [
        "assistant",
        "The accessibility review is complete. Keyboard navigation, visible focus, and form labels are ready for operator review.",
        baseTime - 3 * 60_000,
      ],
    ),
  };
  return {
    board,
    boards,
    cards: allCards,
    tasks,
    sessionKey,
    cardSessions,
    cardSessionHistories: Object.fromEntries(
      Object.entries(cardSessionHistories).map(([key, sessionHistory]) => [
        key,
        {
          ...sessionHistory,
          messages: sessionHistory.messages.map((message) => ({
            ...message,
            ...(message.role === "user"
              ? {
                  __openclaw: { senderId: actor.id, senderName: actor.label },
                }
              : {}),
          })),
          sessionInfo: cardSessions.find((session) => session.key === key),
        },
      ]),
    ),
    methodResponses: {
      "agents.list": {
        agents: [
          { id: "main", name: "Molty", identity: { name: "Molty" } },
          {
            id: "release-reviewer",
            name: "Release reviewer",
            identity: { name: "Release reviewer" },
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "global",
      },
      "cron.get": {
        cases: [
          { match: { id: automationJob.id }, response: automationJob },
          {
            response: {
              __mockError: { code: "INVALID_REQUEST", message: "Mock automation not found." },
            },
          },
        ],
      },
      "cron.list": {
        jobs: [automationJob],
        snapshotRevision: "workboard-mock-cron",
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },

      "board.get": {
        sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Workboard", position: 0, chatDock: "hidden" }],
        widgets: [
          {
            name: "session-progress",
            tabId: "main",
            title: "Session progress",
            contentKind: "plugin",
            pluginKind: "session:progress",
            sizeW: 6,
            sizeH: 5,
            position: 0,
            grantState: "none",
            revision: 1,
          },
          {
            name: "workboard-product-operations",
            tabId: "main",
            title: "Product Operations",
            contentKind: "plugin",
            pluginKind: "workboard:board",
            props: { boardId },
            heightMode: "fixed",
            sizeW: 12,
            sizeH: 16,
            position: 1,
            grantState: "none",
            revision: 1,
          },
        ],
      },
      "workboard.boards.list": { boards },
      "workboard.cards.list": { boards, cards: allCards, statuses },
      "workboard.cards.stats": { ...board, byAgent: {} },
      "workboard.cards.move": { card: cards[0] },
      "progressCard.get": {
        cases: [
          ...cardSessions
            .filter((session) => !session.key.includes(":card-states-"))
            .map((session) => ({
              match: { sessionKey: session.key },
              response: {
                card: {
                  sessionKey: session.key,
                  revision: 1,
                  updatedAt: session.updatedAt,
                  markdown:
                    session.status === "failed"
                      ? "Staging access could not be verified. The operator must confirm access before work continues."
                      : session.status === "done"
                        ? "The requested work is complete and ready for operator review."
                        : session.status === "running"
                          ? "Account setup passed. First-task navigation is being checked."
                          : "Waiting for the operator to provide the next input.",
                  steps: [
                    {
                      step: "Review the requested scope",
                      status: session.status === "queued" ? "pending" : "completed",
                    },
                    {
                      step: "Complete the requested work",
                      status:
                        session.status === "done"
                          ? "completed"
                          : session.status === "running"
                            ? "in_progress"
                            : "pending",
                    },
                  ],
                },
              },
            })),
          { response: { card: null } },
        ],
      },
    },
  };
}

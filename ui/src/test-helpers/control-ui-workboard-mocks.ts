import type { ControlUiMockGateway } from "./control-ui-e2e.ts";
import type { buildWorkboardMocks } from "./control-ui-workboard-fixtures.ts";

// The launcher serializes this installer into the browser; keep it free of module captures.
export function installWorkboardBoardMock(seed: ReturnType<typeof buildWorkboardMocks>): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const workboardBoards = new Map<string, Record<string, unknown>>(
    seed.boards.map((board) => [board.id, board]),
  );
  type MockCard = (typeof seed.cards)[number] & {
    metadata: {
      automation: { boardId: string };
      templateId?: string;
      archivedAt?: number;
      comments?: { id: string; body: string; createdAt: number }[];
    };
    notes?: string;
    agentId?: string;
    sessionKey?: string;
    events?: { id: string; kind: string; at: number; fromStatus?: string; toStatus?: string }[];
    completedAt?: number;
  };
  const workboardCards = new Map<string, MockCard>(seed.cards.map((card) => [card.id, card]));
  const tasks = new Map(seed.tasks.map((task) => [task.id, task]));
  gateway.setRequestHandler("tasks.list", ({ params, respond }) => {
    const input = params as { sessionKey?: string; status?: string | string[] };
    respond({
      tasks: [...tasks.values()].filter(
        (task) =>
          (!input.sessionKey || task.sessionKey === input.sessionKey) &&
          (!input.status ||
            (Array.isArray(input.status)
              ? input.status.includes(task.status)
              : input.status === task.status)),
      ),
    });
  });
  gateway.setRequestHandler("tasks.get", ({ params, respond }) => {
    const task = tasks.get((params as { taskId: string }).taskId);
    respond(
      task ? { task } : { __mockError: { code: "INVALID_REQUEST", message: "Task not found" } },
    );
  });
  gateway.setRequestHandler("tasks.cancel", ({ params, respond, emit }) => {
    const task = tasks.get((params as { taskId: string }).taskId);
    if (!task) {
      respond({ found: false, cancelled: false, reason: "Mock task not found." });
      return;
    }
    const cancelled = task.status === "queued" || task.status === "running";
    if (cancelled) {
      task.status = "cancelled";
      task.updatedAt = Date.now();
      task.terminalSummary = "Stopped by the operator in this synthetic fixture.";
    }
    respond({ found: true, task, cancelled });
    if (cancelled) {
      emit("task", { action: "upserted", task });
      emit("plugin.workboard.changed", { epoch: "workboard-mock", revision: ++revision });
    }
  });
  const statuses = seed.methodResponses["workboard.cards.list"].statuses;
  let revision = Date.now();
  const boardSummaries = () =>
    [...workboardBoards.values()].map((board) => {
      const cards = [...workboardCards.values()].filter(
        (card) => card.metadata.automation.boardId === board.id,
      );
      return Object.assign({}, board, {
        id: board.id,
        total: cards.length,
        active: cards.filter((card) => !card.metadata.archivedAt).length,
        archived: cards.filter((card) => Boolean(card.metadata.archivedAt)).length,
        byStatus: Object.fromEntries(
          statuses.map((status) => [status, cards.filter((card) => card.status === status).length]),
        ),
        updatedAt: Math.max(Number(board.updatedAt ?? 0), ...cards.map((card) => card.updatedAt)),
      });
    });
  gateway.setRequestHandler("workboard.boards.list", ({ respond }) => {
    respond({ boards: boardSummaries() });
  });
  gateway.setRequestHandler("workboard.cards.list", ({ respond }) => {
    respond({
      statuses,
      cards: [...workboardCards.values()].toSorted(
        (left, right) =>
          statuses.indexOf(left.status) - statuses.indexOf(right.status) ||
          left.position - right.position ||
          left.createdAt - right.createdAt,
      ),
      boards: boardSummaries(),
    });
  });
  gateway.setRequestHandler("workboard.cards.stats", ({ params, respond }) => {
    const input = params as { boardId?: unknown };
    const boardId = typeof input?.boardId === "string" ? input.boardId.trim() : "";
    const cards = [...workboardCards.values()].filter(
      (card) => !boardId || card.metadata.automation.boardId === boardId,
    );
    const byAgent = new Map<string, number>();
    for (const card of cards) {
      const agentId = card.agentId || "(default)";
      byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + 1);
    }
    const archived = cards.filter((card) => Boolean(card.metadata.archivedAt)).length;
    const ready = cards.filter((card) => card.status === "ready" && !card.metadata.archivedAt);
    respond({
      id: boardId || "all",
      total: cards.length,
      active: cards.length - archived,
      archived,
      byStatus: Object.fromEntries(
        statuses.map((status) => [status, cards.filter((card) => card.status === status).length]),
      ),
      byAgent: Object.fromEntries(byAgent),
      ...(cards.length ? { updatedAt: Math.max(...cards.map((card) => card.updatedAt)) } : {}),
      ...(ready.length
        ? {
            oldestReadyAgeMs: Math.max(
              0,
              Date.now() - Math.min(...ready.map((card) => card.updatedAt)),
            ),
          }
        : {}),
    });
  });
  for (const method of ["workboard.cards.create", "workboard.cards.update"]) {
    gateway.setRequestHandler(method, ({ params, respond, emit }) => {
      const input = params as {
        id?: string;
        patch?: Partial<MockCard>;
        boardId?: string;
        templateId?: string;
      } & Partial<MockCard>;
      const updating = method === "workboard.cards.update";
      const existing = updating && input.id ? workboardCards.get(input.id) : undefined;
      const patch = updating ? (input.patch ?? {}) : input;
      if ((updating && !existing) || !(patch.title ?? existing?.title)?.trim()) {
        respond({
          __mockError: { code: "INVALID_REQUEST", message: "A valid card and title are required." },
        });
        return;
      }
      const now = Date.now();
      const boardId = existing?.metadata.automation.boardId ?? input.boardId ?? "default";
      const status = patch.status ?? existing?.status ?? "todo";
      if (!statuses.includes(status)) {
        respond({ __mockError: { code: "INVALID_REQUEST", message: "Unknown card status." } });
        return;
      }
      const card: MockCard = {
        ...existing,
        id: existing?.id ?? `mock-card-${++revision}`,
        title: (patch.title ?? existing?.title ?? "").trim(),
        notes: patch.notes ?? existing?.notes ?? "",
        priority: patch.priority ?? existing?.priority ?? "normal",
        labels: patch.labels ?? existing?.labels ?? [],
        agentId: patch.agentId ?? existing?.agentId ?? "",
        sessionKey: patch.sessionKey ?? existing?.sessionKey ?? "",
        status,
        position:
          existing?.position ??
          Math.max(
            0,
            ...[...workboardCards.values()]
              .filter(
                (entry) => entry.status === status && entry.metadata.automation.boardId === boardId,
              )
              .map((entry) => entry.position),
          ) + 1000,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        metadata: existing?.metadata ?? {
          automation: { boardId },
          ...(input.templateId ? { templateId: input.templateId } : {}),
        },
        events: [
          ...(existing?.events ?? []),
          { id: `mock-edit-${++revision}`, kind: updating ? "edited" : "created", at: now },
        ].slice(-50),
      };
      if (!workboardBoards.has(boardId)) {
        workboardBoards.set(boardId, { id: boardId, updatedAt: now });
      }
      workboardCards.set(card.id, card);
      respond({ card });
      emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
    });
  }
  gateway.setRequestHandler("workboard.cards.comment", ({ params, respond, emit }) => {
    const input = params as { id: string; body?: string };
    const card = workboardCards.get(input.id);
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!card || !body || body.length > 2000) {
      respond({
        __mockError: {
          code: "INVALID_REQUEST",
          message: !card
            ? "Unknown card."
            : !body
              ? "Comment body is required."
              : "Comment body must be 2000 characters or fewer.",
        },
      });
      return;
    }
    const now = Date.now();
    const comment = { id: `mock-comment-${++revision}`, body, createdAt: now };
    const updated: MockCard = {
      ...card,
      updatedAt: now,
      metadata: {
        ...card.metadata,
        comments: [...(card.metadata.comments ?? []), comment].slice(-50),
      },
      events: [
        ...(card.events ?? []),
        { id: `mock-comment-event-${revision}`, kind: "comment_added", at: now },
      ].slice(-50),
    };
    workboardCards.set(card.id, updated);
    respond({ card: updated });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
  });
  gateway.setRequestHandler("workboard.cards.archive", ({ params, respond, emit }) => {
    const input = params as { id: string; archived?: boolean };
    const card = workboardCards.get(input.id);
    if (!card) {
      respond({ __mockError: { code: "INVALID_REQUEST", message: "Unknown card." } });
      return;
    }
    const now = Date.now();
    const archived = input.archived !== false;
    const updated: MockCard = {
      ...card,
      updatedAt: now,
      metadata: { ...card.metadata, archivedAt: archived ? now : 0 },
      events: [
        ...(card.events ?? []),
        { id: `mock-archive-${++revision}`, kind: archived ? "archived" : "unarchived", at: now },
      ].slice(-50),
    };
    workboardCards.set(card.id, updated);
    respond({ card: updated });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
  });
  gateway.setRequestHandler("workboard.cards.delete", ({ params, respond, emit }) => {
    const input = params as { id: string };
    const deleted = workboardCards.delete(input.id);
    respond({ deleted });
    if (deleted) {
      emit("plugin.workboard.changed", { epoch: "workboard-mock", revision: ++revision });
    }
  });
  gateway.setRequestHandler("workboard.cards.move", ({ params, respond, emit }) => {
    const input = params as { id: string; status: string; position?: number };
    const card = workboardCards.get(input.id);
    if (!card || !statuses.includes(input.status)) {
      respond({ __mockError: { code: "INVALID_REQUEST", message: "Unknown card or status." } });
      return;
    }
    const now = Date.now();
    const moved: MockCard = {
      ...card,
      status: input.status,
      position: input.position ?? card.position,
      updatedAt: now,
      completedAt: input.status === "done" ? now : undefined,
      events: [
        ...(card.events ?? []),
        {
          id: `mock-move-${++revision}`,
          kind: "moved",
          at: now,
          fromStatus: card.status,
          toStatus: input.status,
        },
      ].slice(-50),
    };
    workboardCards.set(card.id, moved);
    respond({ card: moved });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
  });
  gateway.setRequestHandler("workboard.boards.upsert", ({ params, respond, emit }) => {
    const input = params as Record<string, unknown>;
    const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "default";
    const board: Record<string, unknown> = {
      ...workboardBoards.get(id),
      id,
      updatedAt: Date.now(),
    };
    for (const [key, value] of Object.entries(input)) {
      if ((key === "icon" || key === "color") && value === null) {
        delete board[key];
      } else if (key !== "id" && value !== undefined && value !== "") {
        Object.assign(board, { [key]: typeof value === "string" ? value.trim() : value });
      }
    }
    workboardBoards.set(id, board);
    respond({ board });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision: ++revision });
  });
}

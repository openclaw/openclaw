import { vi } from "vitest";
import type { createAgentTurnService } from "../../agent-turn/agent-turn-service.js";

const terminalMocks = vi.hoisted(() => ({
  startTurn: vi.fn<ReturnType<typeof createAgentTurnService>["startTurn"]>(),
}));

// Keep the registered worker, tool, Gateway authorization, and admission paths real.
// This boundary records the final dispatch without starting an unrelated model run.
vi.mock("../../agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn: terminalMocks.startTurn }),
}));

export const terminal = terminalMocks;

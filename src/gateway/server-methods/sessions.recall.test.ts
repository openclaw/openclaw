import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RespondFn } from "./types.js";

const loadConfigMock = vi.fn();
const resolveMemorySearchConfigMock = vi.fn();

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../../agents/memory-search.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/memory-search.js")>();
  return {
    ...actual,
    resolveMemorySearchConfig: (...args: unknown[]) => resolveMemorySearchConfigMock(...args),
  };
});

import { sessionsHandlers } from "./sessions.js";

describe("sessions.recall", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveMemorySearchConfigMock.mockReset();
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: { agentToAgent: { enabled: false } },
      agents: { list: [{ id: "main", default: true }] },
    });
    resolveMemorySearchConfigMock.mockReturnValue(null);
  });

  it("returns no-results summary when memory search is unavailable", async () => {
    const respond = vi.fn() as unknown as RespondFn;
    await sessionsHandlers["sessions.recall"]({
      req: { id: "req-recall-1" } as never,
      params: { query: "api decision" },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        summary: "No relevant prior sessions found.",
        citations: [],
        cached: false,
      },
      undefined,
    );
  });
});

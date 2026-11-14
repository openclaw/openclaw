import { describe, expect, it, vi } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (name: string) => ({
      ...original.createSubsystemLogger(name),
      ...(name === "agents/sessions-search" ? { warn } : {}),
    }),
  };
});

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];
const MAIN = "agent:main:main";

describe("sessions_search diagnostics", () => {
  it.each([
    { elapsed: 4999, fails: false },
    { elapsed: 5000, fails: false },
    { elapsed: 6000, fails: true },
  ])(
    "logs one private phase summary after $elapsed ms, fails=$fails",
    async ({ elapsed, fails }) => {
      warn.mockClear();
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const failure = new Error("private backend error");
      const tool = createSessionsSearchTool({
        config: {
          tools: { sessions: { visibility: "all" } },
          agents: { entries: { main: {} } },
        },
        agentSessionKey: MAIN,
        callGateway: async <T>(request: CallGatewayRequest): Promise<T> => {
          if (request.method === "sessions.list") {
            now += 1000;
            return { sessions: [{ key: MAIN }], hasMore: false } as T;
          }
          if (request.method === "sessions.describe") {
            return { session: null } as T;
          }
          now += elapsed - 1000;
          if (fails) {
            throw failure;
          }
          return {
            results: [
              {
                sessionKey: MAIN,
                sessionId: "session-main",
                messageId: "message-1",
                role: "assistant",
                timestamp: 123,
                snippet: "private text",
                score: 1,
              },
            ],
          } as T;
        },
      });
      try {
        const pending = tool.execute("private call id", { query: "private query" });
        if (fails) {
          await expect(pending).rejects.toBe(failure);
        } else {
          await expect(pending).resolves.toMatchObject({
            details: { results: [{ snippet: "private text" }] },
          });
        }
        expect(warn.mock.calls).toEqual(
          elapsed < 5000
            ? []
            : [
                [
                  "slow sessions search",
                  {
                    elapsedMs: elapsed,
                    listPages: 1,
                    listMs: 1000,
                    candidates: 1,
                    agents: 1,
                    searchChunks: 1,
                    searchMs: elapsed - 1000,
                    maxChunkMs: elapsed - 1000,
                  },
                ],
              ],
        );
      } finally {
        clock.mockRestore();
      }
    },
  );
});

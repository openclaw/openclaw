import { describe, expect, it, onTestFinished, vi } from "vitest";
import { canonicalizeSessionEntry } from "../agents/sessions/session-manager-persistence-entry.js";
import { normalizeTranscriptJsonValue } from "../config/sessions/transcript-json-normalize.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { PluginHookBeforePromptBuildEvent } from "./hook-before-agent-start.types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";

describe("prompt hook immutable payload isolation", () => {
  it("keeps tool scope read-only across priority-ordered handlers and dispatches", async () => {
    const toolsAllow = ["read", "mcp_notes_lookup"];
    const deferredToolNames = ["mcp_notes_lookup"];
    const event = { prompt: "test", messages: [], toolsAllow, deferredToolNames };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          priority: 10,
          handler: (value: unknown) => {
            const snapshot = value as PluginHookBeforePromptBuildEvent;
            expect(() =>
              Reflect.apply(Array.prototype.push, snapshot.toolsAllow, ["exec"]),
            ).toThrow(TypeError);
            expect(() =>
              Reflect.apply(Array.prototype.pop, snapshot.deferredToolNames, []),
            ).toThrow(TypeError);
            expect(Reflect.set(snapshot, "toolsAllow", ["exec"])).toBe(false);
            return { toolsAllow: ["read"] };
          },
        },
        {
          hookName: "before_prompt_build",
          handler: (value: unknown) => {
            expect(value).toMatchObject({ toolsAllow, deferredToolNames });
          },
        },
      ]),
      { catchErrors: false },
    );
    for (let dispatch = 0; dispatch < 2; dispatch++) {
      expect((await runner.runBeforePromptBuild(event, {}))?.toolsAllow).toEqual(["read"]);
      expect(event).toEqual({
        prompt: "test",
        messages: [],
        toolsAllow: ["read", "mcp_notes_lookup"],
        deferredToolNames: ["mcp_notes_lookup"],
      });
    }
  });

  it.each(["before_prompt_build", "agent_turn_prepare"] as const)(
    "%s shares immutable payloads without exposing stored metadata",
    async (hookName) => {
      const message = {
        role: "toolResult" as const,
        toolCallId: "call-1",
        toolName: "synthetic",
        isError: false,
        timestamp: 0,
        content: [{ type: "text" as const, text: "caller history" }],
        details: { private: "storage only" },
        __openclaw: { upstreamUserText: "storage prompt", retained: "visible" },
      };
      const entry = canonicalizeSessionEntry({
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: structuredClone(message),
      });
      normalizeTranscriptJsonValue(message, "");
      const frozenProjection = freezeJsonSnapshot(structuredClone(message));
      const messages = [message, entry.message, { ...frozenProjection }];
      const owned = new Set<object>(messages.flatMap((item) => [item.content, item.content[0]!]));
      const ownKeys = vi.spyOn(Reflect, "ownKeys");
      const clone = vi.spyOn(globalThis, "structuredClone");
      onTestFinished(() => {
        ownKeys.mockRestore();
        clone.mockRestore();
      });
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName,
            handler: (value: unknown) => {
              const event = value as { messages: (typeof message)[] };
              for (const [index, source] of messages.entries()) {
                const projected = event.messages[index]!;
                expect(projected.content).toBe(source.content);
                expect(() => {
                  projected.content[0]!.text = "forbidden mutation";
                }).toThrow(TypeError);
                expect(projected).not.toHaveProperty("details");
                expect(projected["__openclaw"]).toEqual({ retained: "visible" });
                projected["__openclaw"].retained = "local metadata";
                projected.toolName = "local tool name";
              }
              return { prependContext: "returned context" };
            },
          },
        ]),
        { catchErrors: false },
      );
      for (let turn = 0; turn < 2; turn++) {
        ownKeys.mockClear();
        clone.mockClear();
        const event = { prompt: "test", messages };
        const result =
          hookName === "before_prompt_build"
            ? await runner.runBeforePromptBuild(event, {})
            : await runner.runAgentTurnPrepare({ ...event, queuedInjections: [] }, {});
        expect(result?.prependContext).toBe("returned context");
        expect(clone).toHaveBeenCalledTimes(hookName === "before_prompt_build" ? 0 : 1);
        // Warm dispatch must not rescan the frozen payload graph (#182349).
        if (turn > 0) {
          expect(ownKeys.mock.calls.filter(([value]) => owned.has(value))).toHaveLength(0);
        }
        for (const source of messages) {
          expect(source.content[0]!.text).toBe("caller history");
          expect(source.toolName).toBe("synthetic");
          expect(source["__openclaw"].retained).toBe("visible");
        }
      }
    },
  );
});

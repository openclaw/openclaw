import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { readToolAllowlistIntersection } from "../agents/tool-policy.js";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginHookBeforePromptBuildResult, PluginHookRegistration } from "./types.js";

type PromptHook = Pick<
  PluginHookRegistration<"before_prompt_build">,
  "handler" | "requiresToolAuthority" | "priority"
>;
const event = { prompt: "test", messages: [] };
function promptRunner(hooks: PromptHook[]) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push(
    ...hooks.map((hook) => ({
      pluginId: "test",
      hookName: "before_prompt_build" as const,
      source: "test",
      ...hook,
    })),
  );
  return createHookRunner(registry);
}
const authority = {
  toolAuthorityFingerprint: "turn-authority",
  activeToolNames: ["message"],
  assertHostActive: () => undefined,
};

describe("prompt phase hooks", () => {
  it("merges context in priority order while keeping the first system prompt", async () => {
    const context = (suffix: string): PluginHookBeforePromptBuildResult => ({
      systemPrompt: `system ${suffix}`,
      prependContext: `context ${suffix}`,
      prependSystemContext: `prepend ${suffix}`,
      appendSystemContext: `append ${suffix}`,
    });
    const runner = promptRunner([
      { priority: 1, handler: () => context("B") },
      { priority: 10, handler: () => context("A") },
    ]);
    await expect(runner.runBeforePromptBuild(event, {})).resolves.toStrictEqual({
      systemPrompt: "system A",
      prependContext: "context A\n\ncontext B",
      appendContext: undefined,
      prependSystemContext: "prepend A\n\nprepend B",
      appendSystemContext: "append A\n\nappend B",
    });
  });

  it.each([
    { name: "explicit empty", toolsAllow: [] },
    { name: "non-array", toolsAllow: null as unknown as string[] },
    { name: "mixed-type array", toolsAllow: ["*", null] as unknown as string[] },
  ])("keeps $name tool restrictions closed", async ({ toolsAllow }) => {
    const runner = promptRunner([
      { handler: () => ({ toolsAllow }) },
      { handler: () => ({ toolsAllow: ["read"] }) },
    ]);
    await expect(runner.runBeforePromptBuild(event, {})).resolves.toStrictEqual({
      systemPrompt: undefined,
      prependContext: undefined,
      appendContext: undefined,
      prependSystemContext: undefined,
      appendSystemContext: undefined,
      toolsAllow: [],
    });
  });

  it("preserves overlapping frozen restrictions for the concrete tool surface", async () => {
    const runner = promptRunner([
      {
        handler: () => ({
          toolsAllow: Object.freeze(["group:fs", "web_*"]) as unknown as string[],
        }),
      },
      { handler: () => ({ toolsAllow: ["read", "*_search"] }) },
    ]);
    const toolsAllow = (await runner.runBeforePromptBuild(event, {}))?.toolsAllow;
    expect(toolsAllow).toBeDefined();
    expect(readToolAllowlistIntersection(toolsAllow ?? [])).toEqual([
      ["group:fs", "web_*"],
      ["read", "*_search"],
    ]);
    expect(
      applyEmbeddedAttemptToolsAllow(
        [
          { name: "read" },
          { name: "web_search" },
          { name: "web_fetch" },
          { name: "memory_search" },
        ],
        toolsAllow,
      ),
    ).toEqual([{ name: "read" }, { name: "web_search" }]);
  });

  it("enriches only after host authorization and expires the supplied authority", async () => {
    const enrichment = vi.fn<PromptHook["handler"]>((_event, ctx) => {
      expect(ctx.toolAuthority?.allows("memory_search")).toBe(false);
      expect(ctx.toolAuthority?.allows("message")).toBe(true);
      return { prependContext: "authorized context", systemPrompt: "ignored override" };
    });
    const runner = promptRunner([
      { handler: () => ({ toolsAllow: ["message"] }) },
      { requiresToolAuthority: true, handler: enrichment },
    ]);
    await expect(runner.runBeforePromptBuild(event, {})).resolves.toMatchObject({
      toolsAllow: ["message"],
    });
    expect(enrichment).not.toHaveBeenCalled();
    await expect(runner.runAuthorizedPromptBuild(event, {}, authority)).resolves.toEqual({
      prependContext: "authorized context",
    });
    const retained = enrichment.mock.calls[0]?.[1].toolAuthority;
    expect(() => retained?.assertActive()).toThrow("no longer active");
  });

  it("rejects stale enrichment and never starts its successor after host authority closes", async () => {
    const started = createDeferred();
    const gate = createDeferred();
    const later = vi.fn(() => ({ prependContext: "later context" }));
    const runner = promptRunner([
      {
        requiresToolAuthority: true,
        handler: async () => {
          started.resolve();
          await gate.promise;
          return { prependContext: "stale context" };
        },
      },
      { requiresToolAuthority: true, handler: later },
    ]);
    let active = true;
    const run = runner.runAuthorizedPromptBuild(
      event,
      {},
      {
        ...authority,
        assertHostActive: () => {
          if (!active) {
            throw new Error("host turn authority is no longer active");
          }
        },
      },
    );
    await started.promise;
    active = false;
    gate.resolve();
    await expect(run).rejects.toThrow("host turn authority is no longer active");
    expect(later).not.toHaveBeenCalled();
  });
});

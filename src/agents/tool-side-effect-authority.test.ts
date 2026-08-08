import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import {
  createAgentExecutionAttribution,
  rebindAgentExecutionAttribution,
} from "./agent-execution-attribution.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import {
  agentToolReplaySafetyOptions,
  agentToolRestartSafetyOptions,
} from "./agent-tool-instance-replay.js";
import { bindToolExecutionAttribution } from "./agent-tools.before-tool-call.attribution.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { setChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { isCodeModeControlTool, markCodeModeControlTool } from "./code-mode-control-tools.js";
import { isAgentToolReplaySafe, isAgentToolRestartSafe } from "./tool-replay-safety.js";
import {
  isTrustedToolPreparationError,
  registerTrustedToolPreparationError,
} from "./tool-result-error.js";
import {
  hasUnsafeToolExecutionAuthority,
  recordUnsafeToolExecutionAuthority,
} from "./tool-side-effect-authority.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function attribution(generation: string) {
  return createAgentExecutionAttribution({
    runId: "run-authority",
    lifecycleGeneration: generation,
  });
}

function tool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute,
  };
}

describe("tool side-effect authority", () => {
  it("fails closed without private execution attribution", () => {
    expect(hasUnsafeToolExecutionAuthority(undefined)).toBe(true);
  });

  it("records unsafe bodies monotonically while isolating lifecycle rebinds", () => {
    const original = attribution("generation-1");
    const originalContext = bindToolExecutionAttribution({}, original);

    recordUnsafeToolExecutionAuthority({ name: "read" }, {}, originalContext);
    expect(hasUnsafeToolExecutionAuthority(original)).toBe(false);

    recordUnsafeToolExecutionAuthority({ name: "write" }, {}, originalContext);
    expect(hasUnsafeToolExecutionAuthority(original)).toBe(true);

    const rebound = rebindAgentExecutionAttribution(original, "generation-2");
    expect(rebound).not.toBe(original);
    expect(hasUnsafeToolExecutionAuthority(rebound)).toBe(false);
  });

  it.each([
    { label: "plugin opted in", owner: "plugin-safe", expectedSafe: true },
    { label: "plugin opted out", owner: "plugin-unsafe", expectedSafe: false },
    { label: "channel-owned", owner: "channel", expectedSafe: false },
    { label: "core", owner: "core", expectedSafe: true },
  ] as const)(
    "keeps normal replay and body-start authority aligned for $label tools",
    ({ owner, expectedSafe }) => {
      const candidate = tool("search", async () => jsonResult({ ok: true }));
      if (owner === "plugin-safe" || owner === "plugin-unsafe") {
        setPluginToolMeta(candidate, {
          pluginId: owner,
          optional: false,
          replaySafe: owner === "plugin-safe",
        });
      } else if (owner === "channel") {
        setChannelAgentToolMeta(candidate as never, { channelId: "test-channel" });
      }
      const execution = attribution(`generation-${owner}`);
      const context = bindToolExecutionAttribution({}, execution);

      expect(isAgentToolReplaySafe(candidate, agentToolReplaySafetyOptions)).toBe(expectedSafe);
      recordUnsafeToolExecutionAuthority(candidate, {}, context);
      expect(hasUnsafeToolExecutionAuthority(execution)).toBe(!expectedSafe);
    },
  );

  it("keeps the MCP veto restart-only on top of the shared declaration", () => {
    const candidate = tool("search", async () => jsonResult({ ok: true }));
    setPluginToolMeta(candidate, {
      pluginId: "plugin-mcp",
      optional: false,
      replaySafe: true,
      mcp: {
        serverName: "test",
        safeServerName: "test",
        toolName: "search",
        operation: "tool",
      },
    });

    expect(isAgentToolReplaySafe(candidate, agentToolReplaySafetyOptions)).toBe(true);
    expect(isAgentToolRestartSafe(candidate, agentToolRestartSafetyOptions)).toBe(false);
  });

  it("excludes marked Code Mode controls from nested side-effect authority", () => {
    const execution = attribution("generation-control");
    const context = bindToolExecutionAttribution({}, execution);
    const control = markCodeModeControlTool(
      tool("exec", async () => jsonResult({ status: "completed" })),
    );

    recordUnsafeToolExecutionAuthority(control, { code: "return 1" }, context);

    expect(hasUnsafeToolExecutionAuthority(execution)).toBe(false);
  });

  it("preserves Code Mode identity across the before-tool wrapper", () => {
    const control = markCodeModeControlTool(
      tool("exec", async () => jsonResult({ status: "completed" })),
    );
    const wrapped = wrapToolWithBeforeToolCallHook(control, undefined, {
      emitDiagnostics: false,
    });

    expect(isCodeModeControlTool(wrapped)).toBe(true);
  });

  it.each([
    ["process", { action: "log", sessionId: "process-1" }],
    ["message", { action: "read", target: "channel-1" }],
    ["browser", { action: "snapshot", targetId: "tab-1" }],
    ["gateway", { action: "config.get" }],
    ["nodes", { action: "status" }],
  ] as const)("does not revoke repair authority for safe %s args", async (name, args) => {
    const execution = attribution(`generation-safe-${name}`);
    const context = bindToolExecutionAttribution({}, execution);
    const wrapped = wrapToolWithBeforeToolCallHook(
      {
        ...tool(name, async () => jsonResult({ ok: true })),
        parameters: Type.Object({ action: Type.String() }, { additionalProperties: true }),
      },
      context,
      { emitDiagnostics: false },
    );

    await wrapped.execute(`call-safe-${name}`, args);

    expect(hasUnsafeToolExecutionAuthority(execution)).toBe(false);
  });

  it.each([
    ["process", { action: "poll", sessionId: "process-1" }],
    ["process", { action: "kill", sessionId: "process-1" }],
    ["message", { action: "send", target: "channel-1", message: "hello" }],
    ["browser", { action: "act", kind: "click", ref: "submit" }],
    ["gateway", { action: "config.patch", patch: {} }],
    ["nodes", { action: "approve", requestId: "request-1" }],
  ] as const)("revokes repair authority for unsafe %s args", async (name, args) => {
    const execution = attribution(`generation-unsafe-${name}`);
    const context = bindToolExecutionAttribution({}, execution);
    const wrapped = wrapToolWithBeforeToolCallHook(
      {
        ...tool(name, async () => jsonResult({ ok: true })),
        parameters: Type.Object({ action: Type.String() }, { additionalProperties: true }),
      },
      context,
      { emitDiagnostics: false },
    );

    await wrapped.execute(`call-unsafe-${name}`, args);

    expect(hasUnsafeToolExecutionAuthority(execution)).toBe(true);
  });

  it("classifies the wrapped body's finalized args", async () => {
    const execution = attribution("generation-wrapped-final-args");
    const context = bindToolExecutionAttribution({}, execution);
    const wrapped = wrapToolWithBeforeToolCallHook(
      {
        ...tool("process", async () => jsonResult({ ok: true })),
        parameters: Type.Object({ action: Type.String() }, { additionalProperties: true }),
        prepareBeforeToolCallParams: async () => ({
          action: "log",
          sessionId: "process-final",
        }),
      },
      context,
      { emitDiagnostics: false },
    );

    await wrapped.execute("call-wrapped-final", {
      action: "kill",
      sessionId: "process-final",
    });

    expect(hasUnsafeToolExecutionAuthority(execution)).toBe(false);
  });

  it("classifies the nonwrapped adapter body's finalized args", async () => {
    const execution = attribution("generation-adapter-final-args");
    const context = bindToolExecutionAttribution({}, execution);
    const safe = {
      ...tool("process", async () => jsonResult({ ok: true })),
      parameters: Type.Object({ action: Type.String() }, { additionalProperties: true }),
      prepareBeforeToolCallParams: async () => ({
        action: "log",
        sessionId: "process-final",
      }),
    };
    const definition = toToolDefinitions([safe], context)[0];
    expect(definition).toBeDefined();
    if (!definition) {
      return;
    }

    await definition.execute(
      "call-adapter-final",
      { action: "kill", sessionId: "process-final" },
      undefined,
      undefined,
      {} as never,
    );

    expect(hasUnsafeToolExecutionAuthority(execution)).toBe(false);
  });

  it("records nonwrapped adapter authority before the tool body starts", async () => {
    const execution = attribution("generation-adapter");
    const context = bindToolExecutionAttribution({}, execution);
    let observedAuthority = false;
    const unsafe = tool("write", async () => {
      observedAuthority = hasUnsafeToolExecutionAuthority(execution);
      return jsonResult({ ok: true });
    });
    const definition = toToolDefinitions([unsafe], context)[0];
    expect(definition).toBeDefined();
    if (!definition) {
      return;
    }

    await definition.execute("call-write", {}, undefined, undefined, {} as never);

    expect(observedAuthority).toBe(true);
  });

  it("revokes preparation evidence thrown from a nonwrapped adapter body", async () => {
    const execution = attribution("generation-adapter-marker");
    const context = bindToolExecutionAttribution({}, execution);
    const preparationError = new Error("body propagated preparation marker");
    registerTrustedToolPreparationError(preparationError);
    const unsafe = tool("write", async () => {
      throw preparationError;
    });
    const definition = toToolDefinitions([unsafe], context)[0];
    expect(definition).toBeDefined();
    if (!definition) {
      return;
    }

    await definition.execute("call-write-marker", {}, undefined, undefined, {} as never);

    expect(isTrustedToolPreparationError(preparationError)).toBe(false);
    expect(hasUnsafeToolExecutionAuthority(execution)).toBe(true);
  });

  it("revokes preparation evidence propagated through a started outer body", async () => {
    const execution = attribution("generation-marker");
    const context = bindToolExecutionAttribution({}, execution);
    const preparationError = new Error("inner preparation failed");
    registerTrustedToolPreparationError(preparationError);
    const inner = wrapToolWithBeforeToolCallHook(
      {
        ...tool("inner", async () => jsonResult({ unreachable: true })),
        prepareBeforeToolCallParams: async () => {
          throw preparationError;
        },
      },
      context,
      { emitDiagnostics: false },
    );
    const outer = wrapToolWithBeforeToolCallHook(
      tool("outer", async () => await inner.execute("inner-call", {})),
      context,
      { emitDiagnostics: false },
    );

    let propagated: unknown;
    try {
      await outer.execute("outer-call", {});
    } catch (error) {
      propagated = error;
    }

    expect(propagated).toBeInstanceOf(Error);
    expect(isTrustedToolPreparationError(propagated)).toBe(false);
    expect(hasUnsafeToolExecutionAuthority(execution)).toBe(true);
  });
});

import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../agents/runtime/index.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { nativeBoundaryTestEntrypoints } from "./native-boundary-runtime.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const rejectionUrl = resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.unhandledRejections);
const hooksUrl = resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.pluginHooks);
const registryUrl = resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.emptyPluginRegistry);

function createToolResultMessage(text: string, details?: Record<string, unknown>): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    content: [{ type: "text", text }],
    isError: false,
    ...(details ? { details } : {}),
  } as AgentMessage;
}

function createLogger() {
  return {
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

describe("sync-only plugin hooks", () => {
  it("contains rejected tool-result handlers before the fatal rejection handler", () => {
    const hookName = "tool_result_persist";
    const method = "runToolResultPersist";
    const nodeExecutable = resolveTestNodeExecPath();
    const result = spawnSync(
      nodeExecutable,
      [
        ...resolveRuntimeWorkerArgv(rejectionUrl, nodeExecutable).slice(0, -1),
        "--input-type=module",
        "--eval",
        `import { installUnhandledRejectionHandler } from ${JSON.stringify(rejectionUrl.href)};
       import { createHookRunner } from ${JSON.stringify(hooksUrl.href)};
       import { createEmptyPluginRegistry } from ${JSON.stringify(registryUrl.href)};
       installUnhandledRejectionHandler();
       const registry = createEmptyPluginRegistry();
       registry.typedHooks.push({
         hookName: "${hookName}",
         pluginId: "rejected-sync-hook",
         source: "sync-only-regression",
         handler: () => Promise.reject(new Error("sync-hook-rejection")),
       });
       const warnings = [];
       const errors = [];
       const runner = createHookRunner(registry, {
         logger: { warn: (message) => warnings.push(message), error: (message) => errors.push(message) },
       });
       const message = { role: "toolResult", toolCallId: "call_1", content: [], isError: false };
       runner.${method}({ message }, {});
       await new Promise((resolve) => setImmediate(resolve));
       const expectedWarning = "[hooks] ${hookName} handler from rejected-sync-hook returned a Promise; this hook is synchronous and the result was ignored.";
       if (warnings.length !== 1 || warnings[0] !== expectedWarning || errors.length !== 0) {
         console.error(JSON.stringify({ warnings, errors }));
         process.exit(2);
       }
       console.log("sync hook rejection contained");`,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sync hook rejection contained");
    expect(result.stderr).not.toContain("Unhandled promise rejection");
  });

  it("preserves synchronous secret redaction and subsequent handler composition", () => {
    const logger = createLogger();
    const secret = ["fixture", "secret"].join("-");
    const originalMessage = createToolResultMessage(JSON.stringify({ value: secret }), {
      value: secret,
    });
    const observedMessages: AgentMessage[] = [];
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_persist",
          pluginId: "ignored-async-handler",
          priority: 30,
          handler: async () => ({ message: createToolResultMessage("ignored") }),
        },
        {
          hookName: "tool_result_persist",
          pluginId: "secret-redactor",
          priority: 20,
          handler: (event) => {
            const message = (event as { message: AgentMessage }).message;
            return {
              message: {
                ...message,
                content: [{ type: "text", text: JSON.stringify({ redacted: true }) }],
                details: { redacted: true },
              },
            };
          },
        },
        {
          hookName: "tool_result_persist",
          pluginId: "subsequent-handler",
          priority: 10,
          handler: (event) => {
            const message = (event as { message: AgentMessage }).message;
            observedMessages.push(message);
            return { message: { ...message, details: { redacted: true, observed: true } } };
          },
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultPersist({ message: originalMessage }, {});

    expect(observedMessages).toHaveLength(1);
    expect(JSON.stringify(observedMessages[0])).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result?.message).toMatchObject({ details: { redacted: true, observed: true } });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("preserves synchronous message blocking and priority order", () => {
    const logger = createLogger();
    const calls: string[] = [];
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          pluginId: "ignored-async-handler",
          priority: 30,
          handler: async () => {
            calls.push("async");
            return { block: false };
          },
        },
        {
          hookName: "before_message_write",
          pluginId: "message-blocker",
          priority: 20,
          handler: () => {
            calls.push("blocker");
            return { block: true };
          },
        },
        {
          hookName: "before_message_write",
          pluginId: "unreached-handler",
          priority: 10,
          handler: () => {
            calls.push("unreached");
          },
        },
      ]),
      { logger },
    );

    expect(
      runner.runBeforeMessageWrite({ message: createToolResultMessage("original") }, {}),
    ).toEqual({ block: true });
    expect(calls).toEqual(["async", "blocker"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("preserves fail-closed behavior for async handlers", () => {
    const hookName = "tool_result_persist";
    const logger = createLogger();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName,
          pluginId: "fail-closed-hook",
          handler: async () => undefined,
        },
      ]),
      { logger, failurePolicyByHook: { [hookName]: "fail-closed" } },
    );

    expect(() =>
      runner.runToolResultPersist({ message: createToolResultMessage("original") }, {}),
    ).toThrow(
      `[hooks] ${hookName} handler from fail-closed-hook failed: Error: ` +
        `[hooks] ${hookName} handler from fail-closed-hook returned a Promise; ` +
        "this hook is synchronous and the result was ignored.",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

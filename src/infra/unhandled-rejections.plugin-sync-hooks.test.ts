import { spawnSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
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
    toolName: "probe",
    content: [{ type: "text", text }],
    isError: false,
    ...(details ? { details } : {}),
  } as AgentMessage;
}

type Hook = Parameters<typeof createMockPluginRegistry>[0][number];
type LogMock = ReturnType<typeof vi.fn<(message: string) => void>>;
let logger: { warn: LogMock; error: LogMock };
beforeEach(() => {
  logger = { warn: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() };
});
function hook(pluginId: string, priority: number, handler: Hook["handler"]) {
  return { pluginId, priority, handler };
}
function createRunner(hookName: string, hooks: Omit<Hook, "hookName">[], failClosed = false) {
  return createHookRunner(
    createMockPluginRegistry(hooks.map((entry) => ({ ...entry, hookName }))),
    {
      logger,
      ...(failClosed ? { failurePolicyByHook: { [hookName]: "fail-closed" as const } } : {}),
    },
  );
}

it("contains rejected tool-result handlers before the fatal rejection handler", () => {
  const hookName = "tool_result_persist";
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
       runner.runToolResultPersist({ message }, {});
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
  const secret = ["fixture", "secret"].join("-");
  const originalMessage = createToolResultMessage(secret, { value: secret });
  const observedMessages: AgentMessage[] = [];
  const runner = createRunner("tool_result_persist", [
    hook("async", 30, async () => ({ message: createToolResultMessage("ignored") })),
    hook("secret-redactor", 20, () => ({
      message: createToolResultMessage("redacted", { redacted: true }),
    })),
    hook("subsequent-handler", 10, (event) => {
      const message = (event as { message: AgentMessage }).message;
      observedMessages.push(message);
      return { message: { ...message, details: { redacted: true, observed: true } } };
    }),
  ]);

  const result = runner.runToolResultPersist({ message: originalMessage }, {});

  expect(observedMessages).toHaveLength(1);
  expect(JSON.stringify(observedMessages[0])).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result?.message).toMatchObject({ details: { redacted: true, observed: true } });
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.error).not.toHaveBeenCalled();
});

it("preserves synchronous message blocking and priority order", () => {
  const calls: string[] = [];
  const runner = createRunner("before_message_write", [
    hook("ignored-async-handler", 30, async () => {
      calls.push("async");
      return { block: false };
    }),
    hook("message-blocker", 20, () => {
      calls.push("blocker");
      return { block: true };
    }),
    hook("unreached-handler", 10, () => {
      calls.push("unreached");
    }),
  ]);

  expect(
    runner.runBeforeMessageWrite({ message: createToolResultMessage("original") }, {}),
  ).toEqual({ block: true });
  expect(calls).toEqual(["async", "blocker"]);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.error).not.toHaveBeenCalled();
});

it("preserves fail-closed behavior for async handlers", () => {
  const hookName = "tool_result_persist";
  const runner = createRunner(hookName, [hook("fail-closed-hook", 0, async () => undefined)], true);

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

it.each(
  (["tool_result_persist", "before_message_write"] as const).flatMap((hookName) =>
    ["not-a-message", {}].map((message) => ({ hookName, message })),
  ),
)("logs and ignores $hookName replacement $message", ({ hookName, message }) => {
  const originalMessage = createToolResultMessage("original");
  const runner = createRunner(hookName, [hook("malformed-sync-hook", 0, () => ({ message }))]);

  const result =
    hookName === "tool_result_persist"
      ? runner.runToolResultPersist({ message: originalMessage }, {})
      : runner.runBeforeMessageWrite({ message: originalMessage }, {});

  expect(result).toEqual(
    hookName === "tool_result_persist" ? { message: originalMessage } : undefined,
  );
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(`[hooks] ${hookName} handler from malformed-sync-hook failed:`),
  );
});

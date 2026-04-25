import { describe, expect, it, vi } from "vitest";
import { createOpenClawTools } from "../openclaw-tools.js";
import "../test-helpers/fast-core-tools.js";
import { createPerSenderSessionConfig } from "../test-helpers/session-config.js";

// CI runners are slower than dev hardware; this test transitively loads the full
// createOpenClawTools dependency graph (~70s on a Spark, ~120s+ on CI). Bump
// per-test timeout above the default 120s ceiling. Follow-up: lazy-load heavy
// deps in createOpenClawTools so import is fast (tracked separately).
describe("continuation tool registration", { timeout: 240000 }, () => {
  const config = {
    session: createPerSenderSessionConfig(),
    agents: {
      defaults: {
        continuation: {
          enabled: true,
        },
      },
    },
  } as const;

  it("exposes continue_delegate on normal turns when continuation is enabled", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(true);
  });

  it("hides continue_delegate when continuation is disabled", () => {
    const tools = createOpenClawTools({
      config: {
        ...config,
        agents: { defaults: { continuation: { enabled: false } } },
      },
      agentSessionKey: "main",
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(false);
  });

  it("exposes continue_work when continuation is enabled and the runner wires it", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      continueWorkOpts: {
        requestContinuation: vi.fn(),
      },
    });

    expect(tools.some((tool) => tool.name === "continue_work")).toBe(true);
  });

  // Truth-table coverage for the drainsContinuationDelegateQueue gate predicate
  // in createOpenClawTools (`!== false`). Three states must be pinned so a future
  // refactor cannot silently regress to `=== true` (which broke the
  // "normal turns" case on PR #306 commit c825009e9b8 before the !== false fix
  // landed in 9f00132dd67). See discussion at
  // https://github.com/karmaterminal/openclaw/pull/306
  it("exposes continue_delegate when drainsContinuationDelegateQueue is undefined (default normal turns)", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      // drainsContinuationDelegateQueue intentionally omitted to assert default behavior
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(true);
  });

  it("exposes continue_delegate when drainsContinuationDelegateQueue is explicitly true (explicit drainers)", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      drainsContinuationDelegateQueue: true,
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(true);
  });

  it("hides continue_delegate when drainsContinuationDelegateQueue is explicitly false (e.g. llm-slug-generator)", () => {
    const tools = createOpenClawTools({
      config,
      agentSessionKey: "main",
      drainsContinuationDelegateQueue: false,
    });

    expect(tools.some((tool) => tool.name === "continue_delegate")).toBe(false);
  });
});

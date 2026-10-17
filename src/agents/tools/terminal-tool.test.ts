import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "../../gateway/terminal/session-manager.test-helpers.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { createSubscribedCodeModeHarness } from "../code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { runUntilCompleted } from "../code-mode.test-support.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createTerminalTool } from "./terminal-tool.js";

const getInProcessGatewayToolContext = vi.hoisted(() => vi.fn());
const loadGatewaySessionEntryReadOnly = vi.hoisted(() => vi.fn(() => ({ entry: undefined })));
const approvalMocks = vi.hoisted(() => ({
  register: vi.fn(async ({ approvalId }: { approvalId: string }) => ({
    id: approvalId,
    expiresAtMs: Date.now() + 10_000,
  })),
  decide: vi.fn(async (): Promise<string | null> => "allow-once"),
}));

vi.mock("./in-process-gateway.js", () => ({ getInProcessGatewayToolContext }));
// mock-isolation: terminal ownership tests supply entry facts without opening session databases.
vi.mock("../../gateway/session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: loadGatewaySessionEntryReadOnly,
}));
vi.mock("../bash-tools.exec-approval-request.js", () => ({
  registerExecApprovalRequestForHostOrThrow: approvalMocks.register,
  resolveRegisteredExecApprovalDecision: approvalMocks.decide,
}));

const agentOwner = agentTerminalOwner("agent:main:main", "main-session-id");
type TerminalToolOptions = NonNullable<Parameters<typeof createTerminalTool>[0]>;

function emptyManager() {
  return new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
}

function withPermission(permissionMode: "guarded" | "full") {
  return openAgentTerminal({ execSession: { permissionMode } });
}

function makeContext(manager: TerminalSessionManager) {
  return { terminalSessions: manager };
}

const agentToolOptions = {
  agentId: "main",
  agentSessionKey: agentOwner.agentSessionKey,
  sessionId: agentOwner.agentSessionId,
};

function makeTool(manager: TerminalSessionManager, options: TerminalToolOptions = {}) {
  return createTerminalTool({
    ...agentToolOptions,
    execSession: {},
    getGatewayContext: () => makeContext(manager),
    ...options,
  });
}

async function openAgentTerminal(options: TerminalToolOptions = {}) {
  const backend = makeFakePty();
  const spawn = vi.fn(async () => backend);
  const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
  const { sessionId } = expectTerminalOpen(
    await manager.open(baseOpenRequest({ owner: agentOwner })),
  );
  spawn.mockClear();
  const tool = makeTool(manager, options);
  const input = (data = "echo unsafe\r", id = "input") =>
    tool.execute(id, { action: "input", sessionId, data });
  return { backend, manager, sessionId, spawn, tool, input };
}

async function withActiveRun<T>(
  manager: TerminalSessionManager,
  run: (authority: ReturnType<typeof claimAgentRunDelegatedAuthority>) => Promise<T>,
) {
  const operationalRunInstance = { instanceId: "terminal-instance", runId: "terminal-run" };
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  try {
    return await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: agentOwner.agentSessionKey,
        operationalRunInstance,
        gatewayContextResolver: () => makeContext(manager) as GatewayRequestContext,
      },
      () => run(authority),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("terminal tool", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    getInProcessGatewayToolContext.mockReset();
    loadGatewaySessionEntryReadOnly.mockClear();
    approvalMocks.register.mockClear();
    approvalMocks.decide.mockReset();
    approvalMocks.decide.mockResolvedValue("allow-once");
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("exposes existing-session controls but never shell creation behind the owner-only gate", () => {
    const tool = createTerminalTool();

    expect(tool.parameters).toMatchObject({
      properties: {
        action: { type: "string", enum: ["read", "list", "resize", "close", "input"] },
        sessionId: { type: "string" },
      },
    });
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      "action sessionId data cols rows".split(" "),
    );
    expect(schema.properties).not.toHaveProperty("command");
    expect(schema.properties).not.toHaveProperty("cwd");
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("terminal");
  });

  it("cannot open or spawn a gateway terminal even when an existing terminal is available", async () => {
    const { backend, manager, sessionId, spawn, tool } = await openAgentTerminal();

    await expect(tool.execute("open", { action: "open", sessionId })).rejects.toThrow(
      "terminal action unavailable",
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(backend.writes).toEqual([]);
    expect(backend.resizes).toEqual([]);
    expect(backend.killed).toBe(false);
    expect(manager.size).toBe(1);
  });

  it.each(["admitted", "retired", "ambient"])("routes %s Gateway context", async (route) => {
    const callerManager = emptyManager();
    const ambientManager = emptyManager();
    const callerList = vi.spyOn(callerManager, "listAgent");
    const ambientList = vi.spyOn(ambientManager, "listAgent");
    getInProcessGatewayToolContext.mockReturnValue(makeContext(ambientManager));
    const tool = createTerminalTool(agentToolOptions);
    const execute = () => tool.execute("list", { action: "list" });
    const result =
      route === "ambient"
        ? execute()
        : withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: agentOwner.agentSessionKey,
              gatewayContextResolver: () =>
                route === "retired" ? undefined : makeContext(callerManager),
            },
            execute,
          );
    if (route === "retired") {
      await expect(result).rejects.toThrow("terminal unavailable");
    } else {
      expect((await result).details).toEqual({ sessions: [] });
      expect(route === "ambient" ? ambientList : callerList).toHaveBeenCalledOnce();
    }
    if (route !== "ambient") {
      expect(ambientList).not.toHaveBeenCalled();
    }
  });

  it("lists, reads, resizes, and closes only its existing operator-opened terminal", async () => {
    const backend = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const { sessionId } = expectTerminalOpen(
      await manager.open(baseOpenRequest({ owner: agentOwner, viewerConnId: "operator" })),
    );
    const tool = makeTool(manager);
    const execute = async (action: string, args: Record<string, unknown> = {}) => {
      const { details } = await tool.execute(action, {
        action,
        ...(action === "list" ? {} : { sessionId }),
        ...args,
      });
      expect(Value.Check(tool.outputSchema!, details)).toBe(true);
      return details;
    };

    expect(tool.outputSchema).toBeDefined();
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ sessions: Array<{ agentId: string; attached: boolean; createdAtMs: number; cwd: string; owner: string; sessionId: string; shell: string }> } | { sessionId: string; text: string } | { ok: true }",
    );

    expect(await execute("list")).toEqual({
      sessions: [
        expect.objectContaining({
          sessionId,
          attached: true,
          owner: `agent:${agentOwner.agentSessionKey}`,
        }),
      ],
    });

    backend.emitData("\u001b[31mready\u001b[0m\r\n");
    const read = await execute("read");
    expect(read).toEqual({
      sessionId,
      text: expect.stringContaining("ready\n"),
    });
    expect((read as { text: string }).text).not.toContain("\u001b");

    expect(manager.write("operator", sessionId, "operator command\r")).toBe(true);
    expect(backend.writes).toEqual(["operator command\r"]);

    expect(await execute("resize", { cols: 120, rows: 40 })).toEqual({ ok: true });
    expect(backend.resizes).toEqual([[120, 40]]);

    expect(await execute("close")).toEqual({ ok: true });
    expect(backend.killed).toBe(true);
  });

  it("cannot inspect, resize, or close connection-owned and replacement-incarnation terminals", async () => {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => makeFakePty() });
    const connectionOwned = expectTerminalOpen(await manager.open(baseOpenRequest()));
    const replacementOwned = expectTerminalOpen(
      await manager.open(
        baseOpenRequest({
          owner: agentTerminalOwner(agentOwner.agentSessionKey, "replacement-session-id"),
        }),
      ),
    );
    const tool = makeTool(manager);

    for (const sessionId of [connectionOwned.sessionId, replacementOwned.sessionId]) {
      for (const params of [
        { action: "read", sessionId },
        { action: "resize", sessionId, cols: 100, rows: 30 },
        { action: "close", sessionId },
      ]) {
        await expect(tool.execute(params.action, params)).rejects.toThrow(
          "Terminal session unavailable. Use action=list to find a shared terminal or ask the operator to open one in this chat.",
        );
      }
    }
    await expect(tool.execute("list", { action: "list" })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(manager.size).toBe(2);
  });

  it.each([
    {
      label: "explicit exec denial",
      options: { config: { tools: { exec: { mode: "deny" } } }, execSession: {} },
    },
    { label: "read-only session", options: { execSession: { permissionMode: "read-only" } } },
  ] satisfies Array<{ label: string; options: TerminalToolOptions }>)(
    "rejects terminal input under $label without requesting approval",
    async ({ options }) => {
      const { backend, input } = await openAgentTerminal(options);

      await expect(input()).rejects.toThrow("Terminal input denied by execution policy");

      expect(backend.writes).toEqual([]);
      expect(approvalMocks.register).not.toHaveBeenCalled();
      expect(approvalMocks.decide).not.toHaveBeenCalled();
    },
  );

  it("preserves required-sandbox no-start through Code Mode before terminal input approval or write", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const harness = createSubscribedCodeModeHarness({ name: "terminal-sandbox-denial" });
    const terminal = wrapToolWithBeforeToolCallHook(
      makeTool(manager, {
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        execSession: { sandbox: "required" },
      }),
      { runId: harness.runId },
    );
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, terminal] });
    try {
      const details = await runUntilCompleted({
        execTool: harness.tools[0]!,
        waitTool: harness.tools[1]!,
        code: `return await terminal(${JSON.stringify({ action: "input", sessionId, data: "echo untouched\r" })});`,
      });
      expect(details).toMatchObject({ status: "failed", bridgeDispatchStarted: true });
      expect(details.error).toContain("sandbox runtime is unavailable");
      expect(backend.writes).toEqual([]);
      expect(approvalMocks.register).not.toHaveBeenCalled();
      expect(approvalMocks.decide).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      manager.closeAgent(agentOwner, sessionId);
    }
  });

  it("rejects terminal input when the authoritative persisted session is missing", async () => {
    const { backend, input } = await openAgentTerminal({ execSession: undefined });
    setRuntimeConfigSnapshot({});
    await expect(input()).rejects.toThrow("Terminal session unavailable");

    expect(loadGatewaySessionEntryReadOnly).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      key: agentOwner.agentSessionKey,
      agentId: agentOwner.agentId,
    });
    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it("rejects full terminal input without an active admitted run", async () => {
    const { backend, input } = await withPermission("full");
    await expect(input()).rejects.toThrow("agent run is no longer active");

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it("rejects full terminal input after its exact run authority is replaced", async () => {
    const { backend, manager, input } = await withPermission("full");

    await withActiveRun(manager, async (authority) => {
      const replacement = claimAgentRunDelegatedAuthority({
        instanceId: "replacement-terminal-instance",
        runId: authority.operationalRunInstance.runId,
      });

      try {
        await expect(input()).rejects.toThrow("agent run is no longer active");
      } finally {
        releaseAgentRunDelegatedAuthority(replacement);
      }
    });

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it("requires a fresh explicit operator approval for every input in a workspace session", async () => {
    const { backend, manager, input } = await openAgentTerminal({
      execSession: { permissionMode: "workspace" },
      approvalReviewerDeviceIds: ["reviewer-device"],
    });

    await withActiveRun(manager, async () => {
      for (const [index, data] of ["echo first\r", "echo second\r"].entries()) {
        const result = await input(data, `guarded-input-${index}`);
        expect(result.details).toEqual({ ok: true });
      }
    });

    expect(backend.writes).toEqual(["echo first\r", "echo second\r"]);
    expect(approvalMocks.register).toHaveBeenCalledTimes(2);
    expect(approvalMocks.decide).toHaveBeenCalledTimes(2);
    expect(approvalMocks.register).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        approvalId: expect.any(String),
        command: `Terminal input: ${JSON.stringify("echo first\r")}`,
        host: "gateway",
        security: "allowlist",
        ask: "always",
        unavailableDecisions: ["allow-always"],
        agentId: "main",
        sessionKey: agentOwner.agentSessionKey,
        sessionId: agentOwner.agentSessionId,
        runId: "terminal-run",
        toolCallId: "guarded-input-0",
        approvalReviewerDeviceIds: ["reviewer-device"],
        requireDeliveryRoute: true,
      }),
    );
  });

  it("waits for an explicit one-shot decision before writing guarded input", async () => {
    const { backend, manager, input } = await withPermission("guarded");
    const decision = createDeferred<string>();
    approvalMocks.decide.mockImplementationOnce(() => decision.promise);

    await withActiveRun(manager, async () => {
      const pending = input("echo pending\r", "pending-input");
      await vi.waitFor(() => expect(approvalMocks.decide).toHaveBeenCalledOnce());
      expect(backend.writes).toEqual([]);

      decision.resolve("allow-once");
      await expect(pending).resolves.toMatchObject({ details: { ok: true } });
    });

    expect(backend.writes).toEqual(["echo pending\r"]);
  });

  it.each([
    { cause: "the operator decision is allow-always", error: "operator approval required" },
    { cause: "no operator approval route is available", error: /approval|route/i },
    {
      cause: "its exact run authority is lost during approval",
      error: "agent run is no longer active",
    },
    {
      cause: "its terminal session is lost during approval",
      error: "Terminal session unavailable",
    },
  ])("rejects guarded input when $cause", async ({ cause, error }) => {
    const { backend, manager, sessionId, input } = await withPermission("guarded");
    await withActiveRun(manager, async (authority) => {
      if (cause === "no operator approval route is available") {
        approvalMocks.register.mockRejectedValueOnce(new Error("no approval delivery route"));
      } else {
        approvalMocks.decide.mockImplementationOnce(async () => {
          if (cause === "its exact run authority is lost during approval") {
            releaseAgentRunDelegatedAuthority(authority);
          } else if (cause === "its terminal session is lost during approval") {
            manager.closeAgent(agentOwner, sessionId);
          }
          return cause === "the operator decision is allow-always" ? "allow-always" : "allow-once";
        });
      }
      await expect(input()).rejects.toThrow(error);
    });
    expect(backend.writes).toEqual([]);
    if (cause === "no operator approval route is available") {
      expect(approvalMocks.decide).not.toHaveBeenCalled();
    }
  });

  it("rejects guarded input when its admitted Gateway changes during operator approval", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const replacement = emptyManager();
    let currentManager = manager;
    const tool = makeTool(manager, {
      execSession: { permissionMode: "guarded" },
      getGatewayContext: () => makeContext(currentManager),
    });
    approvalMocks.decide.mockImplementationOnce(async () => {
      currentManager = replacement;
      return "allow-once";
    });

    await withActiveRun(manager, async () => {
      await expect(
        tool.execute("stale-gateway-input", { action: "input", sessionId, data: "echo unsafe\r" }),
      ).rejects.toThrow("Terminal session unavailable");
    });

    expect(backend.writes).toEqual([]);
  });

  it.each([
    { options: { sessionId: "main-session-id" }, error: "agent session required" },
    { options: { agentSessionKey: "agent:main:main" }, error: "agent session id required" },
  ])("requires exact session ownership before reading: $error", async ({ options, error }) => {
    const manager = emptyManager();
    const tool = createTerminalTool({
      ...options,
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("list", { action: "list" })).rejects.toThrow(error);
  });
});

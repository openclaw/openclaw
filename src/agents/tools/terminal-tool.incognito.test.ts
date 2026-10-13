import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "../../gateway/terminal/session-manager.test-helpers.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-context-binding.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createTerminalTool } from "./terminal-tool.js";

const approvals = vi.hoisted(() => ({
  register: vi.fn(async ({ approvalId }: { approvalId: string }) => ({ id: approvalId })),
  decide: vi.fn(async (): Promise<string> => "allow-once"),
}));
// mock-isolation: Supply operator decisions without opening a live approval transport.
vi.mock("../bash-tools.exec-approval-request.js", () => ({
  registerExecApprovalRequestForHostOrThrow: approvals.register,
  resolveRegisteredExecApprovalDecision: approvals.decide,
}));

const temporary = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
const managers = new Set<TerminalSessionManager>();
beforeAll(async () => {
  actor = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: temporary.make("terminal-tool-incognito-") },
    authority,
  );
});
afterAll(async () => {
  await actor.close();
});
beforeEach(() => {
  approvals.register.mockClear();
  approvals.decide.mockReset().mockResolvedValue("allow-once");
});
afterEach(() => {
  for (const manager of managers) {
    manager.disposeAll();
  }
  managers.clear();
});
useIncognitoNoHostSql();

async function terminal(name: string, permissionMode: "full" | "workspace" = "workspace") {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry = { sessionId: name, lifecycleRevision: "original", updatedAt: 1, permissionMode };
  await actor.sessions.create(authority, { sessionKey, entry });
  const owner = agentTerminalOwner(sessionKey, entry.sessionId);
  const backend = makeFakePty();
  const manager = new TerminalSessionManager({ emit() {}, spawn: async () => backend });
  managers.add(manager);
  const opened = expectTerminalOpen(await manager.open(baseOpenRequest({ owner })));
  return {
    entry,
    owner,
    backend,
    manager,
    terminalId: opened.sessionId,
    target: { agentId: "main", sessionKey, storePath: actor.path },
  };
}

async function invoke<T>(
  fixture: Awaited<ReturnType<typeof terminal>>,
  route: "owner" | "bearer-mcp",
  consume: (tool: ReturnType<typeof createTerminalTool>) => Promise<T>,
) {
  const admission = prepareSystemAgentRunAdmission({}, fixture.entry.sessionId, "main", "terminal");
  try {
    const admittedRunContext = await admission.admit("embedded");
    const gateway = { terminalSessions: fixture.manager };
    bindGatewayContextResolver(admittedRunContext, () => gateway as GatewayRequestContext);
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: fixture.owner.agentSessionKey,
      sessionId: fixture.entry.sessionId,
      ...(route === "owner" ? { getGatewayContext: () => gateway } : {}),
    });
    return await withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey: fixture.owner.agentSessionKey,
        ...(route === "bearer-mcp" ? { receiptAuthority: () => true } : {}),
      }),
      () => consume(tool),
    );
  } finally {
    admission.close();
  }
}

it.each(["owner", "bearer-mcp"] as const)(
  "loads actor policy for %s input without prepared execSession",
  async (route) => {
    const fixture = await terminal(`input-${route}`, "full");
    await withIncognitoSessionActor(actor, () =>
      invoke(fixture, route, async (tool) => {
        await expect(
          tool.execute("input", { action: "input", sessionId: fixture.terminalId, data: "pwd\r" }),
        ).resolves.toMatchObject({ details: { ok: true } });
      }),
    );
    expect(fixture.backend.writes).toEqual(["pwd\r"]);
    expect(approvals.register).not.toHaveBeenCalled();
  },
);

it.each([
  { change: "permission revocation", error: "execution policy changed" },
  { change: "session rebound", error: "generation is no longer current" },
] as const)("refuses input after $change while approval is pending", async ({ change, error }) => {
  const fixture = await terminal(change.replaceAll(" ", "-"));
  const requested = createDeferredCore();
  const decision = createDeferredCore<string>();
  approvals.decide.mockImplementationOnce(() => {
    requested.resolve();
    return decision.promise;
  });
  await withIncognitoSessionActor(actor, () =>
    invoke(fixture, "bearer-mcp", async (tool) => {
      const result = tool.execute("input", {
        action: "input",
        sessionId: fixture.terminalId,
        data: "echo stale\r",
      });
      try {
        await awaitGateBeforeSettlement(requested.promise, result, "Input settled before approval");
        expect(fixture.backend.writes).toEqual([]);
        if (change === "permission revocation") {
          await patchSessionEntryCore(fixture.target, () => ({ permissionMode: "read-only" }));
        } else {
          await replaceSessionEntry(fixture.target, {
            ...fixture.entry,
            sessionId: "replacement",
            lifecycleRevision: "next",
          });
        }
      } finally {
        decision.resolve("allow-once");
        await expect(result).rejects.toThrow(error);
      }
    }),
  );
  expect(fixture.backend.writes).toEqual([]);
  expect(approvals.register).toHaveBeenCalledOnce();
});

it("refuses selected actor absence without discovery or approval", async () => {
  const fixture = await terminal("absent");
  const env = { OPENCLAW_STATE_DIR: temporary.make("terminal-absent-") };
  await withIncognitoSessionBinding({ kind: "absent", agentId: "main", env, authority }, () =>
    invoke(fixture, "owner", async (tool) => {
      await expect(
        tool.execute("input", { action: "input", sessionId: fixture.terminalId, data: "pwd\r" }),
      ).rejects.toThrow("Terminal session unavailable");
    }),
  );
  expect(fixture.backend.writes).toEqual([]);
  expect(approvals.register).not.toHaveBeenCalled();
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
});

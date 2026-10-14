import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
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
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
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
const authority = { assertCurrent() {}, authorize() {} };
let actor: ReturnType<typeof memorySessionActorOwners.get>;
const bindings: SessionActorStorageBinding[] = [];
let sql: ReturnType<typeof observeHostDataSql>;
const managers = new Set<TerminalSessionManager>();
beforeAll(async () => {
  const env = { OPENCLAW_STATE_DIR: temporary.make("terminal-tool-incognito-") };
  actor = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  });
});
afterAll(async () => {
  for (const binding of bindings) {
    await binding.actor.release();
  }
  memorySessionActorOwners.closeDatabase(actor);
});
beforeEach(() => {
  sql = observeHostDataSql();
  approvals.register.mockClear();
  approvals.decide.mockReset().mockResolvedValue("allow-once");
});
afterEach(() => {
  for (const manager of managers) {
    manager.disposeAll();
  }
  managers.clear();
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

async function terminal(name: string, permissionMode: "full" | "workspace" = "workspace") {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry = { sessionId: name, lifecycleRevision: "original", updatedAt: 1, permissionMode };
  const handle = await actor.acquire(
    { database: actor.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const binding = { actor: handle, authority, agentId: actor.agentId, path: actor.path };
  bindings.push(binding);
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
  const owner = agentTerminalOwner(sessionKey, entry.sessionId);
  const backend = makeFakePty();
  const manager = new TerminalSessionManager({ emit() {}, spawn: async () => backend });
  managers.add(manager);
  const opened = expectTerminalOpen(await manager.open(baseOpenRequest({ owner })));
  return {
    entry,
    binding,
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
    await runWithSessionActorStorage(fixture.binding, () =>
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
  { change: "session rebound", error: "execution policy changed" },
] as const)("refuses input after $change while approval is pending", async ({ change, error }) => {
  const fixture = await terminal(change.replaceAll(" ", "-"));
  const requested = createDeferredCore();
  const decision = createDeferredCore<string>();
  approvals.decide.mockImplementationOnce(() => {
    requested.resolve();
    return decision.promise;
  });
  await runWithSessionActorStorage(fixture.binding, () =>
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
  actor.closeSession(fixture.target.sessionKey);
  await runWithSessionActorStorage(fixture.binding, () =>
    invoke(fixture, "owner", async (tool) => {
      await expect(
        tool.execute("input", { action: "input", sessionId: fixture.terminalId, data: "pwd\r" }),
      ).rejects.toThrow("Terminal session unavailable");
    }),
  );
  expect(fixture.backend.writes).toEqual([]);
  expect(approvals.register).not.toHaveBeenCalled();
});

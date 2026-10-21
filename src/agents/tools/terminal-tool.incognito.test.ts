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
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
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
const actors: Array<Awaited<ReturnType<typeof actor.acquire>>> = [];
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
  for (const handle of actors) {
    await handle.release();
  }
  memorySessionActorOwners.closeDatabase(actor);
});
beforeEach(() => {
  sql = observeHostDataSql();
  approvals.register.mockClear();
  approvals.decide.mockReset().mockResolvedValue("allow-once");
});
afterEach(() => {
  managers.forEach((manager) => manager.disposeAll());
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
  actors.push(handle);
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
  const owner = agentTerminalOwner(sessionKey, entry.sessionId);
  const backend = makeFakePty();
  const manager = new TerminalSessionManager({ emit() {}, spawn: async () => backend });
  managers.add(manager);
  const { sessionId } = expectTerminalOpen(await manager.open(baseOpenRequest({ owner })));
  const invoke = <T>(
    route: "owner" | "bearer-mcp",
    consume: (
      input: (data?: string) => ReturnType<ReturnType<typeof createTerminalTool>["execute"]>,
    ) => Promise<T>,
  ) =>
    runWithSessionActorStorage(binding, async () => {
      const admission = prepareSystemAgentRunAdmission({}, entry.sessionId, "main", "terminal");
      try {
        const admittedRunContext = await admission.admit("embedded");
        const gateway = { terminalSessions: manager };
        bindGatewayContextResolver(admittedRunContext, () => gateway as GatewayRequestContext);
        const tool = createTerminalTool({
          agentId: "main",
          agentSessionKey: sessionKey,
          sessionId: entry.sessionId,
          ...(route === "owner" ? { getGatewayContext: () => gateway } : {}),
        });
        return await withGatewayToolCallerIdentity(
          createAdmittedGatewayToolCallerIdentity({
            admittedRunContext,
            agentId: "main",
            sessionKey,
            ...(route === "bearer-mcp" ? { receiptAuthority: () => true } : {}),
          }),
          () =>
            consume((data = "pwd\r") =>
              tool.execute("input", { action: "input", sessionId, data }),
            ),
        );
      } finally {
        admission.close();
      }
    });
  return { entry, backend, invoke, target: { agentId: "main", sessionKey, storePath: actor.path } };
}

it.each(["owner", "bearer-mcp"] as const)("reads %s actor policy", async (route) => {
  const fixture = await terminal(`input-${route}`, "full");
  await fixture.invoke(route, (input) =>
    expect(input()).resolves.toMatchObject({ details: { ok: true } }),
  );
  expect(fixture.backend.writes).toEqual(["pwd\r"]);
  expect(approvals.register).not.toHaveBeenCalled();
});

it.each(["permission revocation", "session rebound"])("rejects pending %s", async (change) => {
  const fixture = await terminal(change.replaceAll(" ", "-"));
  const requested = createDeferredCore();
  const decision = createDeferredCore<string>();
  approvals.decide.mockImplementationOnce(() => {
    requested.resolve();
    return decision.promise;
  });
  await fixture.invoke("bearer-mcp", async (input) => {
    const result = input("echo stale\r");
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
      await expect(result).rejects.toThrow("execution policy changed");
    }
  });
  expect(fixture.backend.writes).toEqual([]);
  expect(approvals.register).toHaveBeenCalledOnce();
});

it("refuses selected actor absence without discovery or approval", async () => {
  const fixture = await terminal("absent");
  actor.closeSession(fixture.target.sessionKey);
  await fixture.invoke("owner", (input) =>
    expect(input()).rejects.toThrow("Terminal session unavailable"),
  );
  expect(fixture.backend.writes).toEqual([]);
  expect(approvals.register).not.toHaveBeenCalled();
});

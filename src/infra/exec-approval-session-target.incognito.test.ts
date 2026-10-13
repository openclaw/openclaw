import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  doesApprovalRequestSelectChannelAccount,
  resolveApprovalRequestAccountId,
} from "./approval-request-account-binding.js";
import { resolveExecApprovalSessionTarget } from "./exec-approval-session-target.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Incognito approval routing opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Incognito approval routing allocated a worker");
  }),
}));
const authority = { assertCurrent() {}, authorize() {} };
afterEach(() => memorySessionActorOwners.reset());

function request(sessionKey: string): ExecApprovalRequest {
  return {
    id: sessionKey,
    request: { command: "echo synthetic", sessionKey },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}
function delivery(accountId: string): SessionEntry["delivery"] {
  return {
    kind: "external",
    context: { channel: "slack", accountId, to: "channel:C123" },
    origin: { provider: "slack", accountId, to: "channel:C123" },
    route: { channel: "slack", accountId, target: { to: "channel:C123", chatType: "channel" } },
  };
}
async function fixture() {
  const sessionKey = "agent:main:dashboard:incognito-approval-delivery";
  const path = resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: "/synthetic/approval" },
  });
  const owner = memorySessionActorOwners.get({ agentId: "main", path });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    {
      assertCurrent() {},
      assertReadable() {},
    },
  );
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId: "approval", updatedAt: 1, incognito: true, delivery: delivery("ops") },
      },
    },
    authority,
  );
  expect(created.kind).toBe("committed");
  return {
    owner,
    actor,
    sessionKey,
    binding: { actor, authority, agentId: "main", path },
    params: { cfg: { session: { store: path } }, request: request(sessionKey), channel: "slack" },
  };
}

it.each([true, false])("routes from committed memory delivery facts (bound=%s)", async (bound) => {
  const { actor, binding, params } = await fixture();
  const select = (accountId: string) =>
    doesApprovalRequestSelectChannelAccount({
      ...params,
      accountId,
      defaultAccountId: "default",
      eligibleAccountIds: ["default", "ops", "audit"],
    });
  const run = async () => {
    expect(select("ops")).toBe(true);
    expect(select("default")).toBe(false);
    expect(resolveExecApprovalSessionTarget(params)).toMatchObject({
      channel: "slack",
      accountId: "ops",
      to: "channel:C123",
    });
    const changed = await actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { delivery: delivery("audit") } } },
      },
      authority,
    );
    expect(changed.kind).toBe("committed");
    expect(select("ops")).toBe(false);
    expect(select("audit")).toBe(true);
    expect(resolveExecApprovalSessionTarget(params)?.accountId).toBe("audit");
    expect(
      resolveExecApprovalSessionTarget({
        ...params,
        request: request("agent:main:dashboard:incognito-missing"),
      }),
    ).toBeNull();
  };
  await (bound ? runWithSessionActorStorage(binding, run) : run());
});

it("refuses a retained session after close while unbound routing observes absence", async () => {
  const { owner, sessionKey, binding, params } = await fixture();
  owner.closeSession(sessionKey);
  expect(() =>
    runWithSessionActorStorage(binding, () => resolveApprovalRequestAccountId(params)),
  ).toThrow("closed");
  expect(() =>
    runWithSessionActorStorage(binding, () => resolveExecApprovalSessionTarget(params)),
  ).toThrow("closed");
  expect(resolveExecApprovalSessionTarget(params)).toBeNull();
});

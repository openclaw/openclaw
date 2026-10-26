/* @vitest-environment jsdom */

import { beforeEach, expect, it, vi } from "vitest";
import type { ApprovalHistoryResult } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ExecApprovalGrantsListResult,
  ExecApprovalStandingGrant,
} from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ApprovalsPage } from "./approvals-page.tsx";

const historyTable = ".approval-history-table";
const grantsTable = ".standing-grants-table";
const oldAutomation = "Old Gateway automation";
const currentAutomation = "Current Gateway automation";
const operatorHello = (scopes?: string[], recoveryScope?: string) =>
  ({ auth: { role: "operator", scopes, recoveryScope } }) as ApplicationGatewaySnapshot["hello"];
const grantReply = (name: string) => ({ grants: [standingGrant(name)] });
const emptyHistory = () => Promise.resolve({ items: [] });
const historyReply = (id: string, time: number, nextCursor?: string) => ({
  items: [terminal(id, time)],
  ...(nextCursor ? { nextCursor } : {}),
});

function expectButton(button: HTMLButtonElement, disabled: boolean, text: string) {
  expect(button.disabled).toBe(disabled);
  expect(button.textContent).toContain(text);
}

function replyOnce(...values: unknown[]) {
  const request = vi.fn();
  values.forEach((value) => request.mockResolvedValueOnce(value));
  return request;
}

const terminal = (id: string, resolvedAtMs: number): ApprovalHistoryResult["items"][number] => ({
  id,
  status: "denied",
  presentation: { kind: "exec", commandText: `echo ${id}`, allowedDecisions: ["deny"] },
  urlPath: `/approve/${id}`,
  createdAtMs: resolvedAtMs - 1_000,
  expiresAtMs: resolvedAtMs + 60_000,
  resolvedAtMs,
  decision: "deny",
  reason: "user",
  source: { agentId: "main", sessionKey: "agent:main:test" },
  resolver: { kind: "device", id: "reviewer-device" },
});

function createPage({
  history = emptyHistory,
  hello,
  grants = () => Promise.resolve({ grants: [] }),
  revoke,
}: {
  history?: (method: string, params?: unknown) => unknown;
  hello?: ApplicationGatewaySnapshot["hello"];
  grants?: () => unknown;
  revoke?: () => unknown;
} = {}) {
  const request = vi.fn((method: string, params?: unknown) =>
    method === "exec.approval.grants.list"
      ? grants()
      : method === "exec.approval.grants.revoke" && revoke
        ? revoke()
        : history(method, params),
  );
  const initial = createApplicationGateway({
    phase: "connected",
    client: createTestGatewayClient(request),
    ...(hello ? { hello } : {}),
  } as ApplicationGatewaySnapshot);
  let source = initial;
  const context = { basePath: "", gateway: source.gateway } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const { container: page } = mountSolid(() => <ApprovalsPage />, { wrapper: provider.wrapper });
  const updateGateway = (next: Partial<ApplicationGatewaySnapshot>) => {
    source.publish({ ...source.gateway.snapshot, ...next });
    flush();
  };
  const query = (selector: string) => page.querySelector<HTMLElement>(selector);
  const text = (selector: string) => query(selector)?.textContent;
  const waitText = (selector: string, value: string) =>
    waitForSolid(() => expect(text(selector)).toContain(value));
  flush();
  return {
    page,
    query,
    text,
    button: (selector = `${grantsTable} button`) => page.querySelector<HTMLButtonElement>(selector),
    waitText,
    request,
    updateGateway,
    replaceGateway(this: void, kind: "source" | "client" | "account" | "recovery scope") {
      if (kind === "source") {
        source = createApplicationGateway(source.gateway.snapshot);
        provider.setContext({ ...context, gateway: source.gateway });
      } else if (kind === "client") {
        updateGateway({ client: createTestGatewayClient(request) });
      } else if (kind === "account") {
        updateGateway({ selfUser: { id: "second" } });
      } else {
        updateGateway({ hello: operatorHello(undefined, "scope-second") });
      }
      flush();
    },
    resolveApproval(this: void, id = "refreshed") {
      initial.publishEvent({
        event: "exec.approval.resolved",
        payload: { id, decision: "deny" },
        type: "event",
      });
    },
  };
}

beforeEach(() => i18n.setLocale("en"));

const standingGrant = (name: string): ExecApprovalStandingGrant => ({
  grantId: "grant-1",
  mintedByApprovalId: "approval-1",
  agentId: "main",
  cronJobId: "job-1",
  cronJobName: name,
  command: "id -un",
  cwd: null,
  createdAtMs: 1_000,
  expiresAtMs: null,
  revokedAtMs: null,
  revokedBy: null,
  lastUsedAtMs: null,
  useCount: 3,
});

it("loads and revokes standing grants while approval history is unavailable", async () => {
  const history = createDeferred<ApprovalHistoryResult>();
  const p = createPage({
    history: () => history.promise,
    grants: () => Promise.resolve(grantReply("Independent automation")),
    revoke: () => Promise.resolve({ outcome: "revoked" }),
  });

  await p.waitText(grantsTable, "Independent automation");
  history.reject(new Error("History unavailable"));
  await p.waitText('[role="alert"]', "History unavailable");
  p.button()!.click();
  flush();
  await p.waitText(grantsTable, "Revoked");
  expect(p.request).toHaveBeenCalledWith("exec.approval.grants.revoke", { grantId: "grant-1" });
  expect(p.button()).toBeNull();
});

it("keeps history and grants through a blip without allowing offline actions", async () => {
  const refreshedHistory = createDeferred<ApprovalHistoryResult>();
  const p = createPage({
    history: replyOnce(historyReply("retained", 2_000, "next")).mockReturnValue(
      refreshedHistory.promise,
    ),
    hello: operatorHello(["operator.approvals"]),
    grants: () => Promise.resolve(grantReply("Retained automation")),
  });
  await p.waitText(grantsTable, "Retained automation");
  p.updateGateway({ phase: "reconnecting", hello: null });
  expect(p.text(historyTable)).toContain("echo retained");
  expect(p.text(grantsTable)).toContain("Retained automation");
  expect(p.button()?.disabled).toBe(true);
  expect(p.query(".data-table-pagination button")).toMatchObject({ disabled: true });
  p.updateGateway({ phase: "connected", hello: operatorHello(["operator.approvals"]) });
  expect(p.text(historyTable)).toContain("echo retained");
  refreshedHistory.resolve(historyReply("fresh", 3_000));
  await p.waitText(historyTable, "echo fresh");
  p.updateGateway({ client: createTestGatewayClient(p.request), phase: "reconnecting" });
  expect(p.page.textContent).not.toContain("echo fresh");
  expect(p.page.textContent).not.toContain("Retained automation");
});

it("does not claim an empty history when the load failed", async () => {
  const p = createPage({ history: vi.fn().mockRejectedValueOnce(new Error("boom")) });
  await p.waitText('[role="alert"]', "boom");
  expect(p.text(`${historyTable} tbody`) ?? "").not.toContain("No resolved approvals");
});

it.each(["failure", "resolved event"])("retains history during %s", async (outcome) => {
  const firstRead = createDeferred<ApprovalHistoryResult>();
  const moreRead = createDeferred<ApprovalHistoryResult>();
  const retryRead = createDeferred<ApprovalHistoryResult>();
  const request = replyOnce(firstRead.promise, moreRead.promise, retryRead.promise);
  const p = createPage({ history: request });
  await waitForSolid(() =>
    expect(p.query(".settings-loading-skeleton")?.getAttribute("aria-label")).toBe(
      "Loading approval history…",
    ),
  );
  firstRead.resolve(historyReply("retained", 2_000, "next"));
  await p.waitText(historyTable, "echo retained");
  const table = p.query(historyTable)!;
  const retainedRow = () =>
    [...table.querySelectorAll("tbody tr")].find((row) =>
      row.textContent?.includes("echo retained"),
    );
  const row = retainedRow();
  const more = p.button(".data-table-pagination button")!;
  const expectRow = (busy: string) => {
    expect(table.getAttribute("aria-busy")).toBe(busy);
    expect(retainedRow()).toBe(row);
  };
  more.click();
  more.click();
  flush();
  expect(request).toHaveBeenCalledTimes(2);
  expectRow("true");
  expectButton(more, true, "Loading");
  if (outcome === "failure") {
    moreRead.reject(new Error("History unavailable"));
    await waitForSolid(() => {
      expect(p.text('[role="alert"]')).toContain("History unavailable");
      expectRow("false");
      expect(more.disabled).toBe(false);
    });
    p.button('[role="alert"] button')!.click();
  } else {
    p.resolveApproval("newest");
    expect(request).toHaveBeenCalledTimes(2);
    moreRead.resolve(historyReply("older", 1_000));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
  }
  flush();
  expect(p.query('[role="alert"]')).toBeNull();
  retryRead.resolve({ items: [terminal("newest", 3_000), terminal("retained", 2_000)] });
  await p.waitText(historyTable, "echo newest");
  await waitForSolid(() => expectRow("false"));
  expect(table.querySelector("tbody tr")?.textContent).toContain("echo newest");
  expect(p.query(historyTable)).toBe(table);
});

it("keeps a failed initial grants read unknown until an accepted refresh", async () => {
  const refreshedGrants = createDeferred<ExecApprovalGrantsListResult>();
  const grants = vi
    .fn()
    .mockRejectedValueOnce(new Error("Ledger unavailable"))
    .mockReturnValue(refreshedGrants.promise);
  const p = createPage({ grants });
  await p.waitText('[role="alert"]', "Ledger unavailable");
  const table = p.query(grantsTable);
  expect(p.text(grantsTable)).toContain("Unknown");
  expect(p.text(grantsTable)).not.toContain("No standing grants");
  expect(p.query('[role="alert"] button')).toBeNull();
  p.resolveApproval();
  refreshedGrants.resolve({ grants: [] });
  await p.waitText(grantsTable, "No standing grants");
  expect(p.query('[role="alert"]')).toBeNull();
  expect(p.query(grantsTable)).toBe(table);
});

it("discards stale history when approval access changes on the same gateway", async () => {
  const staleHistory = createDeferred<ApprovalHistoryResult>();
  const request = replyOnce(staleHistory.promise, historyReply("current", 2_000));
  const p = createPage({ history: request, hello: operatorHello(["operator.read"]) });
  expect(request).not.toHaveBeenCalled();
  expect(p.query(historyTable)).toBeNull();
  expect(p.text('[role="status"]')).toContain("operator.approvals");
  p.updateGateway({ hello: operatorHello(["operator.approvals"]) });
  expect(request).toHaveBeenCalledOnce();

  p.updateGateway({ hello: operatorHello(["operator.read"]) });
  p.resolveApproval("inaccessible");
  flush();
  expect(request).toHaveBeenCalledOnce();
  expect(p.query(historyTable)).toBeNull();
  p.updateGateway({ hello: operatorHello(["operator.admin"]) });
  await p.waitText(historyTable, "echo current");

  staleHistory.resolve(historyReply("stale", 1_000));
  await staleHistory.promise;
  flush();
  expect(p.text(historyTable)).toContain("echo current");
  expect(p.text(historyTable)).not.toContain("echo stale");
});

it.each([
  { replacement: "source", outcome: "resolve" },
  { replacement: "client", outcome: "reject" },
  { replacement: "account", outcome: "resolve" },
  { replacement: "recovery scope", outcome: "reject" },
] as const)(
  "clears a replaced $replacement ledger and ignores its late revoke $outcome",
  async ({ replacement, outcome }) => {
    const oldRevoke = createDeferred<{ outcome: string }>();
    const currentRevoke = createDeferred<{ outcome: string }>();
    const nextGrants = createDeferred<ExecApprovalGrantsListResult>();
    const revoke = replyOnce(oldRevoke.promise).mockReturnValue(currentRevoke.promise);
    const p = createPage({
      hello: operatorHello(undefined, "scope-first"),
      grants: replyOnce(grantReply(oldAutomation)).mockReturnValue(nextGrants.promise),
      revoke,
    });
    p.updateGateway({ selfUser: { id: "first" } });
    await p.waitText(grantsTable, oldAutomation);
    p.button()!.click();
    flush();
    p.replaceGateway(replacement);
    expect(p.text(grantsTable)).not.toContain(oldAutomation);
    expect(p.button()).toBeNull();
    nextGrants.resolve(grantReply(currentAutomation));
    await p.waitText(grantsTable, currentAutomation);
    const currentButton = p.button()!;
    expect(currentButton.disabled).toBe(false);
    currentButton.click();
    flush();
    expectButton(currentButton, true, "Revoking");
    if (outcome === "resolve") {
      oldRevoke.resolve({ outcome: "revoked" });
    } else {
      oldRevoke.reject(new Error("Old Gateway revoke failed"));
    }
    await Promise.allSettled([oldRevoke.promise]);
    flush();
    expect(p.text(grantsTable)).toContain("Until revoked");
    expect(p.page.textContent).not.toContain("Old Gateway revoke failed");
    expectButton(currentButton, true, "Revoking");
    currentRevoke.resolve({ outcome: "revoked" });
    await p.waitText(grantsTable, "Revoked");
    expect(p.button()).toBeNull();
  },
);

it("retries a failed revoke without losing the row or accepting a stale ledger refresh", async () => {
  const pendingRefresh = createDeferred<ExecApprovalGrantsListResult>();
  const grant = grantReply("Nightly backup");
  const grants = replyOnce(grant).mockReturnValue(pendingRefresh.promise);
  const failedRevoke = createDeferred<unknown>();
  const retryRevoke = createDeferred<unknown>();
  const revoke = replyOnce(failedRevoke.promise, retryRevoke.promise);
  const p = createPage({ grants, revoke });
  await p.waitText(grantsTable, "Nightly backup");
  const button = p.button()!;
  const row = button.closest("tr");
  expect(p.text(grantsTable)).toContain("id -un");
  expect(button.getAttribute("aria-label")).toBe("Revoke: Nightly backup — id -un");
  p.resolveApproval("another-approval");
  await waitForSolid(() => expect(grants).toHaveBeenCalledTimes(2));
  button.click();
  button.click();
  flush();
  expect(revoke).toHaveBeenCalledOnce();
  expectButton(button, true, "Revoking");
  failedRevoke.reject(new Error("Revoke failed"));
  await waitForSolid(() => {
    expect(p.text('[role="alert"]')).toContain("Revoke failed");
    expect(button.disabled).toBe(false);
    expect(button.textContent?.trim()).toBe("Revoke");
  });
  expect(p.button()?.closest("tr")).toBe(row);
  button.click();
  flush();
  retryRevoke.resolve({ outcome: "revoked" });
  await p.waitText(grantsTable, "Revoked");
  expect(p.request).toHaveBeenCalledWith("exec.approval.grants.revoke", { grantId: "grant-1" });
  pendingRefresh.resolve(grant);
  await pendingRefresh.promise;
  flush();
  expect(p.text(grantsTable)).toContain("Revoked");
  expect(p.button()).toBeNull();
});

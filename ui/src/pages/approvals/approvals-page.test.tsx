/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalHistoryResult } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ExecApprovalGrantsListResult,
  ExecApprovalStandingGrant,
} from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
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

const historyText = (page: HTMLElement) =>
  page.querySelector(".approval-history-table")?.textContent;
const grantsText = (page: HTMLElement) => page.querySelector(".standing-grants-table")?.textContent;
const grantButton = (page: HTMLElement) =>
  page.querySelector<HTMLButtonElement>(".standing-grants-table button");
const waitForHistory = (page: HTMLElement, text: string) =>
  waitForSolid(() => expect(historyText(page)).toContain(text));
const waitForGrants = (page: HTMLElement, text: string) =>
  waitForSolid(() => expect(grantsText(page)).toContain(text));
const oldAutomation = "Old Gateway automation";
const currentAutomation = "Current Gateway automation";
function operatorAuth(scopes?: string[], recoveryScope?: string) {
  return { role: "operator", scopes, recoveryScope };
}
const grantReply = (name: string) => ({ grants: [standingGrant(name)] });

function replyOnce(...values: unknown[]) {
  const request = vi.fn();
  for (const value of values) {
    request.mockResolvedValueOnce(value);
  }
  return request;
}

function terminal(id: string, resolvedAtMs: number): ApprovalHistoryResult["items"][number] {
  return {
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
  };
}

function createPage(
  history: (method: string, params?: unknown) => unknown,
  auth?: { role: string; scopes?: string[]; recoveryScope?: string },
  grants: () => unknown = () => Promise.resolve({ grants: [] }),
) {
  const request = vi.fn((method: string, params?: unknown) =>
    method === "exec.approval.grants.list" ? grants() : history(method, params),
  );
  const client = createTestGatewayClient(request);
  const initialGateway = createApplicationGateway({
    phase: "connected",
    client,
    ...(auth ? { hello: { auth } } : {}),
  } as ApplicationGatewaySnapshot);
  let currentGateway = initialGateway;
  const context = {
    basePath: "",
    gateway: currentGateway.gateway,
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const { container: page } = mountSolid(() => <ApprovalsPage />, { wrapper: provider.wrapper });
  const updateGateway = (next: Partial<ApplicationGatewaySnapshot>) => {
    currentGateway.publish({ ...currentGateway.gateway.snapshot, ...next });
  };
  flush();
  return {
    page,
    request,
    updateGateway,
    replaceGateway(this: void, kind: "source" | "client" | "account" | "recovery scope") {
      if (kind === "source") {
        currentGateway = createApplicationGateway(currentGateway.gateway.snapshot);
        provider.setContext({ ...context, gateway: currentGateway.gateway });
      } else if (kind === "client") {
        updateGateway({ client: createTestGatewayClient(request) });
      } else if (kind === "account") {
        updateGateway({ selfUser: { id: "second" } });
      } else {
        updateGateway({ hello: operatorHello(undefined, "scope-second") });
      }
      flush();
    },
    emitGatewayEvent(this: void, event: string, payload: unknown) {
      initialGateway.publishEvent({ event, payload, type: "event" } as GatewayEventFrame);
    },
  };
}

beforeEach(() => i18n.setLocale("en"));

function operatorHello(
  scopes?: string[],
  recoveryScope?: string,
): ApplicationGatewaySnapshot["hello"] {
  return {
    auth: operatorAuth(scopes, recoveryScope),
  } as ApplicationGatewaySnapshot["hello"];
}

function standingGrant(name: string): ExecApprovalStandingGrant {
  return {
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
  };
}

describe("ApprovalsPage", () => {
  it("keeps history and grants through a blip without allowing offline actions", async () => {
    const refreshedHistory = createDeferred<ApprovalHistoryResult>();
    const { page, updateGateway, request } = createPage(
      replyOnce({ items: [terminal("retained", 2_000)], nextCursor: "next" }).mockReturnValue(
        refreshedHistory.promise,
      ),
      operatorAuth(["operator.approvals"]),
      () => Promise.resolve(grantReply("Retained automation")),
    );
    await waitForGrants(page, "Retained automation");

    updateGateway({ phase: "reconnecting", hello: null });
    flush();
    expect(historyText(page)).toContain("echo retained");
    expect(grantsText(page)).toContain("Retained automation");
    expect(grantButton(page)?.disabled).toBe(true);
    expect(page.querySelector(".data-table-pagination button")).toMatchObject({ disabled: true });

    updateGateway({ phase: "connected", hello: operatorHello(["operator.approvals"]) });
    flush();
    expect(historyText(page)).toContain("echo retained");
    refreshedHistory.resolve({ items: [terminal("fresh", 3_000)] });
    await waitForHistory(page, "echo fresh");

    updateGateway({
      client: createTestGatewayClient(request),
      phase: "reconnecting",
    });
    flush();
    expect(page.textContent).not.toContain("echo fresh");
    expect(page.textContent).not.toContain("Retained automation");
  });

  it("does not claim an empty history when the load failed", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const { page } = createPage(request);

    await waitForSolid(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("boom"),
    );

    const body = page.querySelector(".approval-history-table tbody")?.textContent ?? "";
    expect(body).not.toContain("No resolved approvals");
  });

  it("refreshes the newest history after an approval resolves during pagination", async () => {
    const olderPage = createDeferred<ApprovalHistoryResult>();
    const request = replyOnce(
      { items: [terminal("first", 2_000)], nextCursor: "next" },
      olderPage.promise,
      { items: [terminal("newest", 3_000), terminal("first", 2_000)] },
    );
    const { page, emitGatewayEvent } = createPage(request);

    await waitForHistory(page, "echo first");
    const loadMore = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Load more"),
    );
    loadMore?.click();
    flush();
    expect(request).toHaveBeenCalledTimes(2);

    emitGatewayEvent("exec.approval.resolved", { id: "newest", decision: "deny" });
    expect(request).toHaveBeenCalledTimes(2);

    olderPage.resolve({ items: [terminal("older", 1_000)] });
    await waitForHistory(page, "echo newest");

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("approval.history", { limit: 50 });
  });

  it.each([
    { name: "read-only", scopes: ["operator.read"], allowed: false },
    { name: "legacy", scopes: undefined, allowed: true },
  ])("gates history for a $name operator", async ({ scopes, allowed }) => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const { page } = createPage(request, operatorAuth(scopes));
    await waitForSolid(() =>
      expect(page.querySelector(".approval-history-table") !== null).toBe(allowed),
    );
    expect(request.mock.calls).toEqual(allowed ? [["approval.history", { limit: 50 }]] : []);
    if (!allowed) {
      expect(page.querySelector('[role="status"]')?.textContent).toContain("operator.approvals");
    }
  });

  it("discards stale history when approval access changes on the same gateway", async () => {
    const staleHistory = createDeferred<ApprovalHistoryResult>();
    const request = replyOnce(staleHistory.promise, { items: [terminal("current", 2_000)] });
    const { page, emitGatewayEvent, updateGateway } = createPage(
      request,
      operatorAuth(["operator.approvals"]),
    );
    expect(request).toHaveBeenCalledOnce();

    updateGateway({ hello: operatorHello(["operator.read"]) });
    flush();
    emitGatewayEvent("exec.approval.resolved", { id: "inaccessible", decision: "deny" });
    flush();
    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector(".approval-history-table")).toBeNull();

    updateGateway({ hello: operatorHello(["operator.admin"]) });
    await waitForHistory(page, "echo current");
    expect(request).toHaveBeenCalledTimes(2);

    staleHistory.resolve({ items: [terminal("stale", 1_000)] });
    await staleHistory.promise;
    flush();
    expect(historyText(page)).toContain("echo current");
    expect(historyText(page)).not.toContain("echo stale");
  });

  it.each(["client", "source", "account", "recovery scope"] as const)(
    "clears standing grants while a replacement %s loads its ledger",
    async (replacement) => {
      const nextGrants = createDeferred<ExecApprovalGrantsListResult>();
      const { page, updateGateway, replaceGateway } = createPage(
        () => Promise.resolve({ items: [] }),
        operatorAuth(undefined, "scope-first"),
        replyOnce(grantReply(oldAutomation)).mockReturnValue(nextGrants.promise),
      );
      updateGateway({ selfUser: { id: "first" } });
      await waitForGrants(page, oldAutomation);
      replaceGateway(replacement);
      expect(grantsText(page)).not.toContain(oldAutomation);
      expect(grantButton(page)).toBeNull();

      nextGrants.resolve(grantReply(currentAutomation));
      await waitForGrants(page, currentAutomation);
    },
  );

  it.each([
    { replacement: "source", outcome: "resolve" },
    { replacement: "client", outcome: "reject" },
  ] as const)(
    "retires a previous $replacement revoke that later $outcome without settling the current revoke",
    async ({ replacement, outcome }) => {
      const oldRevoke = createDeferred<{ outcome: string }>();
      const currentRevoke = createDeferred<{ outcome: string }>();
      const revoke = replyOnce(oldRevoke.promise).mockReturnValue(currentRevoke.promise);
      const { page, replaceGateway } = createPage(
        (method) =>
          method === "exec.approval.grants.revoke" ? revoke() : Promise.resolve({ items: [] }),
        undefined,
        replyOnce(grantReply(oldAutomation)).mockResolvedValue(grantReply(currentAutomation)),
      );
      await waitForSolid(() => expect(grantButton(page)).not.toBeNull());
      grantButton(page)!.click();
      flush();

      replaceGateway(replacement);
      await waitForGrants(page, currentAutomation);
      const currentButton = grantButton(page)!;
      expect(currentButton.disabled).toBe(false);
      currentButton.click();
      flush();
      expect(currentButton.disabled).toBe(true);
      expect(currentButton.textContent).toContain("Revoking");

      if (outcome === "resolve") {
        oldRevoke.resolve({ outcome: "revoked" });
      } else {
        oldRevoke.reject(new Error("Old Gateway revoke failed"));
      }
      await Promise.allSettled([oldRevoke.promise]);
      flush();
      expect(grantsText(page)).toContain("Until revoked");
      expect(page.textContent).not.toContain("Old Gateway revoke failed");
      expect(currentButton.disabled).toBe(true);
      expect(currentButton.textContent).toContain("Revoking");

      currentRevoke.resolve({ outcome: "revoked" });
      await waitForGrants(page, "Revoked");
      expect(grantButton(page)).toBeNull();
    },
  );

  it("renders the standing-grant ledger and revokes through the gateway", async () => {
    const pendingRefresh = createDeferred<ExecApprovalGrantsListResult>();
    const grant = standingGrant("Nightly backup");
    const grants = replyOnce({ grants: [grant] }).mockReturnValue(pendingRefresh.promise);
    const { page, emitGatewayEvent, request } = createPage(
      (method, params) =>
        method === "exec.approval.grants.revoke"
          ? Promise.resolve({ outcome: "revoked", params })
          : Promise.resolve({ items: [] }),
      undefined,
      grants,
    );

    await waitForGrants(page, "Nightly backup");

    const ledger = page.querySelector(".standing-grants-table");
    expect(ledger?.textContent).toContain("id -un");
    expect(ledger?.textContent).toContain("Until revoked");

    emitGatewayEvent("exec.approval.resolved", { id: "another-approval", decision: "deny" });
    await waitForSolid(() => expect(grants).toHaveBeenCalledTimes(2));

    const revoke = [...page.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Revoke"),
    );
    expect(revoke?.getAttribute("aria-label")).toBe("Revoke: Nightly backup — id -un");
    expect(ledger?.querySelector("th:last-child")?.textContent?.trim()).toBe("Revoke");
    revoke?.click();
    await waitForGrants(page, "Revoked");

    expect(request).toHaveBeenCalledWith("exec.approval.grants.revoke", { grantId: "grant-1" });

    pendingRefresh.resolve({ grants: [grant] });
    await pendingRefresh.promise;
    flush();
    expect(grantsText(page)).toContain("Revoked");
    expect(grantButton(page)).toBeNull();
  });
});

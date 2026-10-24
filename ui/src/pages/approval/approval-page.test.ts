/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AllowedApprovalSnapshot,
  ApprovalGetResult,
  ApprovalResolveResult,
  ExpiredApprovalSnapshot,
  PendingApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "./approval-page.tsx";

type TestApprovalPage = HTMLElement & {
  approvalId: string;
  updateComplete: Promise<boolean>;
};

function pendingApproval(
  overrides: Partial<PendingApprovalSnapshot> = {},
): PendingApprovalSnapshot {
  return {
    id: "exec:approval-1",
    urlPath: "/approve/exec%3Aapproval-1",
    status: "pending",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    presentation: {
      kind: "exec",
      commandText: "printf safe",
      commandPreview: "printf …",
      warningText: null,
      host: "gateway",
      nodeId: "runner-1",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
    ...overrides,
  } as PendingApprovalSnapshot;
}

function allowedApproval(): AllowedApprovalSnapshot {
  return {
    ...pendingApproval(),
    status: "allowed",
    decision: "allow-once",
    reason: "user",
    resolvedAtMs: 2_000,
  } as AllowedApprovalSnapshot;
}

function expiredApproval(): ExpiredApprovalSnapshot {
  return {
    ...pendingApproval(),
    status: "expired",
    reason: "timeout",
    resolvedAtMs: 2_000,
  } as ExpiredApprovalSnapshot;
}

function watcherApproval(operation: "add" | "update"): PendingApprovalSnapshot {
  const approval = pendingApproval();
  if (approval.presentation.kind !== "exec") {
    throw new Error("Expected the exec fixture");
  }
  return {
    ...approval,
    presentation: {
      ...approval.presentation,
      streamProposal: { jobId: "watcher/alpha", name: "Build monitor", operation },
    },
  };
}

function pluginApproval(): PendingApprovalSnapshot {
  return pendingApproval({
    id: "plugin:approval-1",
    urlPath: "/approve/plugin%3Aapproval-1",
    presentation: {
      kind: "plugin",
      title: "Claude native tool: Bash",
      description: '{"command":"printf …"}',
      detail: '{"command":"printf \\"line one\\nline two\\""}',
      severity: "warning",
      pluginId: "claude-cli",
      toolName: "Bash",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  });
}

const get = (approval: ApprovalGetResult["approval"] = pendingApproval()): ApprovalGetResult => ({
  approval,
});
const allowed = (): ApprovalResolveResult => ({ applied: true, approval: allowedApproval() });
const lookupRequest = (approval = pendingApproval()) => vi.fn(async () => get(approval));
function decisionRequest(
  result: ApprovalResolveResult | Promise<ApprovalResolveResult>,
  pending = pendingApproval(),
) {
  return vi.fn((method: string) =>
    Promise.resolve(method === "approval.get" ? get(pending) : result),
  );
}

async function createPage(
  request: GatewayRequestHandler,
  params: {
    client?: GatewayBrowserClient;
    hello?: ApplicationGatewaySnapshot["hello"];
    id?: string;
  } = {},
) {
  const { gateway, publish } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: params.client ?? ({ request } as GatewayBrowserClient),
      phase: "connected",
      hello:
        params.hello === undefined
          ? ({ auth: { role: "operator" } } as ApplicationGatewaySnapshot["hello"])
          : params.hello,
      assistantAgentId: "main",
      sessionKey: "main",
    }),
  );
  const source = {
    update(patch: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...patch });
    },
  };

  const page = document.createElement("openclaw-approval-page") as TestApprovalPage;
  const provider = createApplicationContextProvider({
    basePath: "",
    gateway,
  } as unknown as ApplicationContext);
  page.approvalId = params.id ?? "exec:approval-1";
  provider.append(page);
  document.body.append(provider);
  await settle(page);
  return { page, source };
}

function operator(scopes: string[]): ApplicationGatewaySnapshot["hello"] {
  return { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"];
}

function decision(page: TestApprovalPage, value = "allow-once") {
  return page.querySelector<HTMLButtonElement>(`[data-decision="${value}"]`)!;
}

function text(page: TestApprovalPage, selector: string) {
  return page.querySelector(selector)?.textContent;
}

function busy(page: TestApprovalPage) {
  return page.querySelector(".approval-page__card")?.getAttribute("aria-busy");
}

function refresh(visibility = visibilityState) {
  visibilityState = visibility;
  document.dispatchEvent(new Event("visibilitychange"));
}

function resolveCalls(request: ReturnType<typeof decisionRequest>) {
  return request.mock.calls.filter(([method]) => method === "approval.resolve");
}

function expectRedacted(page: TestApprovalPage, state: string) {
  expect(page.querySelector(".approval-page")?.getAttribute("data-state")).toBe(state);
  expect(page.querySelector(".approval-page__preview")).toBeNull();
  expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
}

function expectReviewOnly(page: TestApprovalPage) {
  expect(text(page, ".approval-page__preview")).toBe("printf safe");
  expect(decision(page).disabled).toBe(true);
  expect(text(page, ".approval-page__heading p")?.trim()).toBe(
    "Review only. Sign in with approval access to record a decision.",
  );
}

async function settle(page: TestApprovalPage) {
  await Promise.resolve();
  await Promise.resolve();
  await page.updateComplete;
}

let visibilityState: DocumentVisibilityState;

beforeEach(async () => {
  await i18n.setLocale("en");
  visibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

describe("ApprovalPage", () => {
  it("retires old decisions immediately and looks up only the final native ID", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "approval.get" || !isRecord(params) || typeof params.id !== "string") {
        throw new Error("Expected an approval lookup");
      }
      return { approval: pendingApproval({ id: params.id }) } satisfies ApprovalGetResult;
    });
    const { page } = await createPage(request, { client: createTestGatewayClient(request) });
    await waitForSolid(() => expect(decision(page)).not.toBeNull());
    const oldDecision = decision(page);
    page.approvalId = "exec:approval-2";
    page.approvalId = "exec:approval-3";
    oldDecision.click();
    await settle(page);
    await waitForSolid(() => expect(decision(page)).not.toBeNull());
    expect(request.mock.calls).toEqual([
      ["approval.get", { id: "exec:approval-1" }],
      ["approval.get", { id: "exec:approval-3" }],
    ]);
  });

  it.each(["success", "failure"] as const)(
    "shows a held decision once and settles its %s feedback",
    async (outcome) => {
      const held = Promise.withResolvers<ApprovalResolveResult>();
      const request = decisionRequest(held.promise);
      const { page } = await createPage(request);
      decision(page).click();
      decision(page, "deny").click();
      expect(resolveCalls(request)).toHaveLength(1);
      await waitForSolid(() => {
        expect(decision(page).disabled).toBe(true);
        expect(decision(page).textContent).toContain("Recording");
        expect(busy(page)).toBe("true");
      });
      if (outcome === "success") {
        held.resolve(allowed());
        await waitForSolid(() => expect(text(page, "h1")).toBe("Approved here"));
      } else {
        held.reject(new Error("Synthetic resolution failure"));
        await waitForSolid(() => {
          expect(page.querySelector('[role="alert"]')).not.toBeNull();
          expect(decision(page).textContent).not.toContain("Recording");
        });
      }
      expect(busy(page)).toBe("false");
    },
  );

  it.each(["id", "connection"] as const)(
    "retires a held decision when its %s changes",
    async (change) => {
      const held = Promise.withResolvers<ApprovalResolveResult>();
      let current = pendingApproval();
      const request = vi.fn((method: string): Promise<unknown> =>
        method === "approval.get" ? Promise.resolve(get(current)) : held.promise,
      );
      const { page, source } = await createPage(request);
      decision(page).click();
      await waitForSolid(() => expect(decision(page).textContent).toContain("Recording"));
      const next = pendingApproval({
        id: change === "id" ? "exec:approval-2" : current.id,
      });
      if (next.presentation.kind !== "exec") {
        throw new Error("Expected the exec fixture");
      }
      next.presentation.commandText = "printf replacement";
      current = next;
      if (change === "id") {
        page.approvalId = next.id;
      } else {
        source.update({ phase: "stopped" });
        source.update({ phase: "connected" });
      }
      await waitForSolid(() => {
        expect(text(page, ".approval-page__preview")).toBe("printf replacement");
        expect(decision(page).disabled).toBe(false);
        expect(decision(page).textContent).not.toContain("Recording");
      });
      held.resolve(allowed());
      await settle(page);
      expect(text(page, ".approval-page__preview")).toBe("printf replacement");
      expect(decision(page).disabled).toBe(false);
      expect(text(page, "h1")).not.toBe("Approved here");
    },
  );

  it.each([
    {
      kind: "exec",
      scope: {
        kind: "standing-grant",
        automation: "Nightly workspace check",
        command: "printf safe",
        expiresInDays: 14,
      },
      expected:
        'Always allow runs this exact command for "Nightly workspace check" without asking, for 14 days (revocable)',
    },
    {
      kind: "plugin",
      scope: { kind: "payment", amount: "12.34", currency: "USD", target: "Synthetic vendor" },
      expected: "Pays 12.34 USD to Synthetic vendor",
    },
  ] as const)("shows the supplied $kind approval scope before a decision", async (scenario) => {
    const pending = scenario.kind === "exec" ? pendingApproval() : pluginApproval();
    if (pending.presentation.kind === "system-agent") {
      throw new Error("Expected an exec or plugin approval");
    }
    pending.presentation.scope = scenario.scope;
    const request = lookupRequest(pending);
    const { page } = await createPage(request, { id: pending.id });
    expect(page.textContent).toContain(scenario.expected);
    expect(page.textContent).toContain("Waiting for your decision");
  });

  it.each([
    ["add", "Start watching"],
    ["update", "Save watcher change"],
  ] as const)(
    "explains a watcher %s before recording its exact decision",
    async (operation, label) => {
      const pending = watcherApproval(operation);
      const request = decisionRequest(
        {
          applied: true,
          approval: { ...allowedApproval(), presentation: pending.presentation },
        },
        pending,
      );
      const { page } = await createPage(request);
      await settle(page);
      expect(page.querySelector("h1")?.textContent).toContain("Build monitor");
      expect(page.textContent).toContain("after you leave this chat, until stopped");
      expect(page.textContent).toContain("restart automatically");
      expect(page.querySelector('[data-decision="deny"]')?.textContent?.trim()).toBe("Cancel");
      const allowButton = decision(page);
      expect(allowButton.textContent?.trim()).toBe(label);
      allowButton.click();
      await waitForSolid(() => expect(text(page, "h1")).toBe("Approved here"));

      expect(request).toHaveBeenCalledWith("approval.resolve", {
        id: pending.id,
        kind: "exec",
        decision: "allow-once",
      });
      expect(page.querySelector(".approval-page__heading p")?.textContent).toContain(
        "Approval alone does not confirm that the change was saved or the watcher started",
      );
    },
  );

  it("reloads a denied watcher change without claiming that the existing watcher stopped", async () => {
    const pending = watcherApproval("update");
    const request = vi.fn(async () => ({
      approval: {
        ...pending,
        status: "denied",
        decision: "deny",
        reason: "user",
        resolvedAtMs: 2_000,
        resolver: { kind: "device", id: "reviewer-device" },
      },
    }));
    const { page } = await createPage(request);
    await settle(page);
    expect(page.querySelector(".approval-page__heading p")?.textContent).toContain(
      "It did not stop or change the existing watcher",
    );
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps a no-auth approval readable without enabling its decisions", async () => {
    const request = lookupRequest();
    const { page } = await createPage(request, { hello: null });
    const button = decision(page);
    expect(request).toHaveBeenCalledWith("approval.get", { id: "exec:approval-1" });
    expectReviewOnly(page);
    button.click();
    await settle(page);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "approval.resolve")).toBe(false);
  });

  it("does not request or disclose a durable approval to an explicitly ungranted operator", async () => {
    const request = lookupRequest();
    const { page } = await createPage(request, { hello: operator([]) });
    expect(request).not.toHaveBeenCalled();
    expectRedacted(page, "missing-scope");
    expect(text(page, '[role="alert"]')).toContain("operator.approvals");
  });

  it("rejects an in-flight resolution when only the approval grant is revoked", async () => {
    const held = Promise.withResolvers<ApprovalResolveResult>();
    const request = decisionRequest(held.promise);
    const { page, source } = await createPage(request, { hello: operator(["operator.approvals"]) });
    decision(page).click();
    await page.updateComplete;
    source.update({ hello: null });
    await settle(page);
    expectReviewOnly(page);
    held.resolve(allowed());
    await settle(page);
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
    expect(text(page, "h1")).not.toBe("Approved here");
    expect(resolveCalls(request)).toHaveLength(1);
  });

  it.each([false, true])(
    "redacts revoked details and rejects retained actions (disconnect=%s)",
    async (disconnect) => {
      const request = lookupRequest();
      const { page, source } = await createPage(request, {
        hello: operator(["operator.approvals"]),
      });
      const staleDecision = decision(page);
      expect(text(page, ".approval-page__preview")).toBe("printf safe");
      source.update(
        disconnect
          ? { phase: "stopped", client: null, hello: operator(["operator.read"]) }
          : { hello: operator(["operator.read"]) },
      );
      staleDecision.click();
      await settle(page);
      expect(request).toHaveBeenCalledOnce();
      expectRedacted(page, disconnect ? "connection-error" : "missing-scope");
      expect(page.textContent).not.toContain("printf safe");
      expect(request.mock.calls.some(([method]) => method === "approval.resolve")).toBe(false);
    },
  );

  it.each(["access", "connection"])(
    "rejects stale lookups after %s is restored",
    async (change) => {
      const stale = Promise.withResolvers<ApprovalGetResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValueOnce(get(allowedApproval()));
      const { page, source } = await createPage(request, {
        hello: operator(["operator.approvals"]),
      });
      if (change === "access") {
        source.update({ hello: operator(["operator.read"]) });
        source.update({ hello: operator(["operator.approvals"]) });
      } else {
        source.update({ phase: "reconnecting" });
        source.update({ phase: "connected" });
      }
      await settle(page);
      await waitForSolid(() => expect(text(page, "h1")).toBe("Approved"));
      stale.resolve(get());
      await settle(page);
      expect(request).toHaveBeenCalledTimes(2);
      expect(text(page, "h1")).toBe("Approved");
      expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
    },
  );

  it("formats approval times with the selected Control UI locale", async () => {
    await i18n.setLocale("de");
    const approval = pendingApproval();
    const { page } = await createPage(lookupRequest(approval));
    const expected = new Intl.DateTimeFormat("de", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(approval.expiresAtMs));
    expect(text(page, "time")?.trim()).toBe(expected);
  });

  it.each([false, true])(
    "renders a fail-closed timeout distinctly from another surface's decision (watcher=%s)",
    async (watcher) => {
      const pending = watcher ? watcherApproval("add") : pendingApproval();
      const expired = { ...expiredApproval(), presentation: pending.presentation };
      const request = decisionRequest({ applied: false, approval: expired }, pending);
      const { page } = await createPage(request);
      await settle(page);
      decision(page).click();
      await settle(page);

      await waitForSolid(() => expect(text(page, "h1")).toBe("Expired"));
      expect(page.textContent).toContain(
        watcher
          ? "This proposal did not create a watcher"
          : "No decision arrived before the deadline",
      );
      expect(page.textContent).not.toContain("Another surface or an earlier attempt");
    },
  );

  it("retains approval context and busy retry feedback during a foreground refresh", async () => {
    const retry = Promise.withResolvers<ApprovalGetResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(get())
      .mockRejectedValueOnce(new Error("temporary Gateway failure"))
      .mockReturnValueOnce(retry.promise);
    const { page } = await createPage(request);
    refresh();
    await waitForSolid(() => expect(page.querySelector(".approval-page__callout")).not.toBeNull());
    const button = page.querySelector<HTMLButtonElement>(".approval-page__callout button")!;
    button.click();
    await waitForSolid(() => {
      expect(busy(page)).toBe("true");
      expect(button.disabled).toBe(true);
      expect(text(page, ".approval-page__preview")).toBe("printf safe");
      expect(decision(page).disabled).toBe(true);
    });
    retry.resolve(get());
    await waitForSolid(() => {
      expect(busy(page)).toBe("false");
      expect(page.querySelector(".approval-page__callout")).toBeNull();
      expect(decision(page).disabled).toBe(false);
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("polls only while the pending document is visible", async () => {
    vi.useFakeTimers();
    const request = lookupRequest();
    const { page } = await createPage(request);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);
    refresh("hidden");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request).toHaveBeenCalledTimes(2);
    refresh("visible");
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps one approval.get in flight across repeated visibility refreshes", async () => {
    const held = Promise.withResolvers<ApprovalGetResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(get())
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(get());
    const { page } = await createPage(request);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      refresh("hidden");
      refresh("visible");
    }
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);
    held.resolve(get());
    await settle(page);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
  });

  it.each(["id", "client"])("drops the queued follow-up when the %s changes", async (change) => {
    const held = Promise.withResolvers<ApprovalGetResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(get())
      .mockReturnValueOnce(held.promise)
      .mockImplementation(async (_method: string, params: unknown) => {
        if (!isRecord(params) || typeof params.id !== "string") {
          throw new Error("Expected an approval ID");
        }
        return get(pendingApproval({ id: params.id }));
      });
    const { page, source } = await createPage(request, { hello: operator(["operator.approvals"]) });
    refresh();
    refresh();
    if (change === "id") {
      page.approvalId = "exec:approval-2";
    } else {
      source.update({ client: createTestGatewayClient(request) });
    }
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
    held.resolve(get());
    await settle(page);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
    expect(decision(page).disabled).toBe(false);
  });

  it.each(["hidden", "expired", "failed"])(
    "runs the queued follow-up only when a poll would run after %s",
    async (outcome) => {
      const lookup = Promise.withResolvers<ApprovalGetResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(get())
        .mockReturnValueOnce(lookup.promise)
        .mockResolvedValue(get());
      const { page } = await createPage(request);
      refresh();
      refresh();
      if (outcome === "failed") {
        lookup.reject(new Error("temporary Gateway failure"));
      } else {
        if (outcome === "hidden") {
          refresh("hidden");
        }
        lookup.resolve(get(outcome === "expired" ? expiredApproval() : pendingApproval()));
      }
      await settle(page);
      await settle(page);
      expect(request).toHaveBeenCalledTimes(outcome === "failed" ? 3 : 2);
    },
  );

  it.each(["applied", "reconciled"] as const)(
    "retires a queued lookup when a decision is %s",
    async (outcome) => {
      const staleLookup = Promise.withResolvers<ApprovalGetResult>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(get())
        .mockReturnValueOnce(staleLookup.promise)
        .mockResolvedValueOnce(allowed())
        .mockResolvedValue(get(expiredApproval()));
      const { page } = await createPage(request);
      refresh();
      refresh();
      expect(request).toHaveBeenCalledTimes(2);
      decision(page, outcome === "applied" ? "allow-once" : "deny").click();
      const title = outcome === "applied" ? "Approved here" : "Expired";
      await waitForSolid(() => expect(text(page, "h1")).toBe(title));
      const calls = outcome === "applied" ? 3 : 4;
      expect(request).toHaveBeenCalledTimes(calls);
      expect(request.mock.calls.filter(([method]) => method === "approval.resolve")).toHaveLength(
        1,
      );
      staleLookup.resolve(get());
      await settle(page);
      await settle(page);
      expect(request).toHaveBeenCalledTimes(calls);
      expect(text(page, "h1")).toBe(title);
      expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
    },
  );

  it("shows Retry progress while joining a background lookup", async () => {
    const lookup = Promise.withResolvers<ApprovalGetResult>();
    const followUp = Promise.withResolvers<ApprovalGetResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(get())
      .mockRejectedValueOnce(new Error("temporary Gateway failure"))
      .mockReturnValueOnce(lookup.promise)
      .mockReturnValueOnce(followUp.promise);
    const { page } = await createPage(request);
    refresh();
    await waitForSolid(() => expect(page.querySelector(".approval-page__callout")).not.toBeNull());
    refresh();
    await settle(page);
    const retry = page.querySelector<HTMLButtonElement>(".approval-page__callout button")!;
    expect(retry.disabled).toBe(false);
    expect(busy(page)).toBe("false");
    retry.click();
    await waitForSolid(() => expect(retry.disabled).toBe(true));
    expect(busy(page)).toBe("true");
    expect(request).toHaveBeenCalledTimes(3);
    lookup.resolve(get());
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(4));
    await waitForSolid(() => expect(busy(page)).toBe("false"));
    followUp.resolve(get());
    await settle(page);
    expect(request).toHaveBeenCalledTimes(4);
    expect(decision(page).disabled).toBe(false);
  });

  it("keeps one connection alert and disabled decisions across failed background polls", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(get())
      .mockRejectedValue(new Error("temporary Gateway failure"));
    const { page } = await createPage(request);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    const alert = page.querySelector(".approval-page__callout");
    expect(alert).not.toBeNull();
    expect(decision(page).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
    expect(page.querySelector(".approval-page__callout")).toBe(alert);
  });
});

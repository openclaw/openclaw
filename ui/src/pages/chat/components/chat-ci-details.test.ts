/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiSessionPullRequestCheckDetails } from "../../../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  createGatewayHarness,
  createHello,
} from "../../../lib/session-pull-requests.test-support.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatCiDetailsElement } from "./chat-ci-details.tsx";
import { subscribeCiGatewayUpdates } from "./chat-ci-gateway-updates.ts";
import "./chat-ci-automation-control.tsx";
import "./chat-ci-details.tsx";

const pullRequest = {
  owner: "example",
  repo: "project",
  number: 42,
  branch: "feature",
  title: "CI details",
  state: "open" as const,
  url: "https://github.com/example/project/pull/42",
  headSha: "a".repeat(40),
};

function details(
  name: string,
  headSha = pullRequest.headSha,
): ControlUiSessionPullRequestCheckDetails {
  return {
    owner: pullRequest.owner,
    repo: pullRequest.repo,
    number: pullRequest.number,
    headSha,
    status: "ready",
    rateLimited: false,
    checks: [{ id: 1, name, source: "actions", state: "failed", status: "completed", steps: [] }],
  };
}

function mount(pending: Promise<ControlUiSessionPullRequestCheckDetails>) {
  const harness = createGatewayHarness();
  harness.request.mockReturnValue(pending);
  const element = document.createElement("openclaw-chat-ci-details") as ChatCiDetailsElement;
  Object.assign(element, {
    gateway: harness.gateway,
    pullRequest,
    sessionKey: "agent:main:dashboard:ci-details",
    inline: true,
  });
  document.body.append(element);
  onTestFinished(() => element.remove());
  return { element, request: harness.request };
}

it("shows a delayed read, its failure, and a successful explicit retry", async () => {
  const read = createDeferred<ControlUiSessionPullRequestCheckDetails>();
  const { element, request } = mount(read.promise);
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("true");
  });
  read.reject(new Error("CI fixture unavailable"));
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__notice")?.textContent).toContain(
      "CI fixture unavailable",
    );
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("false");
  });
  request.mockResolvedValueOnce(details("Recovered check"));
  element.querySelector<HTMLButtonElement>(".chat-ci__retry")!.click();
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__job")?.textContent).toContain("Recovered check");
    expect(element.querySelector<HTMLDetailsElement>(".chat-ci__job")?.open).toBe(true);
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("false");
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("aborts a retired head read and ignores its late answer", async () => {
  const oldRead = createDeferred<ControlUiSessionPullRequestCheckDetails>();
  const { element, request } = mount(oldRead.promise);
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
  const signal = request.mock.calls[0]?.[2]?.signal;
  const nextHead = "b".repeat(40);
  request.mockResolvedValueOnce(details("Current head", nextHead));
  element.pullRequest = { ...pullRequest, headSha: nextHead };
  expect(signal?.aborted).toBe(true);
  await waitForSolid(() => expect(element.textContent).toContain("Current head"));
  oldRead.resolve(details("Retired head"));
  await element.updateComplete;
  await waitForSolid(() => {
    expect(element.textContent).toContain("Current head");
    expect(element.textContent).not.toContain("Retired head");
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("shares native subscriptions across closed CI pairs while retaining ordered events", async () => {
  const harness = createGatewayHarness();
  const rows = Array.from({ length: 100 }, () => {
    const root = document.createElement("details");
    root.className = "chat-pr__checks";
    const props = {
      gateway: harness.gateway,
      pullRequest,
      sessionKey: "agent:main:dashboard:ci-shared",
    };
    root.append(
      Object.assign(document.createElement("openclaw-chat-ci-details"), props),
      Object.assign(document.createElement("openclaw-chat-ci-automation"), props, {
        sessionId: "ci-shared",
      }),
    );
    document.body.append(root);
    return root;
  });
  onTestFinished(() => rows.forEach((row) => row.remove()));
  await waitForSolid(() => expect(harness.subscribeEvents).toHaveBeenCalledTimes(100));
  expect(harness.subscribeSnapshots).toHaveBeenCalledOnce();
  expect(harness.request).not.toHaveBeenCalled();
  rows.slice(0, 99).forEach((row) => row.remove());
  await waitForSolid(() => expect(harness.unsubscribeEvents).toHaveBeenCalledTimes(99));
  expect(harness.unsubscribeSnapshots).not.toHaveBeenCalled();
  rows[99]!.remove();
  await waitForSolid(() => expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce());
});

it("filters CI snapshots by the exact details and automation retirement facts", () => {
  const harness = createGatewayHarness();
  const gateway = harness.gateway;
  const client = gateway.snapshot.client!;
  let revision = gateway.connectionRevision;
  let generation = 1;
  Object.defineProperty(gateway, "connectionRevision", { get: () => revision });
  Object.defineProperty(client, "connectionGeneration", { get: () => generation });
  const detailsChanged = vi.fn();
  const automationChanged = vi.fn();
  const stops = [
    ...Array.from({ length: 100 }, () =>
      subscribeCiGatewayUpdates(gateway, "details", detailsChanged),
    ),
    ...Array.from({ length: 200 }, () =>
      subscribeCiGatewayUpdates(gateway, "automation", automationChanged),
    ),
  ];
  onTestFinished(() => stops.forEach((stop) => stop()));
  expect(harness.subscribeSnapshots).toHaveBeenCalledOnce();
  harness.setSnapshot({ ...gateway.snapshot, lastError: "Unrelated", sessionKey: "other" });
  expect(detailsChanged).not.toHaveBeenCalled();
  expect(automationChanged).not.toHaveBeenCalled();

  for (const change of [
    () => {
      revision += 1;
    },
    () => {
      generation += 1;
    },
    () => harness.setSnapshot({ ...gateway.snapshot, hello: createHello(["operator.admin"]) }),
  ]) {
    change();
    harness.setSnapshot({ ...gateway.snapshot });
    expect(detailsChanged).not.toHaveBeenCalled();
    expect(automationChanged).toHaveBeenCalledTimes(200);
    automationChanged.mockClear();
  }
  harness.setSnapshot({ ...gateway.snapshot, phase: "offline" });
  expect(detailsChanged).toHaveBeenCalledTimes(100);
  expect(automationChanged).toHaveBeenCalledTimes(200);
  stops.forEach((stop) => stop());
  expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
});

it("finishes synchronous CI retirement after a nested snapshot and isolates callbacks", () => {
  const harness = createGatewayHarness();
  const gateway = harness.gateway;
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  let replaced = false;
  const stopFirst = subscribeCiGatewayUpdates(gateway, "details", () => {
    if (!replaced) {
      replaced = true;
      harness.setSnapshot({ ...gateway.snapshot, lastError: "Nested publication" });
    }
  });
  const stopThrowing = subscribeCiGatewayUpdates(gateway, "automation", () => {
    throw new Error("Automation refresh failed");
  });
  const notify = vi.fn();
  const stopLast = subscribeCiGatewayUpdates(gateway, "automation", notify);
  onTestFinished(() => {
    stopFirst();
    stopThrowing();
    stopLast();
    vi.unstubAllGlobals();
  });
  harness.setSnapshot({ ...gateway.snapshot, phase: "offline" });
  expect(notify).toHaveBeenCalledExactlyOnceWith(gateway.snapshot);
  expect(report).toHaveBeenCalledOnce();
});

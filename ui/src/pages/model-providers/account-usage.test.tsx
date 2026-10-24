import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AccountLimits, type AccountUsageScope } from "./account-usage.tsx";

registerSettingsEnglish();

const snapshot = {
  updatedAt: 1,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      plan: "Pro",
      windows: [{ label: "5h", usedPercent: 25 }],
      billing: [{ type: "balance", amount: 12, unit: "credits" }],
    },
  ],
};

function mount(request: ReturnType<typeof createGatewayRequestMock>) {
  const client = createTestGatewayClient(request);
  const [scope, setScope] = createSignal<AccountUsageScope>({
    client,
    agentId: "main",
    revision: 0,
  });
  const view = mountSolid(() => <AccountLimits scope={scope()} profileId="openai:account" />);
  return { container: view.container, scope, setScope };
}

it("loads automatically, renders remaining quota and balance, and re-reads on a new revision", async () => {
  const request = createGatewayRequestMock(async () => snapshot);
  const view = mount(request);
  await waitForSolid(() => expect(view.container.textContent).toContain("12 credits"));
  expect(view.container.textContent).toContain("Pro");
  expect(view.container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("75");
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "codex.accountUsage",
    { agentId: "main", profileId: "openai:account" },
    { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
  );
  // A rebuilt scope with the same fields is the same account read.
  view.setScope({ ...view.scope() });
  flush();
  expect(request).toHaveBeenCalledTimes(1);
  view.setScope({ ...view.scope(), revision: 1 });
  await waitForSolid(() => expect(request.mock.calls.length).toBe(2));
  expect(request.mock.lastCall?.[1]).toEqual({ agentId: "main", profileId: "openai:account" });
  await waitForSolid(() => expect(view.container.textContent).toContain("12 credits"));
});

it("drops a pending response when the selected agent changes and shows the current error", async () => {
  const stale = createDeferredCore();
  const request = createGatewayRequestMock(async (_method, params) => {
    if ((params as { agentId: string }).agentId === "main") {
      await stale.promise;
      return snapshot;
    }
    throw new Error("Account usage unavailable");
  });
  const view = mount(request);
  await waitForSolid(() => expect(request.mock.calls.length).toBe(1));
  view.setScope({ ...view.scope(), agentId: "other" });
  await waitForSolid(() =>
    expect(view.container.textContent).toContain("Account usage unavailable"),
  );
  expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  stale.resolve();
  await stale.promise;
  flush();
  expect(view.container.textContent).toContain("Account usage unavailable");
  expect(view.container.textContent).not.toContain("12 credits");
});

it("shows the empty state when Codex returns a snapshot without quota data", async () => {
  const request = createGatewayRequestMock(async () => ({
    updatedAt: 1,
    providers: [{ provider: "openai", displayName: "OpenAI", windows: [] }],
  }));
  const view = mount(request);
  await waitForSolid(() => expect(view.container.textContent).toContain("No live usage data"));
});

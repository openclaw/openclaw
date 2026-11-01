import { afterEach, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createContext,
  createGateway,
  createPage,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { cronRpc } from "./cron-rpc.test-support.ts";
import { scheduledJob } from "./view.test-support.ts";

const mounted: ReturnType<typeof createPage>[] = [];
afterEach(() => {
  mounted.splice(0).forEach((page) => page.remove());
});

it("lets a human owner edit their job but not another person's job", async () => {
  const own = { ...scheduledJob("own"), ownerProfileId: "alice" };
  const other = { ...scheduledJob("other"), ownerProfileId: "bob" };
  const request = cronRpc({
    "cron.list": () => cronListResponse([own, other]),
    "users.list": () => ({
      profiles: [
        { id: "alice", displayName: "Alice", emails: [], createdAt: 1, updatedAt: 1 },
        { id: "bob", displayName: "Bob", emails: [], createdAt: 1, updatedAt: 1 },
      ],
    }),
  });
  const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
  gateway.emitSnapshot({
    hello: operatorHello(["operator.admin"]),
    selfUser: { id: "alice", identity: { type: "profile", id: "alice" } },
  });
  const page = createPage(createContext(gateway), { render: true });
  mounted.push(page);
  await waitForCronPage(() => {
    expect(page.cron.cronJobs).toHaveLength(2);
    expect(page.querySelector('[data-test-id="cron-row-run-own"]')).not.toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-run-other"]')).not.toBeNull();
  });
  gateway.emitSnapshot({ hello: operatorHello(["operator.read", "operator.write"]) });
  await waitForCronPage(() => {
    expect(page.querySelector('[data-test-id="cron-row-run-own"]')).not.toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-run-other"]')).toBeNull();
  });
  const identity = gateway.snapshot.selfUser!.identity!;
  identity.id = "bob";
  page.refreshView();
  await waitForCronPage(() => {
    expect(page.querySelector('[data-test-id="cron-row-run-own"]')).toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-run-other"]')).not.toBeNull();
  });
  identity.id = "alice";
  page.refreshView();
  await waitForCronPage(() =>
    expect(page.querySelector('[data-test-id="cron-row-run-own"]')).not.toBeNull(),
  );
  page.selectJob(own);
  await page.settle();
  await waitForCronPage(() =>
    expect(page.querySelector<HTMLInputElement>("#cron-name")?.matches(":disabled")).toBe(false),
  );
  const owner = page.querySelector<HTMLButtonElement>("#cron-owner-profile-id");
  expect(owner).not.toBeNull();
  expect(owner?.matches(":disabled")).toBe(false);
  page.patchForm({ name: "Edited by owner", ownerProfileId: "bob" });
  await page.settle();
  expect(page.cron.cronForm.name).toBe("Edited by owner");
  expect(page.cron.cronForm.ownerProfileId).toBe("bob");
  page.selectJob(other);
  await page.settle();
  await waitForCronPage(() =>
    expect(page.querySelector<HTMLInputElement>("#cron-name")?.matches(":disabled")).toBe(true),
  );
  page.patchForm({ name: "Unauthorized" });
  expect(page.cron.cronForm.name).toBe(other.name);
  page.closePanel();
  gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
  await waitForCronPage(() =>
    expect(page.querySelector('[data-test-id="cron-row-run-other"]')).not.toBeNull(),
  );
});

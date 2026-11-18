import { afterEach, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob } from "../../api/types.ts";
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
  // An automation offers Run now only to someone who may change it.
  const canRun = async (job: CronJob) => {
    page.selectJob(job);
    await page.settle();
    return page.querySelector('[data-test-id="cron-run-now"]') !== null;
  };
  await waitForCronPage(() => expect(page.cron.cronJobs).toHaveLength(2));
  expect([await canRun(own), await canRun(other)]).toEqual([true, true]);
  gateway.emitSnapshot({ hello: operatorHello(["operator.read", "operator.write"]) });
  await page.settle();
  expect([await canRun(own), await canRun(other)]).toEqual([true, false]);
  const identity = gateway.snapshot.selfUser!.identity!;
  identity.id = "bob";
  page.refreshView();
  expect([await canRun(own), await canRun(other)]).toEqual([false, true]);
  identity.id = "alice";
  page.refreshView();
  expect(await canRun(own)).toBe(true);
  page.selectJob(own);
  await page.settle();
  page.querySelector<HTMLButtonElement>('[data-test-id="cron-edit"]')!.click();
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
  page.querySelector<HTMLButtonElement>('[data-test-id="cron-edit"]')!.click();
  await page.settle();
  await waitForCronPage(() =>
    expect(page.querySelector<HTMLInputElement>("#cron-name")?.matches(":disabled")).toBe(true),
  );
  page.patchForm({ name: "Unauthorized" });
  expect(page.cron.cronForm.name).toBe(other.name);
  page.closePanel();
  gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
  await page.settle();
  expect(await canRun(other)).toBe(true);
});

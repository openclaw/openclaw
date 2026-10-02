/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../api/types.ts";
import { sessionMutationGatewayHello } from "../test-helpers/gateway-methods.ts";
import { confirmSessionArchive } from "./session-archive-confirmation.ts";

const job: CronCompactJob = {
  id: "daily",
  name: "Daily check",
  enabled: true,
  scheduleKind: "every",
  schedule: { kind: "every", everyMs: 60_000 },
  updatedAtMs: 1,
  nextRunAt: null,
  nextRunAtMs: null,
  lastRunAt: null,
  lastRunAtMs: null,
  lastRunStatus: null,
  lastRunError: null,
};
const page = (jobs = [job]): CronJobsListResult<CronCompactJob> => ({
  jobs,
  snapshotRevision: "one",
  total: jobs.length,
  limit: 200,
  offset: 0,
  nextOffset: null,
  hasMore: false,
});

function setup() {
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const request = vi.fn(async () => page());
  const options = {
    client: { request } as Parameters<typeof confirmSessionArchive>[0]["client"],
    snapshot: { hello: sessionMutationGatewayHello() },
    targets: [{ key: "agent:main:bound", agentId: "main", hasAutomation: true }],
    signal: abort.signal,
    isCurrent: () => true,
  };
  return { request, options, abort };
}

async function dialogButton(text: string) {
  await vi.waitFor(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
  const dialog = document.querySelector("openclaw-modal-dialog")!;
  const button = [...dialog.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  return { dialog, button: button! };
}

afterEach(() => document.body.replaceChildren());

describe("archive automation confirmation", () => {
  it("deduplicates an automation shared by selected sessions and cancel preserves them", async () => {
    const { options, request } = setup();
    options.targets.push({ key: "agent:main:other", agentId: "main", hasAutomation: true });
    const confirmed = confirmSessionArchive(options);
    const { dialog, button } = await dialogButton("Cancel");
    expect(dialog.querySelectorAll(".confirm-dialog-item")).toHaveLength(1);
    expect(request.mock.calls).toHaveLength(2);
    button.click();
    expect(await confirmed).toBe(false);
  });

  it.each([false, true])(
    "requires a complete unchanged paged inventory (changed=%s)",
    async (changed) => {
      const { options, request } = setup();
      request.mockResolvedValueOnce({
        ...page(),
        total: 2,
        limit: 1,
        hasMore: true,
        nextOffset: 1,
      });
      request.mockResolvedValueOnce({
        ...page([{ ...job, id: "second", name: "Second check" }]),
        total: 2,
        limit: 1,
        offset: 1,
        snapshotRevision: changed ? "two" : "one",
      });
      const confirmed = confirmSessionArchive(options);
      if (changed) {
        const { dialog, button } = await dialogButton("Cancel");
        expect(dialog.textContent).toContain("Automation details could not be loaded");
        expect(dialog.querySelectorAll(".confirm-dialog-item")).toHaveLength(0);
        button.click();
        expect(await confirmed).toBe(false);
      } else {
        const { dialog, button } = await dialogButton("Archive and pause");
        expect(dialog.textContent).toContain("Daily check");
        expect(dialog.textContent).toContain("Second check");
        button.click();
        expect(await confirmed).toBe(true);
      }
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "warns a nonadmin without expanding read access (sessionOnly=%s)",
    async (sessionOnly) => {
      const { options, request } = setup();
      options.snapshot.hello = {
        ...options.snapshot.hello,
        auth: {
          role: "operator",
          scopes: sessionOnly ? ["operator.sessions.write"] : ["operator.read", "operator.write"],
        },
      };
      const confirmed = confirmSessionArchive(options);
      const { dialog, button } = await dialogButton("Archive session");
      expect(dialog.textContent).toContain("do not have permission to pause");
      expect(dialog.textContent).toContain(
        sessionOnly ? "does not include automation names and schedules" : "Stays enabled",
      );
      expect(request).toHaveBeenCalledTimes(sessionOnly ? 0 : 1);
      expect(dialog.textContent).not.toContain("Archive and pause");
      button.click();
      expect(await confirmed).toBe(true);
    },
  );

  it("previews names and schedules when every attached automation is already paused", async () => {
    const { options, request } = setup();
    options.targets[0]!.hasAutomation = false;
    request.mockResolvedValue(page([{ ...job, enabled: false }]));
    const confirmed = confirmSessionArchive(options);
    const { dialog, button } = await dialogButton("Archive session");
    expect(dialog.textContent).toContain("Daily check");
    expect(dialog.textContent).toContain("Every 1m");
    expect(dialog.textContent).toContain("Already paused");
    expect(dialog.textContent).not.toContain("Archive and pause");
    button.click();
    expect(await confirmed).toBe(true);
  });

  it("does not continue after a reconnect during the inventory read", async () => {
    const { options, request } = setup();
    const deferred = createDeferred<ReturnType<typeof page>>();
    request.mockReturnValue(deferred.promise);
    const confirmed = confirmSessionArchive(options);
    options.isCurrent = () => false;
    deferred.resolve(page());
    expect(await confirmed).toBe(false);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it.each([false, true])(
    "requires an explicit choice when inventory is unavailable (archive=%s)",
    async (archive) => {
      const { options, request } = setup();
      request.mockRejectedValue(new Error("Inventory unavailable"));
      const confirmed = confirmSessionArchive(options);
      const { dialog, button } = await dialogButton(archive ? "Archive anyway" : "Cancel");
      expect(dialog.textContent).toContain("Automation details could not be loaded");
      expect(dialog.querySelectorAll(".confirm-dialog-item")).toHaveLength(0);
      button.click();
      expect(await confirmed).toBe(archive);
    },
  );

  it("archives without a dialog when the authoritative inventory is empty", async () => {
    const { options, request } = setup();
    options.targets[0]!.hasAutomation = false;
    request.mockResolvedValue(page([]));
    expect(await confirmSessionArchive(options)).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });
});

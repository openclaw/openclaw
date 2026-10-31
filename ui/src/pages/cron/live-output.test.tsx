import type { CronLiveOutputResult } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createCronViewJob, createCronViewProps, getElement } from "./view.test-support.ts";
import { CronView } from "./view.tsx";

const POLL_MS = 2000;
const RUN_AT = 1_700_000_000_000;

function runningJob(overrides: Record<string, unknown> = {}) {
  return createCronViewJob("job-live", {
    payload: { kind: "command", argv: ["/bin/sleep", "60"] },
    state: { runningAtMs: RUN_AT },
    ...overrides,
  });
}

function connectedGateway(request: ReturnType<typeof vi.fn>) {
  return createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      phase: "connected",
    }),
  );
}

function live(overrides: Partial<CronLiveOutputResult>): CronLiveOutputResult {
  return { active: true, runAtMs: RUN_AT, cursor: 0, text: "", ...overrides };
}

async function tick(ms = POLL_MS) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

async function mountHistory(
  gateway: ReturnType<typeof connectedGateway>["gateway"],
  job = runningJob(),
) {
  const [props, setProps] = createSignal(
    createCronViewProps({
      gateway,
      editingJob: job,
      detailTab: "history",
      listTab: "activity",
    }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  await vi.dynamicImportSettled();
  flush();
  const update = (editingJob: ReturnType<typeof runningJob>) => {
    setProps((previous) => ({ ...previous, editingJob }));
    flush();
  };
  return { ...view, update };
}

const stream = (container: Element) =>
  container.querySelector<HTMLElement>(".cron-live-output__stream");

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("follows a running command job by cursor and hands off when the run stops", async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.cursor === undefined
      ? live({ cursor: 6, text: "one\ntw\n", reset: true })
      : live({ cursor: 10, text: "three\n" }),
  );
  const { gateway } = connectedGateway(request);
  const view = await mountHistory(gateway);
  await tick(0);
  expect(request).toHaveBeenLastCalledWith("cron.liveOutput", { id: "job-live" });
  expect(stream(view.container)?.textContent).toBe("one\ntw\n");
  await tick();
  expect(request).toHaveBeenLastCalledWith("cron.liveOutput", {
    id: "job-live",
    cursor: 6,
    runAtMs: RUN_AT,
  });
  expect(stream(view.container)?.textContent).toBe("one\ntw\nthree\n");

  // The job's cleared runtime state retires the panel; the recorded run is the only copy.
  view.update(runningJob({ state: {} }));
  expect(view.container.querySelector('[data-test-id="cron-live-output"]')).toBeNull();
  const calls = request.mock.calls.length;
  await tick(POLL_MS * 3);
  expect(request.mock.calls.length).toBe(calls);
});

it("only shows for a running command job", async () => {
  const request = vi.fn(async () => live({}));
  const { gateway } = connectedGateway(request);
  const idle = await mountHistory(gateway, runningJob({ state: {} }));
  const agentTurn = await mountHistory(
    gateway,
    runningJob({ payload: { kind: "agentTurn", message: "digest" } }),
  );
  await tick(0);
  expect(idle.container.querySelector('[data-test-id="cron-live-output"]')).toBeNull();
  expect(agentTurn.container.querySelector('[data-test-id="cron-live-output"]')).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("pauses polling while the tab is hidden and catches up on return", async () => {
  const request = vi.fn(async () => live({ cursor: 2, text: "x\n", reset: true }));
  const { gateway } = connectedGateway(request);
  const visibility = vi.spyOn(document, "visibilityState", "get");
  await mountHistory(gateway);
  await tick(0);
  const before = request.mock.calls.length;
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await tick(POLL_MS * 3);
  expect(request.mock.calls.length).toBe(before);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await tick(0);
  expect(request.mock.calls.length).toBe(before + 1);
});

it("stops polling and explains the handoff once the Gateway reports no live run", async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.cursor === undefined
      ? live({ cursor: 2, text: "x\n", reset: true })
      : ({ active: false, cursor: 0, text: "" } satisfies CronLiveOutputResult),
  );
  const { gateway } = connectedGateway(request);
  const view = await mountHistory(gateway);
  await tick(0);
  await tick();
  const calls = request.mock.calls.length;
  expect(view.container.textContent).toContain("The run is finishing.");
  expect(stream(view.container)?.textContent).toBe("x\n");
  await tick(POLL_MS * 3);
  expect(request.mock.calls.length).toBe(calls);
});

it("keeps polling while the command has not started and follows once it does", async () => {
  const idle: CronLiveOutputResult = { active: false, cursor: 0, text: "" };
  const request = vi
    .fn()
    .mockResolvedValueOnce(idle)
    .mockResolvedValueOnce(idle)
    .mockResolvedValue(live({ cursor: 2, text: "x\n", reset: true }));
  const { gateway } = connectedGateway(request);
  const view = await mountHistory(gateway);
  await tick(0);
  await tick();
  expect(view.container.textContent).not.toContain("The run is finishing.");
  await tick();
  expect(stream(view.container)?.textContent).toBe("x\n");
});

it("offers jump-to-latest only after the reader scrolls up", async () => {
  const request = vi.fn(async () => live({ cursor: 2, text: "x\n", reset: true }));
  const { gateway } = connectedGateway(request);
  const view = await mountHistory(gateway);
  await tick(0);
  const pre = getElement(view.container, ".cron-live-output__stream", HTMLElement);
  expect(view.container.querySelector(".cron-live-output__jump")).toBeNull();
  const geometry = { scrollHeight: 2000, clientHeight: 360, scrollTop: 100 };
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(pre, key, { value, configurable: true, writable: true });
  }
  pre.dispatchEvent(new Event("scroll"));
  flush();
  const jump = getElement(view.container, ".cron-live-output__jump", HTMLButtonElement);
  expect(jump.textContent).toContain("Jump to latest");
  // Reaching the end again clears it.
  (pre as unknown as { scrollTop: number }).scrollTop = 1700;
  pre.dispatchEvent(new Event("scroll"));
  flush();
  expect(view.container.querySelector(".cron-live-output__jump")).toBeNull();
});

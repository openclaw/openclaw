import { describe, expect, it, vi } from "vitest";
import { readMockRequests, useMediaGateway } from "../media/media-gateway.test-support.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const waitFor = <T>(callback: () => T | Promise<T>, timeout = 60_000) =>
  vi.waitFor(callback, { interval: 100, timeout });

type CronRunEntry = {
  runId?: string;
  status?: string;
  error?: string;
  summary?: string;
  sessionKey?: string;
  durationMs?: number;
  diagnostics?: { entries: Array<{ source: string; message: string }> };
};

describe("one-shot cron run background work", () => {
  const fixture = useMediaGateway();

  async function runCronJob(mode: "yield" | "service" | "spawn") {
    const { mock, gateway } = await fixture.start({
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
    });
    const job = (await gateway.call("cron.add", {
      name: `Cron one-shot ${mode}`,
      agentId: "qa",
      enabled: true,
      // Keep the run session: deleting it stops the commands it still runs.
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: `Cron one-shot QA mode=${mode}` },
      // Delivery mode none turns off exit wakes entirely; announce keeps them on.
      delivery: { mode: "announce", channel: "qa-channel", to: "channel:qa-one-shot" },
    })) as { id: string };
    const logMark = gateway.markLogs();
    const started = (await gateway.call("cron.run", { id: job.id, mode: "force" })) as {
      runId: string;
    };
    const run = await waitFor(async () => {
      const history = (await gateway.call("cron.runs", {
        id: job.id,
        runId: started.runId,
        limit: 1,
      })) as { entries?: CronRunEntry[] };
      const entry = history.entries?.find((candidate) => candidate.runId === started.runId);
      expect(entry).toBeDefined();
      return entry!;
    }, 90_000);
    const logs = () => gateway.readLogsSince(logMark);
    expect(run, logs()).toMatchObject({ status: "ok" });
    const endCursor = Math.max(0, ...(await readMockRequests(mock.baseUrl)).map((r) => r.cursor));
    // Nothing reaches the model on the run's behalf after it ended.
    const laterRequests = () => readMockRequests(mock.baseUrl, endCursor);
    expect(run.sessionKey).toMatch(/:cron:[^:]+:run:/);
    // The ended run admits no later turn on its key.
    await expect(
      gateway.call("agent", {
        sessionKey: run.sessionKey,
        message: "late turn after the cron run ended",
        idempotencyKey: `late-${mode}`,
      }),
    ).rejects.toThrow("cron run has ended; inspect the result in its run record");
    return { run, mock, logs, laterRequests };
  }

  it("resumes a yielded run in place with its background command output", async () => {
    const { run, mock, laterRequests } = await runCronJob("yield");
    expect(run.summary).toContain("QA-ONE-SHOT-YIELD-DONE");
    const requests = await readMockRequests(mock.baseUrl);
    expect(requests.some((request) => request.prompt.includes("QA-ONE-SHOT-YIELD-DONE"))).toBe(
      true,
    );
    expect(await laterRequests()).toEqual([]);
  }, 240_000);

  it("ends promptly past a running command, records it and refuses its exit", async () => {
    const { run, logs, laterRequests } = await runCronJob("service");
    expect(run.durationMs).toBeLessThan(25_000);
    expect(run.diagnostics?.entries).toContainEqual(
      expect.objectContaining({
        source: "exec",
        message: expect.stringContaining("Background commands still running after the run ended"),
      }),
    );
    // The command exits after the run ended: refused once, and no turn reaches the model.
    await waitFor(() => {
      expect(logs()).toContain("completion was not admitted (cron run has ended");
    }, 60_000);
    expect(logs().split("completion was not admitted").length - 1).toBe(1);
    expect(await laterRequests()).toEqual([]);
  }, 240_000);

  it("completes with a spawned child's result", async () => {
    const { run, laterRequests } = await runCronJob("spawn");
    expect(run.summary).toContain("QA-ONE-SHOT-CHILD-RESULT");
    expect(await laterRequests()).toEqual([]);
  }, 240_000);
});

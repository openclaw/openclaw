import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginCronCommandLiveOutput } from "../../cron/command-live-output.js";
import {
  createCronCallerClient,
  createCronJob,
  createCronTestContext,
  createCronTestInvoker,
  expectResponseError,
} from "./cron.validation.test-support.js";

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);
vi.mock("../../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js")),
  getRuntimeConfig,
}));

import { cronHandlers } from "./cron.js";

const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);
const job = createCronJob({ id: "live-job", agentId: "main" });
const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((end) => end()));

function begin(jobId = "live-job") {
  const live = beginCronCommandLiveOutput({ jobId, runAtMs: 77 });
  open.push(() => live.end());
  return live;
}

describe("cron.liveOutput", () => {
  it("returns the active tail and follows by cursor", async () => {
    begin().append(Buffer.from("hello\nworld\n"));
    const first = await invokeCron("cron.liveOutput", { id: "live-job" }, { currentJob: job });
    expect(first.respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { active: true, runAtMs: 77, cursor: 12, text: "hello\nworld\n", reset: true },
      undefined,
    );
    const next = await invokeCron(
      "cron.liveOutput",
      { id: "live-job", cursor: 12, runAtMs: 77 },
      { currentJob: job },
    );
    expect(next.respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { active: true, runAtMs: 77, cursor: 12, text: "" },
      undefined,
    );
  });

  it("reports inactive for a job with no running command", async () => {
    const { respond } = await invokeCron(
      "cron.liveOutput",
      { id: "live-job" },
      { currentJob: job },
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { active: false, cursor: 0, text: "" },
      undefined,
    );
  });

  it("rejects malformed params and unknown fields", async () => {
    const bad = await invokeCron(
      "cron.liveOutput",
      { id: "live-job", cursor: -1 },
      { currentJob: job },
    );
    expectResponseError(bad.respond, { code: "INVALID_REQUEST" });
    const extra = await invokeCron(
      "cron.liveOutput",
      { id: "live-job", limit: 1 },
      { currentJob: job },
    );
    expectResponseError(extra.respond, { code: "INVALID_REQUEST" });
  });

  it("does not disclose output for a job the caller cannot see", async () => {
    begin().append(Buffer.from("secret-ish\n"));
    const { respond } = await invokeCron(
      "cron.liveOutput",
      { id: "live-job" },
      { currentJob: job, client: createCronCallerClient("other") },
    );
    expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "not found" });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("secret-ish");
  });

  it("releases nothing when authority closes while the job read is pending", async () => {
    begin().append(Buffer.from("secret-ish\n"));
    const context = createCronTestContext(job, getRuntimeConfig);
    let current = true;
    let release = () => {};
    context.cron.readJob.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return job;
    });
    const respond = vi.fn();
    const pending = invokeCron(
      "cron.liveOutput",
      { id: "live-job" },
      { context, respond, hasCurrentClientAuthority: () => current },
    );
    current = false;
    release();
    await expect(pending).rejects.toThrow("authority closed");
    expect(JSON.stringify(respond.mock.calls)).not.toContain("secret-ish");
  });

  it("answers not found for an unknown job even if a buffer exists under that id", async () => {
    begin("ghost").append(Buffer.from("x\n"));
    const { respond } = await invokeCron("cron.liveOutput", { id: "ghost" }, { currentJob: job });
    expectResponseError(respond, { code: "INVALID_REQUEST" });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cronAccountPolicy,
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
const PARENT = "agent:main:control-ui";
const keyOnlyJob = createCronJob({
  agentId: "main",
  owner: { agentId: "main", sessionKey: PARENT, accountId: "default" },
  scheduledToolPolicy: cronAccountPolicy(PARENT, "default"),
});

describe("cron.bind admission", () => {
  it("refuses a caller with no conversation, such as the shell CLI", async () => {
    const context = createCronTestContext(keyOnlyJob, getRuntimeConfig);
    const { respond } = await invokeCron("cron.bind", { id: keyOnlyJob.id }, { context });

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "ask the agent in that conversation to bind it",
    });
    expect(context.cron.updateWithPrecondition).not.toHaveBeenCalled();
  });

  it("refuses a turn in the parent conversation that holds no management grant", async () => {
    const context = createCronTestContext(keyOnlyJob, getRuntimeConfig);
    const { respond } = await invokeCron(
      "cron.bind",
      { id: keyOnlyJob.id },
      { context, client: createCronCallerClient("main", "default", PARENT) },
    );

    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "authenticated owner turn",
    });
    expect(context.cron.updateWithPrecondition).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied conversation", async () => {
    const { respond } = await invokeCron("cron.bind", { id: keyOnlyJob.id, sessionKey: PARENT });

    expectResponseError(respond, { code: "INVALID_REQUEST" });
  });
});

import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as sessionEventHandoff from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readVisibleSessionTranscriptMessageEntries } from "../plugin-sdk/session-transcript-runtime.js";
import { captureSessionGeneration } from "../sessions/session-notice.js";
import { createGatewayCronTargetResolver } from "./server-cron-targets.js";
import {
  createCronFixture,
  installRequesterCronAuthorityTestHooks,
  SESSION,
  SESSION_ID,
} from "./server-methods/requester-cron-authority.test-support.js";

await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
installRequesterCronAuthorityTestHooks();

const NOTICE = '⚠️ Automation "Health check" was auto-disabled: proof notice.';

async function visibleNotices(): Promise<number> {
  const generation = await captureSessionGeneration({
    config: getRuntimeConfigSnapshot()!,
    agentId: "main",
    sessionKey: SESSION,
  });
  const entries = await readVisibleSessionTranscriptMessageEntries({
    agentId: "main",
    sessionKey: SESSION,
    sessionId: generation?.sessionId ?? SESSION_ID,
    ...(generation ? { storePath: generation.storePath } : {}),
  });
  // JSON escapes the notice's quotes; match its unquoted tail.
  return entries.filter((entry) =>
    JSON.stringify(entry).includes("was auto-disabled: proof notice."),
  ).length;
}

it("shows a cron system notice once when the owner conversation's model cannot run", async () => {
  // The owner conversation runs on a provider with no usable account, like a signed-out one.
  const config = {
    agents: { entries: { main: { model: "openai/gpt-4.1" } } },
    plugins: { enabled: false },
  } as OpenClawConfig;
  setRuntimeConfigSnapshot(config);
  const { context } = createCronFixture(undefined, config);
  const job = await context.cron.add({
    name: "Health check",
    enabled: true,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Check the dashboard." },
    delivery: { mode: "none" },
    owner: { agentId: "main", sessionKey: SESSION },
  });
  const handoff = vi.spyOn(sessionEventHandoff, "enqueueSessionEventForHost");
  try {
    await createGatewayCronTargetResolver(
      process.env,
      { warn: vi.fn() },
      () => context,
    ).enqueueSessionEvent(NOTICE, {
      agentId: "main",
      sessionKey: SESSION,
      jobId: job.id,
    });
    const receipt = expectDefined(handoff.mock.results[0]?.value, "notice receipt");
    const settled = await receipt.settled;
    expect(settled.status).not.toBe("completed");
    await vi.waitFor(async () => expect(await visibleNotices()).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(await visibleNotices()).toBe(1);
  } finally {
    handoff.mockRestore();
  }
});

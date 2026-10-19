import { beforeEach, expect, it, vi } from "vitest";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronJob } from "./types.js";

const resolveDeliveryTarget = vi.hoisted(() => vi.fn());

vi.mock("./isolated-agent/delivery-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./isolated-agent/delivery-target.js")>()),
  resolveDeliveryTarget,
  prepareCronDeliveryTargetContexts: async (_cfg: unknown, requests: unknown[]) =>
    requests.map(() => ({
      ok: true,
      value: { mainSessionKey: "agent:main:main", usedSharedMainFallback: false },
    })),
}));

const { resolveCronDeliveryPreviews } = await import("./delivery-preview.js");

async function previewForJob(overrides: Partial<CronJob>) {
  const job = makeCronJob(overrides);
  return (await resolveCronDeliveryPreviews({ cfg: {}, jobs: [job] }))[job.id]!;
}

function expectTarget(target: Record<string, unknown>) {
  expect(resolveDeliveryTarget).toHaveBeenCalledWith(
    {},
    "avery",
    expect.objectContaining(target),
    expect.objectContaining({ dryRun: true }),
  );
}

function failRoute(error: string, channel?: string) {
  resolveDeliveryTarget.mockResolvedValueOnce({
    ok: false,
    channel,
    mode: "implicit",
    error: new Error(error),
  });
}

const current = {
  sessionTarget: "current",
  sessionKey: "agent:main:dashboard:c5557dcf",
  delivery: undefined,
} as const;

beforeEach(() => {
  resolveDeliveryTarget.mockReset().mockResolvedValue({
    ok: true,
    channel: "telegram",
    to: "direct-123",
    mode: "implicit",
  });
});

it("prefers sessionTarget session context over creator sessionKey", async () => {
  const sessionTarget = "session:agent:avery:telegram:direct:direct-123";
  const preview = await previewForJob({
    agentId: "avery",
    sessionTarget,
    sessionKey: "agent:avery:telegram:group:ops:sender:direct-123",
    delivery: undefined,
  });

  expectTarget({
    channel: "last",
    sessionKey: "agent:avery:telegram:direct:direct-123",
    sessionTarget,
  });
  expect(preview.detail).toBe(
    "commits to the destination conversation; sends one external notification",
  );
});

it("does not resolve routes for explicit no-delivery jobs", async () => {
  const preview = await previewForJob({ delivery: { mode: "none" } });

  expect(preview).toEqual({ label: "not requested", detail: "not requested" });
  expect(resolveDeliveryTarget).not.toHaveBeenCalled();
});

it("lists a refused agent's repair reason beside healthy delivery previews", async () => {
  const refusal = {
    agentId: "cleaner",
    paths: ["/synthetic/cleaner/openclaw-agent.sqlite"],
    embeddedOwnerId: "main",
    code: "agent-database-ownership-mismatch" as const,
    reason: "Refused agent cleaner: its database belongs to main.",
    repairHint: "Inspect the divergent copy and restart after repair.",
  };
  recordAgentDatabaseAdmissions([refusal]);
  try {
    const previews = await resolveCronDeliveryPreviews({
      cfg: {},
      jobs: [
        makeCronJob({ id: "healthy", agentId: "main" }),
        makeCronJob({ id: "refused", agentId: "cleaner" }),
      ],
    });
    expect(previews.healthy?.label).toBe("announce -> telegram:direct-123");
    expect(previews.refused).toEqual({
      label: "agent cleaner unavailable",
      detail: `${refusal.reason}\n${refusal.repairHint}`,
    });
    expect(resolveDeliveryTarget).toHaveBeenCalledTimes(1);
  } finally {
    recordAgentDatabaseAdmissions([]);
  }
});

it.each([
  {
    name: "explicit",
    delivery: {
      mode: "none",
      channel: "topicchat",
      to: "room#42",
      threadId: 42,
      accountId: "ops",
    },
    expected: { label: "none -> telegram:direct-123", detail: "explicit" },
    error: undefined,
  },
  {
    name: "unresolved",
    delivery: { mode: "none", threadId: 0 },
    expected: { label: "none -> last", detail: "message tool target unresolved: no route" },
    error: "no route",
  },
] as const)(
  "previews $name message-tool targets without automatic delivery",
  async ({ delivery, expected, error }) => {
    if (error) {
      failRoute(error);
    }
    expect(await previewForJob({ agentId: "avery", delivery: structuredClone(delivery) })).toEqual(
      expected,
    );
    expectTarget({ ...delivery, sessionKey: undefined, sessionTarget: "isolated" });
  },
);

it("previews current-target announce with no external route as a conversation commit", async () => {
  failRoute("Channel is required (no configured channels detected).");
  expect(await previewForJob(current)).toEqual({
    label: "announce -> current session",
    detail: "commits to this conversation (no external channel route)",
  });
});

it("keeps unavailable external plugin routes fail-closed", async () => {
  failRoute("Channel plugin unavailable", "unavailable-plugin");
  expect(await previewForJob(current)).toEqual({
    label: "announce -> last",
    detail: expect.stringContaining(
      "last -> no route, will be blocked: Channel plugin unavailable",
    ),
  });
});

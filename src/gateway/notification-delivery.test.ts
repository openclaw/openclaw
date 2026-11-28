import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  canNotificationRecipientReceive,
  resolveNotificationPath,
  withNotificationSessionFacts,
} from "./notification-authority.js";
import {
  createNotificationDelivery,
  type NotificationDestination,
} from "./notification-delivery.js";
import {
  approvalNotificationIntent,
  renderNotificationCopy,
  resolveEventNotificationIntent,
  type NotificationIntent,
} from "./notification-intent.js";
import type { GatewayClient } from "./server-methods/types.js";

const mocks = vi.hoisted(() => ({
  canReceive: vi.fn(),
  prepareFacts: vi.fn(),
}));

vi.mock("./session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing.js")>()),
  canReceiveSessionEvent: mocks.canReceive,
}));

vi.mock("./session-sharing-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing-preparation.js")>()),
  prepareSessionMutationFacts: mocks.prepareFacts,
}));

const client = { connect: { scopes: ["operator.read"] } } as unknown as GatewayClient;
const namedRoles: OpenClawConfig = { gateway: { roles: { default: "viewer" } } } as OpenClawConfig;

function recordingDestination() {
  const intents: NotificationIntent[] = [];
  const destination: NotificationDestination = { deliver: (intent) => intents.push(intent) };
  return { intents, destination };
}

describe("notification intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canReceive.mockReturnValue(true);
  });

  it("hands one intent per event to every destination", () => {
    const first = recordingDestination();
    const second = recordingDestination();
    const delivery = createNotificationDelivery([first.destination, second.destination]);

    delivery.handleEvent("chat", { state: "delta" });
    delivery.handleEvent(
      "cron",
      {
        action: "finished",
        status: "error",
        jobId: "nightly",
        runId: "run-7",
        job: { name: "Nightly" },
      },
      { agentId: "ops" },
    );

    expect(first.intents).toHaveLength(1);
    expect(second.intents).toEqual(first.intents);
    expect(first.intents[0]).toMatchObject({
      category: "scheduled-task-failed",
      tag: "openclaw-cron-failed-nightly",
      path: "automations?job=nightly&run=run-7",
      agentId: "ops",
      urgency: "high",
      requiredScopes: ["operator.read"],
    });
    expect(renderNotificationCopy(first.intents[0]!, "private").body).toBe(
      "A scheduled task needs attention.",
    );
    expect(renderNotificationCopy(first.intents[0]!, "detailed").body).toBe(
      "Nightly needs attention.",
    );
  });

  it("targets mentions at their recipient with admin visibility", () => {
    const { intents, destination } = recordingDestination();
    const isCurrent = () => true;
    createNotificationDelivery([destination]).deliverMention({
      id: "mention-1",
      recipientProfileId: "bob",
      sessionKey: "agent:research:thread.1",
      agentId: "research",
      senderLabel: "Alice",
      prepare: async () => {},
      isCurrent,
    });

    expect(intents[0]).toMatchObject({
      category: "human-mentioned",
      sessionKeys: ["agent:research:thread.1"],
      requiredScopes: ["operator.read"],
      visibilityScopes: ["operator.admin"],
      recipient: { profileId: "bob", isCurrent },
    });
    expect(renderNotificationCopy(intents[0]!, "identified").body).toBe("Alice mentioned you.");
    expect(renderNotificationCopy(intents[0]!, "private").body).toBe(
      "Someone mentioned you in a conversation.",
    );
  });

  it("names the authorized session label only for session-labelled intents", () => {
    const finished = resolveEventNotificationIntent(
      "chat",
      { state: "final", runId: "run-1" },
      { agentId: "research", sessionKeys: ["agent:research:thread.1"] },
    );
    const approval = approvalNotificationIntent({
      approvalId: "a/1",
      terminal: false,
      agentId: "research",
      canReceive: () => true,
    });

    expect(renderNotificationCopy(finished!, "identified").body).toBe(
      "research: An agent completed its response.",
    );
    expect(renderNotificationCopy(finished!, "identified", "Launch").body).toBe(
      "Launch: An agent completed its response.",
    );
    expect(renderNotificationCopy(finished!, "private", "Launch").body).toBe(
      "An agent completed its response.",
    );
    expect(renderNotificationCopy(approval, "identified", "Launch").body).toBe(
      "Open OpenClaw to review an approval for research.",
    );
    expect(approval).toMatchObject({ path: "approve/a%2F1", tag: "openclaw-approval-a/1" });
  });
});

describe("notification recipient recheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canReceive.mockReturnValue(true);
  });

  it("checks session visibility against the snapshot for session events", () => {
    const intent = resolveEventNotificationIntent(
      "question.requested",
      { id: "q1" },
      { agentId: "research", sessionKeys: ["agent:research:thread.1"] },
    )!;
    const snapshot = { cfg: {}, sessions: new Map() };

    mocks.canReceive.mockReturnValueOnce(false);
    expect(canNotificationRecipientReceive(intent, snapshot, client)).toBe(false);
    expect(canNotificationRecipientReceive(intent, snapshot, client)).toBe(true);
    expect(mocks.canReceive).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cfg: snapshot.cfg,
        client,
        sessionKeys: ["agent:research:thread.1"],
        agentId: "research",
        event: "question.requested",
        prepared: expect.objectContaining({ target: expect.any(Function) }),
      }),
    );
  });

  it("withholds sessionless events under named-role enforcement", () => {
    const intent = resolveEventNotificationIntent("chat", { state: "final", runId: "r" })!;

    expect(canNotificationRecipientReceive(intent, { cfg: {}, sessions: new Map() }, client)).toBe(
      true,
    );
    expect(
      canNotificationRecipientReceive(intent, { cfg: namedRoles, sessions: new Map() }, client),
    ).toBe(false);
    expect(mocks.canReceive).not.toHaveBeenCalled();
  });

  it("opens targeted intents only at their session", () => {
    const mention = mentionIntent({ sessionKey: "" });
    expect(resolveNotificationPath(mention!, {})).toBeUndefined();
    const event = resolveEventNotificationIntent("chat", { state: "final", runId: "r" })!;
    expect(resolveNotificationPath(event, {})).toBe("sessions");
  });
});

function mentionIntent(overrides: { sessionKey: string }) {
  const { intents, destination } = recordingDestination();
  createNotificationDelivery([destination]).deliverMention({
    id: "m",
    recipientProfileId: "bob",
    agentId: "research",
    prepare: async () => {},
    isCurrent: () => true,
    ...overrides,
  });
  return intents[0];
}

describe("notification session facts", () => {
  it("joins producer and session publication, then releases facts", async () => {
    const order: string[] = [];
    const release = vi.fn();
    mocks.prepareFacts.mockResolvedValue({
      prepareRead: () => {
        order.push("session");
        return Promise.resolve();
      },
      readCurrent: () => ({ target: null, membership: new Set() }),
      release,
    });

    const result = await withNotificationSessionFacts(
      { getRuntimeConfig: () => ({}), sessionKeys: ["agent:main:a", "agent:main:a"] },
      async (facts) => {
        await facts.publication(async () => {
          order.push("producer");
        })?.();
        expect(release).not.toHaveBeenCalled();
        return facts.read({}).size;
      },
    );

    expect(result).toBe(1);
    expect(order).toEqual(["producer", "session"]);
    expect(mocks.prepareFacts).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("passes the producer publication through when no session applies", async () => {
    const prepare = async () => {};
    await withNotificationSessionFacts({ getRuntimeConfig: () => ({}) }, async (facts) => {
      expect(facts.publication(prepare)).toBe(prepare);
      expect(facts.publication()).toBeUndefined();
    });
  });
});

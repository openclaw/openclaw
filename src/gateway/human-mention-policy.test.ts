import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { emitUserProfilesChanged } from "../state/user-profile-events.js";
import {
  MAX_MENTION_POLICY_PROFILES_PER_READ,
  MAX_MENTION_POLICY_TARGETS,
  type HumanMentionProfileFacts,
} from "./human-mention-policy-read.types.js";
import { createHumanMentionPolicy, type HumanMentionPreparation } from "./human-mention-policy.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), targets: vi.fn(), assertCurrent: vi.fn() }));
vi.mock("../state/openclaw-state-db-readonly.js", async (original) => ({
  ...(await original<typeof import("../state/openclaw-state-db-readonly.js")>()),
  executeExistingOpenClawStateRead: mocks.read,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    admission: { databasePath: "policy.sqlite", assertCurrent: mocks.assertCurrent },
    environment: {},
  }),
}));
vi.mock("./human-mention-policy-targets.js", () => ({ prepareHumanMentionTargets: mocks.targets }));
// Any accidental synchronous fallback must fail even when a prepared policy otherwise succeeds.
vi.mock("../state/user-profile-list.js", async (original) => ({
  ...(await original<typeof import("../state/user-profile-list.js")>()),
  getUserProfileDisplay: () => {
    throw new Error("host SQL display fallback");
  },
  readUserProfileAliases: () => {
    throw new Error("host SQL alias fallback");
  },
}));

const cfg: OpenClawConfig = {
  agents: { list: [{ id: "main" }] },
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
      },
    },
  },
};
const input = { sessionKey: "agent:main:dashboard:policy", agentId: "main" };
const target = {
  agentId: "main",
  canonicalKey: input.sessionKey,
  storeKey: input.sessionKey,
  storeKeys: [input.sessionKey],
  storePath: "agent.sqlite",
  entry: {
    sessionId: "session",
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id: "alice-old" },
  },
};
const facts = (id: string, aliases = [id]): HumanMentionProfileFacts => ({
  requestedId: id,
  display: {
    kind: "resolved",
    profileId: id,
    label: id,
    avatarUrl: "/avatar/" + id,
    hasUploadedAvatar: false,
  },
  role: "reader",
  aliases,
});
const policies: ReturnType<typeof createHumanMentionPolicy>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    ok: true,
    type: "mentions.policy",
    result: {
      profiles: [facts("alice", ["alice", "alice-old"]), facts("bob", ["bob", "bob-old"])],
    },
  });
  mocks.targets.mockResolvedValue([target]);
});
afterEach(() => {
  for (const policy of policies.splice(0)) {
    policy.dispose();
  }
});
function fixture(getRetainedPreparation?: () => HumanMentionPreparation) {
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: "alice",
      displayName: "Alice",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  const policy = createHumanMentionPolicy({
    getRuntimeConfig: () => cfg,
    getClients: () => [client],
    getRetainedPreparation,
  });
  policies.push(policy);
  return { client, policy, preparation: { profileIds: ["bob"], targets: [input] } };
}

it("selects exact prepared roles, displays and creator aliases without synchronous storage", async () => {
  const { client, policy, preparation } = fixture();
  await policy.prepare(preparation);
  expect(policy.needsPreparation(preparation)).toBe(false);
  expect(policy.validateRecipients(client, input, ["bob"])).toEqual({ ok: true, value: ["bob"] });
  expect(
    policy.recipientProfile(
      "bob",
      {
        agentId: "main",
        sessionKey: input.sessionKey,
        entry: {
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "bob-old" },
        },
      },
      cfg,
    )?.profileId,
  ).toBe("bob");
  expect(
    policy.recipientProfile(
      "bob",
      {
        agentId: "main",
        sessionKey: input.sessionKey,
        entry: { visibility: "draft", createdActor: { type: "agent", id: "bob-old" } },
      },
      cfg,
    ),
  ).toBeUndefined();
  expect(mocks.read).toHaveBeenCalledTimes(1);
  client.invalidated = true;
  expect(policy.validateRecipients(client, input, ["bob"])).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});

it("rejects stale worker replies and requires preparation again after publication", async () => {
  const { policy, preparation } = fixture();
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = policy.prepare(preparation);
  emitUserProfilesChanged();
  finish({
    ok: true,
    type: "mentions.policy",
    result: { profiles: [facts("alice"), facts("bob")] },
  });
  await pending;
  expect(policy.needsPreparation(preparation)).toBe(true);
  expect(policy.readProfile("bob")).toBeUndefined();
  expect(() => policy.resolveTarget(input)).toThrow("has not been prepared");
  await policy.prepare(preparation);
  expect(policy.needsPreparation(preparation)).toBe(false);
  sessionChanges.emit({ sessionKey: input.sessionKey });
  expect(() => policy.resolveTarget(input)).toThrow("has not been prepared");
});

it("invalidates role facts and rejects disposed or replaced source admission", async () => {
  const { policy, preparation } = fixture();
  await policy.prepare(preparation);
  invalidateOperatorRolePolicy("bob");
  expect(policy.needsPreparation(preparation)).toBe(true);
  expect(policy.readProfile("bob")).toBeUndefined();
  await policy.prepare(preparation);
  mocks.assertCurrent.mockImplementation(() => {
    throw new Error("source replaced");
  });
  expect(() => policy.resolveTarget(input)).toThrow("source replaced");
  mocks.assertCurrent.mockReset();
  policy.dispose();
  expect(policy.readProfile("alice")).toBeUndefined();
  expect(() => policy.resolveTarget(input)).toThrow("has not been prepared");
});

it("batches a retained cohort beyond the old cache ceiling and prunes only unowned facts", async () => {
  const retained: HumanMentionPreparation = {
    profileIds: Array.from(
      { length: MAX_MENTION_POLICY_PROFILES_PER_READ * 3 + 1 },
      (_, index) => "retained-" + index,
    ),
    targets: [input],
  };
  const { policy } = fixture(() => retained);
  mocks.read.mockImplementation(async (_context, request) => ({
    ok: true,
    type: "mentions.policy",
    result: {
      profiles: [
        ...request.input.profileIds.map((id: string) => ({
          ...facts(id + "-canonical", [id + "-canonical", id, id + "-creator-alias"]),
          requestedId: id,
        })),
        ...(request.input.directory ? [facts("directory-person")] : []),
      ],
      ...(request.input.directory
        ? { directory: { profiles: [{ id: "directory-person", logins: [] }], truncated: false } }
        : {}),
    },
  }));
  const preparation = { directory: true, profileIds: ["operation-only"] };
  await policy.prepare(preparation);
  expect(mocks.read).toHaveBeenCalledTimes(4);
  expect(mocks.read.mock.calls.map((call) => call[1].input.profileIds.length)).toEqual([
    MAX_MENTION_POLICY_PROFILES_PER_READ,
    MAX_MENTION_POLICY_PROFILES_PER_READ,
    MAX_MENTION_POLICY_PROFILES_PER_READ,
    3,
  ]);
  expect(policy.needsPreparation(preparation)).toBe(false);
  expect(policy.readProfile("retained-0")?.profileId).toBe("retained-0-canonical");
  expect(policy.readProfile("retained-0-canonical")?.profileId).toBe("retained-0-canonical");
  expect(
    policy.recipientProfile(
      "retained-0",
      {
        agentId: "main",
        entry: {
          visibility: "draft",
          createdActor: {
            type: "human",
            source: "profile",
            id: "retained-0-creator-alias",
          },
        },
      },
      cfg,
    )?.profileId,
  ).toBe("retained-0-canonical");
  expect(policy.needsPreparation()).toBe(false);
  expect(policy.readProfile("operation-only")).toBeUndefined();
  expect(policy.readProfile("operation-only-canonical")).toBeUndefined();
  expect(policy.readProfile("directory-person")?.profileId).toBe("directory-person");
  expect(policy.readProfile("alice")?.profileId).toBe("alice-canonical");
  expect(policy.resolveTarget(input)).toEqual(target);
  expect(mocks.read).toHaveBeenCalledTimes(4);
  retained.profileIds = [];
  retained.targets = [];
  expect(policy.needsPreparation()).toBe(false);
  expect(policy.readProfile("retained-0")).toBeUndefined();
  expect(policy.readProfile("retained-0-canonical")).toBeUndefined();
  expect(() => policy.resolveTarget(input)).toThrow("has not been prepared");
});

it("revalidates earlier physical-target batches before publishing any target", async () => {
  const { policy } = fixture();
  const targets = Array.from({ length: MAX_MENTION_POLICY_TARGETS + 1 }, (_, index) => ({
    sessionKey: "agent:main:capacity-" + index,
    agentId: "main",
  }));
  let replaced = false;
  const authority = () => {
    if (replaced) {
      throw new Error("physical source replaced");
    }
  };
  const dispose = vi.fn();
  mocks.targets.mockImplementation(async (_cfg, inputs, capture) => {
    if (inputs.length === MAX_MENTION_POLICY_TARGETS) {
      capture({ assertCurrent: authority, dispose });
    } else {
      replaced = true;
    }
    return inputs.map(() => target);
  });
  await expect(policy.prepare({ targets })).rejects.toThrow("physical source replaced");
  expect(mocks.targets.mock.calls.map((call) => call[1].length)).toEqual([
    MAX_MENTION_POLICY_TARGETS,
    1,
  ]);
  expect(() => policy.resolveTarget(targets[0]!)).toThrow("has not been prepared");
  expect(dispose).toHaveBeenCalledOnce();
});

it.each(["profile", "role"] as const)(
  "discards the whole cohort after a %s change between batches",
  async (change) => {
    const { policy } = fixture();
    const preparation = {
      profileIds: Array.from(
        { length: MAX_MENTION_POLICY_PROFILES_PER_READ + 1 },
        (_, index) => "batch-" + index,
      ),
    };
    let reads = 0;
    mocks.read.mockImplementation(async (_context, request) => {
      if (++reads === 2) {
        if (change === "profile") {
          emitUserProfilesChanged();
        } else {
          invalidateOperatorRolePolicy("alice");
        }
      }
      return {
        ok: true,
        type: "mentions.policy",
        result: { profiles: request.input.profileIds.map((id: string) => facts(id)) },
      };
    });
    await policy.prepare(preparation);
    expect(policy.needsPreparation(preparation)).toBe(true);
    expect(policy.readProfile("batch-0")).toBeUndefined();
    expect(policy.readProfile("alice")).toBeUndefined();
    await policy.prepare(preparation);
    expect(policy.needsPreparation(preparation)).toBe(false);
    expect(policy.readProfile("batch-0")?.profileId).toBe("batch-0");
    expect(reads).toBe(4);
  },
);

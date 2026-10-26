import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { CronStoredJob } from "../../../cron/types.js";

const mocks = vi.hoisted(() => ({
  jobs: [] as Array<{
    id: string;
    definition: Record<string, unknown> | null;
    invalidReason?: string;
  }>,
  sessions: new Map<string, unknown>(),
  profiles: new Set<string>(),
  roles: new Map<string, string>(),
  readSession: vi.fn(),
  note: vi.fn<(message: string, title?: string) => void>(),
}));

vi.mock("../../../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/terminal-core/src/note.js")>()),
  note: mocks.note,
}));

vi.mock("./store-repair.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store-repair.js")>()),
  inspectCronJobsForDoctor: async () => ({
    jobs: mocks.jobs.map((job, sortOrder) => ({
      storeKey: "store",
      sortOrder,
      definitionJson: JSON.stringify(job.definition),
      ...job,
    })),
  }),
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../config/sessions/session-entry-read-runtime.js")
  >()),
  readSessionEntryReadOnlyInWorker: mocks.readSession,
}));

vi.mock("../../../state/openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/openclaw-state-db-readonly.js")>()),
  executeExistingOpenClawStateRead: async (_options: unknown, command: { profileId: string }) => ({
    type: "userProfiles.reconcile",
    profile: mocks.profiles.has(command.profileId)
      ? { id: command.profileId, role: mocks.roles.get(command.profileId) ?? null }
      : undefined,
  }),
}));

const { noteScheduledContextReport } = await import("./execution-context-check.js");

const PARENT = "agent:main:dashboard:parent";
const GONE = { sessionKey: "agent:main:dashboard:gone", sessionId: "gone-session" };

function jobRow(id: string, overrides: Partial<CronStoredJob> = {}) {
  return {
    id,
    definition: {
      id,
      agentId: "main",
      name: id,
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["read"] },
      delivery: { mode: "none" },
      sourceConversation: { sessionKey: PARENT, sessionId: "parent-session" },
      ...overrides,
    },
  };
}

const parent: Partial<SessionEntry> = { sessionId: "parent-session", chatType: "direct" };

beforeEach(() => {
  mocks.jobs = [];
  mocks.sessions = new Map([[PARENT, parent]]);
  mocks.profiles = new Set(["profile-1"]);
  mocks.roles = new Map();
  mocks.readSession.mockReset();
  mocks.note.mockReset();
  mocks.readSession.mockImplementation(async ({ sessionKey }: { sessionKey: string }) =>
    mocks.sessions.get(sessionKey),
  );
});

function roleConfig(): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "member",
        definitions: {
          member: { sessions: { others: "none" }, agents: "*", scopes: ["operator.write"] },
          contractor: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.write"],
            sandbox: "required",
          },
        },
      },
    },
  } as OpenClawConfig;
}

const profileActor = { type: "human", source: "profile", id: "profile-1" } as const;

async function noteText(cfg: OpenClawConfig): Promise<string | null> {
  await noteScheduledContextReport({ cfg });
  expect(mocks.note.mock.calls.length).toBeLessThanOrEqual(1);
  const call = mocks.note.mock.calls[0];
  if (!call) {
    return null;
  }
  expect(call[1]).toBe("Cron");
  expect(call[0]).toEqual(expect.any(String));
  return call[0];
}

describe("noteScheduledContextReport", () => {
  it("checks a profile requester against the stored profile and the role rule", async () => {
    mocks.jobs = [jobRow("current", { createdActor: profileActor })];
    expect(await noteText({})).toBeNull();

    const tiered = await noteText(roleConfig());
    expect(tiered).toContain(
      "- current (current): owner-only tools such as sessions, portal, nodes, gateway and plugins",
    );
    expect(tiered).not.toContain("Doctor could not verify it");

    mocks.note.mockClear();
    mocks.profiles.clear();
    const removed = await noteText({});
    expect(removed).toContain(
      "- current (current): owner-only tools such as sessions, portal, nodes, gateway and plugins",
    );
    expect(removed).not.toContain("Doctor could not verify it");
  });

  it("applies the creator role's sandbox from the stored profile role", async () => {
    mocks.jobs = [jobRow("sandboxed", { createdActor: profileActor })];
    mocks.roles.set("profile-1", "contractor");
    const text = await noteText(roleConfig());
    // Today's runs already sandbox this creator, so the sandbox is not a loss.
    expect(text?.split("\n")).toContain(
      "- sandboxed (sandboxed): owner-only tools such as sessions, portal, nodes, gateway and plugins (the creator is not currently an owner)",
    );
    expect(text).not.toContain("unsandboxed execution");
    expect(text).not.toContain("could not be evaluated");
  });

  it("accepts a configured channel owner", async () => {
    mocks.jobs = [
      jobRow("channel", {
        toolsAllowProvenance: {
          version: 1,
          source: "authenticated-requester",
          channelRequester: {
            version: 1,
            channel: "telegram",
            accountId: "default",
            senderId: "42",
          },
        },
      }),
    ];
    const cfg = { commands: { ownerAllowFrom: ["telegram:42"] } } as OpenClawConfig;
    expect(await noteText(cfg)).toBeNull();
  });

  it("reads the parent row read-only and reports an archived parent as a pause", async () => {
    mocks.jobs = [jobRow("archived", { createdActor: profileActor })];
    mocks.sessions.set(PARENT, { ...parent, archivedAt: 1 });
    expect(await noteText({})).toContain(`- archived (archived): \`${PARENT}\` is archived`);
    expect(mocks.readSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionKey: PARENT, readConsistency: "latest" }),
    );
  });

  it("reports a parent without a chat type and skips malformed rows", async () => {
    mocks.jobs = [
      jobRow("no-chat-type", { createdActor: profileActor }),
      { id: "broken", definition: null, invalidReason: "invalid-definition-json" },
    ];
    mocks.sessions.set(PARENT, { sessionId: "parent-session" });
    const text = await noteText({});
    expect(text).toContain("a creating conversation with no stored chat type");
    expect(text).toContain(`- no-chat-type (no-chat-type): \`${PARENT}\``);
    expect(text).not.toContain("broken");
    expect(text).not.toContain("could not be evaluated");
    expect(mocks.readSession).toHaveBeenCalledTimes(1);
  });

  it("lists a job whose parent read fails instead of aborting the review", async () => {
    mocks.jobs = [jobRow("unreadable", { createdActor: profileActor }), jobRow("other")];
    mocks.readSession.mockRejectedValueOnce(new Error("store locked"));
    const text = await noteText({});
    expect(text).toContain("- unreadable (unreadable): store locked");
    expect(text).toContain(
      "- other (other): owner-only tools such as sessions, portal, nodes, gateway and plugins",
    );
    expect(mocks.readSession).toHaveBeenCalledTimes(2);
  });

  it("reports only the pause for a main-target job, which runs in the agent's own session", async () => {
    mocks.jobs = [
      jobRow("main-removed", {
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "x" },
        sourceConversation: GONE,
      }),
      jobRow("main-live", { sessionTarget: "main", payload: { kind: "systemEvent", text: "x" } }),
    ];
    mocks.sessions.set(PARENT, { sessionId: "parent-session" });
    const text = await noteText({});
    expect(text).toContain(
      "- main-removed (main-removed): `agent:main:dashboard:gone` was removed",
    );
    expect(text).not.toContain("main-live");
    expect(text).not.toContain("will lose access");
    expect(text).not.toContain("no stored chat type");
    expect(text).not.toContain("could not be evaluated");
  });

  it("never pauses or predicts access changes for a command job", async () => {
    mocks.jobs = [
      jobRow("command-removed", {
        payload: { kind: "command", argv: ["true"] },
        sourceConversation: GONE,
      }),
      jobRow("command-live", { payload: { kind: "command", argv: ["true"] } }),
    ];
    mocks.sessions.set(PARENT, { sessionId: "parent-session" });
    expect(await noteText({})).toBeNull();
    expect(mocks.readSession).toHaveBeenCalledTimes(2);
  });
});

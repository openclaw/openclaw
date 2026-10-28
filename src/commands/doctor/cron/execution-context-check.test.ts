import { beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { CronStoredJob } from "../../../cron/types.js";
import type { PluginDoctorCronJob } from "../../../plugins/doctor-contract-module.js";

const mocks = vi.hoisted(() => ({
  jobs: [] as Pick<PluginDoctorCronJob, "id" | "definition" | "invalidReason">[],
  sessions: new Map<string, unknown>(),
  profiles: new Map<string, string | null>(),
  readSession: vi.fn(),
  note: vi.fn<(message: string, title?: string) => void>(),
}));

vi.mock("../../../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/terminal-core/src/note.js")>()),
  note: mocks.note,
}));

vi.mock("./store-repair.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store-repair.js")>()),
  inspectCronJobsForDoctor: async () => ({ jobs: mocks.jobs }),
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
      ? { id: command.profileId, role: mocks.profiles.get(command.profileId) }
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
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["read"] },
      sourceConversation: { sessionKey: PARENT, sessionId: "parent-session" },
      ...overrides,
    },
  };
}

const parent: Partial<SessionEntry> = { sessionId: "parent-session", chatType: "direct" };

beforeEach(() => {
  mocks.sessions = new Map([[PARENT, parent]]);
  mocks.profiles = new Map([["profile-1", null]]);
  mocks.readSession.mockReset();
  mocks.note.mockReset();
  mocks.readSession.mockImplementation(async ({ sessionKey }: { sessionKey: string }) =>
    mocks.sessions.get(sessionKey),
  );
});

const member: GatewayOperatorRoleDefinition = {
  sessions: { others: "none" },
  agents: "*",
  scopes: ["operator.write"],
};
const roleConfig: OpenClawConfig = {
  gateway: {
    roles: {
      default: "member",
      definitions: {
        member,
        contractor: { ...member, sandbox: "required" },
      },
    },
  },
};

const profileActor = { type: "human", source: "profile", id: "profile-1" } as const;

async function noteText(cfg: OpenClawConfig): Promise<string | null> {
  await noteScheduledContextReport({ cfg });
  return mocks.note.mock.calls[0]?.[0] ?? null;
}

const ownerTools = "owner-only tools such as sessions, portal, nodes, gateway and plugins";

it.each([
  ["owner", null, {}, false],
  ["member", null, roleConfig, true],
  ["removed", undefined, {}, true],
  ["sandboxed", "contractor", roleConfig, true],
] as const)("checks a %s profile requester", async (_kind, role, cfg, losesAccess) => {
  mocks.jobs = [jobRow("current", { createdActor: profileActor })];
  mocks.profiles = new Map(role === undefined ? [] : [["profile-1", role]]);
  const text = await noteText(cfg);
  expect(text).toEqual(losesAccess ? expect.stringContaining(ownerTools) : null);
  expect(text ?? "").not.toMatch(
    /Doctor could not verify it|could not be evaluated|unsandboxed execution/,
  );
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
  expect(await noteText({ commands: { ownerAllowFrom: ["telegram:42"] } })).toBeNull();
});

it("continues a read-only parent review after errors and reports only applicable job warnings", async () => {
  const archivedKey = "agent:main:dashboard:archived";
  const main = { sessionTarget: "main", payload: { kind: "systemEvent", text: "x" } } as const;
  const command = {
    payload: { kind: "command", argv: ["true"] },
  } satisfies Partial<CronStoredJob>;
  mocks.sessions.set(archivedKey, { ...parent, archivedAt: 1 });
  mocks.sessions.set(PARENT, { sessionId: "parent-session" });
  mocks.jobs = [
    jobRow("unreadable", { createdActor: profileActor }),
    jobRow("archived", {
      sourceConversation: { sessionKey: archivedKey, sessionId: "parent-session" },
    }),
    jobRow("no-chat-type", { createdActor: profileActor }),
    jobRow("other"),
    { id: "broken", definition: null, invalidReason: "invalid-definition-json" },
    jobRow("main-removed", { ...main, sourceConversation: GONE }),
    jobRow("main-live", main),
    jobRow("command-removed", { ...command, sourceConversation: GONE }),
    jobRow("command-live", command),
  ];
  mocks.readSession.mockRejectedValueOnce(new Error("store locked"));
  const text = await noteText({});
  expect(text).toContain("- unreadable (unreadable): store locked");
  expect(text).toContain(`- archived (archived): \`${archivedKey}\` is archived`);
  expect(text).toContain("a creating conversation with no stored chat type");
  expect(text).toContain(`- no-chat-type (no-chat-type): \`${PARENT}\``);
  expect(text).toContain(`- other (other): ${ownerTools}`);
  expect(text?.split("\n").filter((line) => line.includes("main-"))).toEqual([
    "- main-removed (main-removed): `agent:main:dashboard:gone` was removed",
  ]);
  expect(text).not.toMatch(/broken|command-/);
  expect(mocks.note).toHaveBeenCalledWith(expect.any(String), "Cron");
  expect(mocks.readSession).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "main", sessionKey: PARENT, readConsistency: "latest" }),
  );
});

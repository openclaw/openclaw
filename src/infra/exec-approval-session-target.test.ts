// Covers approval session target resolution.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionOrigin } from "../config/sessions/types.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  doesApprovalRequestMatchChannelAccountAsync,
  doesApprovalRequestSelectChannelAccountAsync,
  resolveApprovalRequestAccountIdAsync,
  resolveApprovalRequestChannelAccountIdAsync,
} from "./approval-request-account-binding.js";
import {
  resolveApprovalRequestSessionConversation,
  resolveApprovalRequestOriginTargetAsync,
  resolveExecApprovalSessionTargetAsync,
} from "./exec-approval-session-target.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";
import { normalizeLegacySessionEntryDelivery } from "./state-migrations.legacy-session-store.js";

vi.mock("../channels/plugins/session-conversation.js", () => ({
  resolveSessionConversationRef(sessionKey: string | undefined | null) {
    const raw = parseRawSessionConversationRef(sessionKey);
    if (!raw) {
      return null;
    }
    const parsed = parseThreadSessionSuffix(raw.rawId);
    const id = (parsed.baseSessionKey ?? raw.rawId).trim();
    if (!id) {
      return null;
    }
    return {
      channel: raw.channel,
      kind: raw.kind,
      rawId: raw.rawId,
      id,
      threadId: parsed.threadId,
      baseSessionKey: `${raw.prefix}:${id}`,
      baseConversationId: id,
      parentConversationCandidates: parsed.threadId ? [id] : [],
    };
  },
}));

const baseRequest: ExecApprovalRequest = {
  id: "req-1",
  request: { command: "echo hello", sessionKey: "agent:main:main" },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

function selectAccount(
  options: Partial<Parameters<typeof doesApprovalRequestSelectChannelAccountAsync>[0]> = {},
) {
  return doesApprovalRequestSelectChannelAccountAsync({
    cfg: {},
    request: baseRequest,
    channel: "telegram",
    accountId: "default",
    defaultAccountId: "default",
    eligibleAccountIds: ["default"],
    ...options,
  });
}

function forwardingConfig(
  mode: "targets" | "both",
  targets: NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>["targets"],
): OpenClawConfig {
  return { approvals: { exec: { enabled: true, mode, targets } } };
}

describe("native approval account selection", () => {
  it("selects only the sole eligible account when no owner is recorded", async () => {
    expect(await selectAccount()).toBe(true);
    expect(await selectAccount({ eligibleAccountIds: ["default", "ops"] })).toBe(false);
  });

  it("rejects foreign-channel fallback but preserves explicit forwarding", async () => {
    const request = buildRequest({ turnSourceChannel: "whatsapp" });
    const explicitTargetConfig = forwardingConfig("targets", [
      { channel: "telegram", to: "owner" },
    ]);
    expect(await selectAccount({ request })).toBe(false);
    expect(await selectAccount({ cfg: explicitTargetConfig, request })).toBe(true);
  });

  it("selects the recorded account even when several accounts are eligible", async () => {
    const request = buildRequest({
      turnSourceChannel: "telegram",
      turnSourceAccountId: "ops",
    });
    const options = { request, eligibleAccountIds: ["default", "ops"] };
    expect(await selectAccount({ ...options, accountId: "ops" })).toBe(true);
    expect(await selectAccount(options)).toBe(false);
  });

  it("maps unscoped explicit targets to default and preserves scoped targets", async () => {
    const cfg = forwardingConfig("targets", [
      { channel: "telegram", to: "owner" },
      { channel: "telegram", to: "ops-owner", accountId: "ops" },
    ]);
    for (const [accountId, selected] of [
      ["default", true],
      ["ops", true],
      ["other", false],
    ] as const) {
      expect(
        await selectAccount({ cfg, accountId, eligibleAccountIds: ["default", "ops", "other"] }),
      ).toBe(selected);
    }
  });

  it("selects the source account and explicit targets in both mode", async () => {
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          targets: [{ channel: "telegram", accountId: "audit" }],
        },
      },
    } as OpenClawConfig;
    const request = buildRequest({
      turnSourceChannel: "telegram",
      turnSourceAccountId: "ops",
    });

    for (const [accountId, selected] of [
      ["ops", true],
      ["audit", true],
      ["other", false],
    ] as const) {
      expect(
        await selectAccount({
          cfg,
          request,
          accountId,
          eligibleAccountIds: ["ops", "audit", "other"],
        }),
      ).toBe(selected);
    }
  });
});

type SessionEntryFixture = Partial<SessionEntry> & {
  origin?: SessionOrigin;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

async function writeStoreFile(
  storePath: string,
  entries: Record<string, SessionEntryFixture>,
  agentId?: string,
): Promise<OpenClawConfig> {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  await Promise.all(
    Object.entries(entries).map(([sessionKey, entry]) =>
      replaceSessionEntry(
        {
          storePath,
          sessionKey,
          agentId,
        },
        normalizeLegacySessionEntryDelivery({
          sessionId: entry.sessionId ?? sessionKey,
          updatedAt: entry.updatedAt ?? Date.now(),
          ...entry,
        } as SessionEntry),
      ),
    ),
  );
  return { session: { store: storePath } };
}

function buildRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return { ...baseRequest, request: { ...baseRequest.request, ...overrides } };
}

function buildPluginRequest(
  overrides: Partial<PluginApprovalRequest["request"]> = {},
): PluginApprovalRequest {
  return {
    id: "plugin:req-1",
    request: {
      title: "Plugin approval",
      description: "Allow plugin action",
      sessionKey: "agent:main:main",
      ...overrides,
    },
    createdAtMs: 1000,
    expiresAtMs: 6000,
  };
}

async function resolveSlackPluginOriginTarget(params: {
  cfg: OpenClawConfig;
  turnSourceTo: string;
}) {
  return await resolveApprovalRequestOriginTargetAsync({
    cfg: params.cfg,
    request: buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceTo: params.turnSourceTo,
    }),
    channel: "slack",
    accountId: "default",
    resolveTurnSourceTarget: (request) =>
      request.request.turnSourceChannel === "slack" && request.request.turnSourceTo
        ? { to: request.request.turnSourceTo }
        : null,
    resolveSessionTarget: (sessionTarget) => ({ to: sessionTarget.to }),
    targetsMatch: (a, b) => a.to === b.to,
  });
}

describe("exec approval session target", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-exec-approval-session-target-");
  const storeFixture = (entry: SessionEntryFixture) =>
    writeStoreFile(path.join(sessionDirs.make(), "sessions.json"), {
      "agent:main:main": { sessionId: "main", updatedAt: 1, ...entry },
    });
  const resolveTarget = (cfg: OpenClawConfig, request = baseRequest) =>
    resolveExecApprovalSessionTargetAsync({ cfg, request });
  const accountBinding = (cfg: OpenClawConfig, request = baseRequest, channel = "slack") => ({
    cfg,
    request,
    channel,
  });
  it("returns null for blank session keys, missing entries, and unresolved targets", async () => {
    const cfg = await storeFixture({ lastChannel: "slack" });

    const requests = [
      buildRequest({ sessionKey: "  " }),
      buildRequest({ sessionKey: "agent:main:missing" }),
      baseRequest,
    ] satisfies ExecApprovalRequest[];

    for (const request of requests) {
      expect(await resolveTarget(cfg, request)).toBeNull();
    }
  });

  it("prefers turn-source routing over stale session delivery state", async () => {
    const cfg = await storeFixture({ lastChannel: "slack", lastTo: "U1" });

    expect(
      await resolveExecApprovalSessionTargetAsync({
        cfg,
        request: baseRequest,
        turnSourceChannel: " whatsapp ",
        turnSourceTo: " +15555550123 ",
        turnSourceAccountId: " work ",
        turnSourceThreadId: "1739201675.123",
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "+15555550123",
      accountId: "work",
      threadId: "1739201675.123",
    });
  });

  it.each([
    {
      name: "uses the parsed session-key agent id for store-path placeholders",
      relativeStoreDir: "helper",
      request: buildRequest({ sessionKey: "agent:helper:main" }),
      expected: {
        channel: "discord",
        to: "channel:123",
        accountId: "work",
        threadId: "777888999111222333",
      },
    },
    {
      name: "falls back to request agent id for legacy session keys",
      relativeStoreDir: "worker-1",
      request: buildRequest({
        agentId: "Worker 1",
        sessionKey: "legacy-main",
      }),
      expected: {
        channel: "telegram",
        to: "-100123",
        accountId: undefined,
        threadId: 77,
      },
    },
  ])("$name", async ({ relativeStoreDir, request, expected }) => {
    const tmpDir = sessionDirs.make();
    const cfg = await writeStoreFile(
      path.join(tmpDir, relativeStoreDir, "sessions.json"),
      {
        [request.request.sessionKey!]: {
          sessionId: relativeStoreDir === "helper" ? "main" : "legacy-main",
          updatedAt: 1,
          lastChannel: expected.channel,
          lastTo: expected.to,
          lastAccountId: expected.accountId ? " Work " : undefined,
          lastThreadId: expected.threadId,
        },
      },
      relativeStoreDir,
    );
    cfg.session = { store: path.join(tmpDir, "{agentId}", "sessions.json") };
    expect(await resolveTarget(cfg, request)).toEqual(expected);
  });

  it("ignores session conversation fallbacks for other channels", () => {
    const request = buildPluginRequest({
      sessionKey: "agent:main:matrix:channel:!ops:example.org",
    });

    expect(
      resolveApprovalRequestSessionConversation({
        request,
        channel: "slack",
      }),
    ).toBeNull();
  });

  it("rejects mismatched channel bindings before account checks", async () => {
    const cfg = {};
    const request = buildRequest({
      turnSourceChannel: "discord",
      turnSourceAccountId: "work",
    });

    expect(
      await resolveApprovalRequestAccountIdAsync({ cfg, request, channel: "slack" }),
    ).toBeNull();
    expect(
      await doesApprovalRequestMatchChannelAccountAsync({
        cfg,
        request,
        channel: "slack",
        accountId: "work",
      }),
    ).toBe(false);
  });

  it("falls back to the stored session binding when turn source uses another channel", async () => {
    const cfg = await storeFixture({
      origin: { provider: "matrix", accountId: "ops" },
      lastChannel: "matrix",
      lastTo: "channel:C123",
      lastAccountId: "ops",
    });
    const request = buildRequest({
      sessionKey: "agent:main:main",
      turnSourceChannel: "discord",
      turnSourceTo: "channel:D123",
      turnSourceAccountId: "work",
    });

    expect(
      await resolveApprovalRequestAccountIdAsync({ cfg, request, channel: "matrix" }),
    ).toBeNull();
    expect(
      await resolveApprovalRequestChannelAccountIdAsync({ cfg, request, channel: "matrix" }),
    ).toBe("ops");
  });

  it.each([
    ["stored", {}, "ops"],
    ["explicit", { turnSourceChannel: "slack", turnSourceAccountId: "work" }, "work"],
  ] as const)("uses the %s account binding", async (_, overrides, accountId) => {
    const cfg = await storeFixture({
      lastChannel: "slack",
      lastTo: "user:U1",
      lastAccountId: "ops",
    });
    const binding = accountBinding(cfg, buildRequest(overrides));
    expect(await resolveApprovalRequestAccountIdAsync(binding)).toBe(accountId);
    expect(await doesApprovalRequestMatchChannelAccountAsync({ ...binding, accountId })).toBe(true);
    if (accountId === "work") {
      expect(
        await doesApprovalRequestMatchChannelAccountAsync({ ...binding, accountId: "other" }),
      ).toBe(false);
    }
  });

  it.each([
    ["matching", "channel:C123", { to: "channel:C123" }],
    ["conflicting", "channel:C999", null],
  ] as const)(
    "reconciles %s plugin turn-source and stored origin targets",
    async (_, turnSourceTo, expected) => {
      const cfg = await storeFixture({ lastChannel: "slack", lastTo: "channel:C123" });
      expect(await resolveSlackPluginOriginTarget({ cfg, turnSourceTo })).toEqual(expected);
    },
  );

  it("falls back to a legacy origin target when no turn-source or session target exists", async () => {
    const target = await resolveApprovalRequestOriginTargetAsync({
      cfg: {},
      request: buildPluginRequest({ sessionKey: "agent:main:missing" }),
      channel: "discord",
      accountId: "default",
      resolveTurnSourceTarget: () => null,
      resolveSessionTarget: () => ({ to: "unused" }),
      targetsMatch: (a, b) => a.to === b.to,
      resolveFallbackTarget: () => ({ to: "channel:legacy" }),
    });

    expect(target).toEqual({ to: "channel:legacy" });
  });
});

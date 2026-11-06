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

async function expectSelections(
  options: Parameters<typeof selectAccount>[0],
  selections: Record<string, boolean>,
) {
  for (const [accountId, selected] of Object.entries(selections)) {
    expect(await selectAccount({ ...options, accountId })).toBe(selected);
  }
}

describe("native approval account selection", () => {
  const source = (channel: string, accountId?: string) =>
    buildRequest({ turnSourceChannel: channel, turnSourceAccountId: accountId });
  const targets = (mode: "targets" | "both", accounts: Array<string | undefined>) =>
    forwardingConfig(
      mode,
      accounts.map((accountId) => ({ channel: "telegram", to: "owner", accountId })),
    );
  it.each([
    ["sole owner", baseRequest, {}, ["default"], ["default"]],
    ["ambiguous owner", baseRequest, {}, ["default", "ops"], []],
    ["foreign source", source("whatsapp"), {}, ["default"], []],
    [
      "explicit foreign forwarding",
      source("whatsapp"),
      targets("targets", [undefined]),
      ["default"],
      ["default"],
    ],
    ["recorded owner", source("telegram", "ops"), {}, ["default", "ops"], ["ops"]],
    [
      "scoped and unscoped targets",
      baseRequest,
      targets("targets", [undefined, "ops"]),
      ["default", "ops", "other"],
      ["default", "ops"],
    ],
    [
      "both mode",
      source("telegram", "ops"),
      targets("both", ["audit"]),
      ["ops", "audit", "other"],
      ["ops", "audit"],
    ],
  ] satisfies Array<[string, ExecApprovalRequest, OpenClawConfig, string[], string[]]>)(
    "selects accounts for %s",
    async (_, request, cfg, eligibleAccountIds, selected) => {
      await expectSelections(
        { request, cfg, eligibleAccountIds },
        Object.fromEntries(eligibleAccountIds.map((id) => [id, selected.includes(id)])),
      );
    },
  );
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
  entry: SessionEntryFixture,
  sessionKey = "agent:main:main",
  agentId?: string,
): Promise<OpenClawConfig> {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  await replaceSessionEntry(
    { storePath, sessionKey, agentId },
    normalizeLegacySessionEntryDelivery({
      sessionId: sessionKey,
      updatedAt: 1,
      ...entry,
    } as SessionEntry),
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

describe("exec approval session target", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-exec-approval-session-target-");
  const storeFixture = (entry: SessionEntryFixture) =>
    writeStoreFile(path.join(sessionDirs.make(), "sessions.json"), { sessionId: "main", ...entry });
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
    [
      "helper",
      buildRequest({ sessionKey: "agent:helper:main" }),
      {
        channel: "discord",
        to: "channel:123",
        accountId: "work",
        threadId: "777888999111222333",
      },
    ],
    [
      "worker-1",
      buildRequest({ agentId: "Worker 1", sessionKey: "legacy-main" }),
      {
        channel: "telegram",
        to: "-100123",
        accountId: undefined,
        threadId: 77,
      },
    ],
  ] as const)(
    "resolves store-path placeholders from parsed or legacy agent: %s",
    async (relativeStoreDir, request, expected) => {
      const tmpDir = sessionDirs.make();
      const cfg = await writeStoreFile(
        path.join(tmpDir, relativeStoreDir, "sessions.json"),
        {
          sessionId: relativeStoreDir === "helper" ? "main" : "legacy-main",
          lastChannel: expected.channel,
          lastTo: expected.to,
          lastAccountId: expected.accountId ? " Work " : undefined,
          lastThreadId: expected.threadId,
        },
        request.request.sessionKey!,
        relativeStoreDir,
      );
      cfg.session = { store: path.join(tmpDir, "{agentId}", "sessions.json") };
      expect(await resolveTarget(cfg, request)).toEqual(expected);
    },
  );

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
    const request = buildRequest({
      turnSourceChannel: "discord",
      turnSourceAccountId: "work",
    });

    const binding = accountBinding({}, request);
    expect(await resolveApprovalRequestAccountIdAsync(binding)).toBeNull();
    expect(
      await doesApprovalRequestMatchChannelAccountAsync({
        ...binding,
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
      turnSourceChannel: "discord",
      turnSourceTo: "channel:D123",
      turnSourceAccountId: "work",
    });

    const binding = accountBinding(cfg, request, "matrix");
    expect(await resolveApprovalRequestAccountIdAsync(binding)).toBeNull();
    expect(await resolveApprovalRequestChannelAccountIdAsync(binding)).toBe("ops");
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
      expect(
        await resolveApprovalRequestOriginTargetAsync({
          cfg,
          request: buildPluginRequest({ turnSourceChannel: "slack", turnSourceTo }),
          channel: "slack",
          accountId: "default",
          resolveTurnSourceTarget: (request) =>
            request.request.turnSourceChannel === "slack" && request.request.turnSourceTo
              ? { to: request.request.turnSourceTo }
              : null,
          resolveSessionTarget: (target) => ({ to: target.to }),
          targetsMatch: (a, b) => a.to === b.to,
        }),
      ).toEqual(expected);
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

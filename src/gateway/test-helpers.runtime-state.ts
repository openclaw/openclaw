import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { AgentBinding } from "../config/types.agents.js";
import type { HooksConfig } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RunCronAgentTurnResult } from "../cron/isolated-agent/run.types.js";
import type { TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { resolveGatewayTestFileFixture } from "./server-file-fixtures.test-support.js";

export type GetReplyFromConfigFn = (
  ctx: MsgContext,
  opts?: InternalGetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
type CronIsolatedRunFn = (...args: unknown[]) => Promise<RunCronAgentTurnResult>;
type AgentCommandResult = Awaited<
  ReturnType<(typeof import("../agents/agent-command.js"))["agentCommand"]>
>;
type AgentCommandFn = (...args: unknown[]) => Promise<AgentCommandResult | void>;
type SendWhatsAppFn = (...args: unknown[]) => Promise<{ messageId: string; toJid: string }>;
export type RunBtwSideQuestionFn = (...args: unknown[]) => Promise<unknown>;
type DispatchInboundMessageFn = (
  ...args: Parameters<typeof import("../auto-reply/dispatch.js").dispatchInboundMessage>
) => Promise<unknown>;
type CompactEmbeddedAgentSessionFn = (...args: unknown[]) => Promise<unknown>;

const GATEWAY_TEST_CONFIG_ROOT_KEY = Symbol.for("openclaw.gatewayTestHelpers.configRoot");

// Typed defaults keep mutable fixture fields wide without duplicating their full shape.
const initial = <T>(value: T): T => value;

const mutableValue = <T>(value: T) => ({ value });

export function createGatewayTestState() {
  return {
    agentConfig: initial<Record<string, unknown> | undefined>(undefined),
    agentsConfig: initial<Record<string, unknown> | undefined>(undefined),
    bindingsConfig: initial<AgentBinding[] | undefined>(undefined),
    channelsConfig: initial<Record<string, unknown> | undefined>(undefined),
    sessionStorePath: initial<string | undefined>(undefined),
    sessionConfig: initial<Record<string, unknown> | undefined>(undefined),
    allowFrom: initial<string[] | undefined>(undefined),
    cronStorePath: initial<string | undefined>(undefined),
    cronEnabled: initial<boolean | undefined>(false),
    cronTriggersEnabled: initial<boolean | undefined>(undefined),
    gatewayBind: initial<"auto" | "lan" | "tailnet" | "loopback" | undefined>(undefined),
    gatewayAuth: initial<Record<string, unknown> | undefined>(undefined),
    gatewayControlUi: initial<Record<string, unknown> | undefined>(undefined),
    hooksConfig: initial<HooksConfig | undefined>(undefined),
    legacyIssues: new Array<{ path: string; message: string }>(),
    legacyParsed: initial<Record<string, unknown>>({}),
    migrationConfig: initial<Record<string, unknown> | null>(null),
    migrationChanges: new Array<string>(),
  };
}

const gatewayTestHoisted = resolveGatewayTestFileFixture(
  Symbol.for("openclaw.gatewayTestHelpers.hoisted"),
  () => ({
    testTailnetIPv4: mutableValue<string | undefined>(undefined),
    agentDiscoveryMock: {
      enabled: false,
      discoverCalls: 0,
      models: new Array<Omit<ModelCatalogEntry, "name"> & { name?: string }>(),
    },
    cronIsolatedRun: vi.fn<CronIsolatedRunFn>(async () => ({ status: "ok", summary: "ok" })),
    agentCommand: vi.fn<AgentCommandFn>().mockResolvedValue(undefined),
    runBtwSideQuestion: vi.fn<RunBtwSideQuestionFn>().mockResolvedValue(undefined),
    dispatchInboundMessage: vi.fn<DispatchInboundMessageFn>(),
    testIsNixMode: { value: false },
    embeddedRunMock: {
      activeIds: new Set<string>(),
      abortCalls: new Array<string>(),
      waitCalls: new Array<string>(),
      waitResults: new Map<string, boolean>(),
      endWaitCalls: new Array<string>(),
      endWaiters: new Map<string, (ended: boolean) => void>(),
      resolveEndBeforeTimeoutIds: new Set<string>(),
      compactEmbeddedAgentSession: vi.fn<CompactEmbeddedAgentSessionFn>().mockResolvedValue({
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 120,
          tokensAfter: 80,
        },
      }),
    },
    testTailscaleWhois: {
      ...mutableValue<TailscaleWhoisIdentity | null>(null),
      calls: new Array<{
        ip: string;
        opts?: { timeoutMs?: number; cacheTtlMs?: number; errorTtlMs?: number };
      }>(),
    },
    getReplyFromConfig: vi.fn<GetReplyFromConfigFn>().mockResolvedValue(undefined),
    sendWhatsAppMock: vi
      .fn<SendWhatsAppFn>()
      .mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
    testState: createGatewayTestState(),
  }),
);

export function getGatewayTestHoistedState() {
  return gatewayTestHoisted;
}

export const testTailnetIPv4 = gatewayTestHoisted.testTailnetIPv4;
export const testTailscaleWhois = gatewayTestHoisted.testTailscaleWhois;
export const agentDiscoveryMock = gatewayTestHoisted.agentDiscoveryMock;
export const cronIsolatedRun = gatewayTestHoisted.cronIsolatedRun;
export const agentCommandMock = gatewayTestHoisted.agentCommand;
export const dispatchInboundMessageMock = gatewayTestHoisted.dispatchInboundMessage;
export const gatewayReplyMock = gatewayTestHoisted.getReplyFromConfig;
export const mockGetReplyFromConfigOnce = (impl: GetReplyFromConfigFn) => {
  gatewayReplyMock.mockImplementationOnce(impl);
};
export const sendWhatsAppMock = gatewayTestHoisted.sendWhatsAppMock;
export const testState = gatewayTestHoisted.testState;
export const testIsNixMode = gatewayTestHoisted.testIsNixMode;
export const embeddedRunMock = gatewayTestHoisted.embeddedRunMock;

export const testConfigRoot = resolveGatewayTestFileFixture(GATEWAY_TEST_CONFIG_ROOT_KEY, () => ({
  value: path.join(os.tmpdir(), `openclaw-gateway-test-${process.pid}-${crypto.randomUUID()}`),
}));

export function setTestConfigRoot(root: string): void {
  testConfigRoot.value = root;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
}

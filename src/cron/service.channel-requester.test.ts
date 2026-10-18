import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  captureCronRequesterGrantIssuer,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../agents/cron-creator-authority-context.js";
import {
  consumeCronCreatorAuthorityGrant,
  resolveCronCreatorAuthorityGrantProvenance,
} from "../gateway/cron-creator-authority-grant.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../gateway/mcp-grant-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronToolsAllowProvenance } from "./types.js";

let cron: CronService;
let storePath: string;

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-channel-requester-",
});

beforeEach(async () => {
  ({ storePath } = await makeStorePath());
  cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
});
// Teardown hooks run in reverse registration order, before the store is closed.
afterEach(() => cron?.stop());

const readJob = async () => (await loadCronStore(storePath)).jobs[0];

const requesterOwner = {
  agentId: "ops",
  sessionKey: "agent:ops:discord:group:ops",
  accountId: "work",
};
const requesterPolicy = {
  version: 1 as const,
  mode: "account" as const,
  ownerSessionKey: requesterOwner.sessionKey,
  ownerAccountId: requesterOwner.accountId,
};
const channelRequester = {
  version: 1 as const,
  channel: "discord",
  accountId: requesterOwner.accountId,
  senderId: "requester-a",
};
const fullRequesterProvenance: CronToolsAllowProvenance = {
  version: 1,
  source: "final-executable-surface",
  callerOrigin: { kind: "unknown" },
  channelRequester,
};
const nativeProvenance: CronToolsAllowProvenance = {
  version: 1,
  source: "authenticated-requester",
  channelRequester,
};
const fullAuthority = {
  scheduledToolPolicy: requesterPolicy,
  toolsAllowProvenance: fullRequesterProvenance,
};
function expectCappedPolicy(job: CronJob) {
  expect([job.scheduledToolPolicy, job.payload.toolsAllow]).toEqual([requesterPolicy, ["message"]]);
}
const nativeRequester = (
  overrides: Partial<typeof channelRequester> = {},
): CronToolsAllowProvenance => ({
  ...nativeProvenance,
  channelRequester: { ...channelRequester, ...overrides },
});
const localProvenance: CronToolsAllowProvenance = {
  version: 1,
  source: "authenticated-requester",
  callerOrigin: { kind: "local" },
};
const localAuthority = {
  scheduledToolPolicy: requesterPolicy,
  toolsAllowProvenance: localProvenance,
};

const requesterDeclaration = (overrides: Partial<CronJobCreate> = {}): CronJobCreate => ({
  name: "daily report",
  declarationKey: "agent:ops:daily-report",
  displayName: "Daily report",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  owner: requesterOwner,
  sessionKey: requesterOwner.sessionKey,
  payload: { kind: "agentTurn", message: "report", toolsAllow: ["message"] },
  delivery: { mode: "none" },
  ...overrides,
});

it("rejects a minted requester token at commit after its MCP capture is deactivated", async () => {
  const runId = "cron-requester-mcp-commit";
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: requesterOwner.agentId,
      ingress: { kind: "system", boundary: "cron-requester-mcp-test", state: "present" },
    },
  });
  let loopbackToken: string | undefined;
  try {
    const admitted = await admission.admit("gateway", `gateway-${runId}`);
    const delegatedAuthority = expectDefined(
      getAdmittedRunDelegatedAuthority(admitted),
      "live delegated authority",
    );
    const creator = expectDefined(
      createCronCreatorAuthorityCapability(
        runId,
        { kind: "external", channel: channelRequester.channel },
        undefined,
        undefined,
        channelRequester,
      ),
      "native creator scope",
    );
    await runWithCronCreatorAuthorityCapability(creator, async () => {
      const loopback = mintMcpLoopbackClientGrant({
        context: {
          sessionKey: requesterOwner.sessionKey,
          agentId: requesterOwner.agentId,
          runId,
          accountId: requesterOwner.accountId,
          messageProvider: channelRequester.channel,
          senderIsOwner: false,
        },
        runtimeOwnerToken: "cron-requester-mcp-commit-runtime",
        admittedRunContext: admitted,
        cronRequesterGrantIssuer: expectDefined(
          captureCronRequesterGrantIssuer(runId),
          "native requester issuer",
        ),
      });
      loopbackToken = loopback.token;
      const capture = {
        token: loopback.token,
        runtimeOwnerToken: "cron-requester-mcp-commit-runtime",
        captureKey: "cron-requester-capture",
      };
      expect(activateMcpLoopbackClientGrantCapture(capture)).toBeTruthy();
      const resolved = expectDefined(resolveMcpLoopbackClientGrant(capture), "active MCP grant");
      const requesterGrant = expectDefined(resolved.mintCronRequesterGrant, "requester minter")();
      const requester = expectDefined(
        resolveCronCreatorAuthorityGrantProvenance(requesterGrant, runId)?.channelRequester,
        "captured native requester",
      );
      const toolsAllowProvenance = { ...nativeProvenance, channelRequester: requester };
      const commitGuard = vi.fn(() => void consumeCronCreatorAuthorityGrant(requesterGrant));
      const authority = { scheduledToolPolicy: requesterPolicy, toolsAllowProvenance };
      expect(deactivateMcpLoopbackClientGrantCapture(capture)).toBe(true);
      expect(creator).toMatchObject({ active: true, signal: { aborted: false } });
      expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegatedAuthority);
      await expect(cron.add(requesterDeclaration(), { ...authority, commitGuard })).rejects.toThrow(
        "Configured MCP cron authority is no longer active",
      );
      expect(commitGuard).toHaveBeenCalledOnce();
      expect((await loadCronStore(storePath)).jobs).toEqual([]);
      expect(activateMcpLoopbackClientGrantCapture(capture)).toBeTruthy();
      const current = expectDefined(
        resolveMcpLoopbackClientGrant(capture),
        "reactivated MCP grant",
      );
      const freshGrant = expectDefined(current.mintCronRequesterGrant, "fresh requester minter")();
      const retainedGrant = consumeCronCreatorAuthorityGrant(freshGrant);
      const created = await cron.add(requesterDeclaration(), {
        ...authority,
        commitGuard: retainedGrant.assertCurrent,
      });
      expect((await loadCronStore(storePath)).jobs).toMatchObject([
        { id: created.id, toolsAllowProvenance },
      ]);
    });
  } finally {
    if (loopbackToken) {
      revokeMcpLoopbackClientGrant(loopbackToken);
    }
    admission.close();
  }
});

it("persists and rebinds a finite authenticated requester cap", async () => {
  const created = await cron.add(requesterDeclaration(), {
    scheduledToolPolicy: requesterPolicy,
    toolsAllowProvenance: nativeProvenance,
    createdActor: { type: "human", source: "profile", id: "original-session-creator" },
  });
  const stored = (await readJob())!;
  expect(stored.toolsAllowProvenance).toEqual(nativeProvenance);
  expect(stored.payload.toolsAllow).toEqual(["message"]);
  expect(stored.payload.toolsAllowIsDefault).toBeUndefined();
  const nextRequester = { ...channelRequester, senderId: "requester-b" };
  await cron.update(
    created.id,
    { name: "Updated executable instructions" },
    {
      toolsAllowProvenance: nativeRequester(nextRequester),
    },
  );
  const rebound = (await readJob())!;
  expect(rebound.toolsAllowProvenance).toEqual(nativeRequester(nextRequester));
  expect(rebound.owner).toEqual(requesterOwner);
  expectCappedPolicy(rebound);
  expect(rebound.createdActor?.id).toBe("original-session-creator");
  await cron.update(created.id, {
    payload: { kind: "agentTurn", message: "New instructions without a native capture" },
  });
  expect((await readJob())?.toolsAllowProvenance).toBeUndefined();
});

it.each<[string, CronJobPatch, CronJobCreate["trigger"]?, boolean?]>([
  ["model selection", { payload: { kind: "agentTurn", model: "openai/test-model" } }],
  ["schedule", { schedule: { kind: "every", everyMs: 120_000 } }],
  ["delivery target", { delivery: { to: "channel:another", accountId: "work" } }],
  [
    "authored trigger input",
    { state: { triggerState: { destination: "another" } } },
    { script: "return { fire: true }" },
  ],
  [
    "display metadata and runtime progress",
    {
      description: "More context for the operator",
      displayName: "Daily summary",
      state: { lastRunAtMs: 1234, consecutiveErrors: 1 },
    },
    undefined,
    true,
  ],
])("reconciles requester authority for %s", async (_name, patch, trigger, preserves = false) => {
  const created = await cron.add(requesterDeclaration({ trigger }), fullAuthority);
  await cron.update(
    created.id,
    patch,
    preserves ? { toolsAllowProvenance: nativeRequester({ senderId: "requester-b" }) } : undefined,
  );
  const stored = (await readJob())!;
  const { channelRequester: _requester, ...withoutRequester } = fullRequesterProvenance;
  expect(stored.toolsAllowProvenance).toEqual(
    preserves ? fullRequesterProvenance : withoutRequester,
  );
  expectCappedPolicy(stored);
});

it.each(["update", "declaration"] as const)(
  "captures the native requester during %s without clearing captured harness authority",
  async (mutation) => {
    const input = requesterDeclaration();
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const commitGuard = vi.fn();
    const options = { toolsAllowProvenance: nativeProvenance, commitGuard };
    const created = await cron.add(input, {
      scheduledToolPolicy: requesterPolicy,
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "unknown" },
      },
      captureRuntimeAuthority: () => runtimeAuthority,
    });
    const payload = { kind: "agentTurn", message: "updated report" } as const;
    const repeat = () => cron.add({ ...input, payload }, options);
    if (mutation === "update") {
      await cron.update(created.id, { payload }, options);
    } else {
      expect(await repeat()).toMatchObject({
        id: created.id,
        created: false,
        updated: true,
      });
      expect(commitGuard).toHaveBeenCalled();
      commitGuard.mockClear();
      expect(await repeat()).toMatchObject({
        id: created.id,
        created: false,
        updated: false,
      });
    }
    expect(commitGuard).toHaveBeenCalled();
    const stored = (await readJob())!;
    expect(stored.toolsAllowProvenance).toEqual(fullRequesterProvenance);
    expect(stored.runtimeAuthority).toEqual(runtimeAuthority);
    expect(stored.runtimeAuthorityRecoveryRequired).toBeUndefined();
    expect(stored.payload.toolsAllow).toEqual(["message"]);
  },
);

it("keeps native requester facts within the job account during update", async () => {
  const created = await cron.add(requesterDeclaration(), fullAuthority);
  const options = { toolsAllowProvenance: nativeRequester({ accountId: "another-account" }) };
  await cron.update(created.id, { name: "Updated report" }, options);
  const stored = (await readJob())!;
  expect(stored.toolsAllowProvenance?.channelRequester).toBeUndefined();
  expect(stored.toolsAllowProvenance?.source).toBe("final-executable-surface");
  expect(stored.scheduledToolPolicy).toEqual(requesterPolicy);
});

it.each([
  { mutation: "update", mode: "trusted" },
  { mutation: "declaration", mode: "account" },
] as const)(
  "preserves $mode policy across operator tool-runtime transitions through $mutation",
  async ({ mutation, mode }) => {
    const input = requesterDeclaration();
    const created = await cron.add(input, mode === "account" ? fullAuthority : undefined);
    const command: CronJobCreate["payload"] = { kind: "command", argv: ["true"] };
    if (mutation === "update") {
      await cron.update(created.id, { payload: command });
    } else {
      await cron.add({ ...input, payload: { ...command, toolsAllow: ["message"] } });
    }
    const dormant = (await readJob())!;
    expect(dormant.scheduledToolPolicy).toEqual(mode === "account" ? requesterPolicy : undefined);
    expect(dormant.toolsAllowProvenance?.channelRequester).toBeUndefined();
    if (mutation === "update") {
      await cron.update(created.id, { payload: { kind: "agentTurn", message: "report" } });
    } else {
      await cron.add(input);
    }
    const restored = (await readJob())!;
    expect(restored.scheduledToolPolicy).toEqual(
      mode === "account" ? requesterPolicy : { version: 1, mode: "trusted" },
    );
    expect(restored.toolsAllowProvenance?.channelRequester).toBeUndefined();
    expect(restored.payload.toolsAllow).toEqual(["message"]);
  },
);
it("persists local creation, clears executable edits, and permits explicit reauthorization", async () => {
  const created = await cron.add(
    requesterDeclaration({ declarationKey: undefined }),
    localAuthority,
  );
  expect(created.toolsAllowProvenance).toEqual(localProvenance);
  await cron.update(created.id, {
    description: "descriptive only",
    displayName: "Daily report metadata",
  });
  expect((await readJob())?.toolsAllowProvenance).toEqual(localProvenance);
  await cron.update(created.id, {
    payload: { kind: "agentTurn", toolsAllow: ["message"] },
  });
  expect((await readJob())?.toolsAllowProvenance).toEqual(localProvenance);
  await cron.update(created.id, { name: "Changed model context" });
  expect((await readJob())?.toolsAllowProvenance).toBeUndefined();
  await cron.update(
    created.id,
    { payload: { kind: "agentTurn", toolsAllow: ["message"] } },
    { toolsAllowProvenance: localProvenance },
  );
  expect((await readJob())?.toolsAllowProvenance).toEqual(localProvenance);
});

it("does not authorize an unchanged declarative job, but rebinds a changed declaration", async () => {
  const declaration = requesterDeclaration();
  const created = await cron.add(declaration, { scheduledToolPolicy: requesterPolicy });
  expect(created.toolsAllowProvenance).toBeUndefined();
  expect(await cron.add(declaration, localAuthority)).toMatchObject({
    created: false,
    updated: false,
  });
  expect((await readJob())?.toolsAllowProvenance).toBeUndefined();
  expect(
    await cron.add(
      {
        ...declaration,
        payload: { kind: "agentTurn", message: "changed report", toolsAllow: ["message"] },
      },
      localAuthority,
    ),
  ).toMatchObject({ created: false, updated: true });
  expect((await readJob())?.toolsAllowProvenance).toEqual(localProvenance);
});

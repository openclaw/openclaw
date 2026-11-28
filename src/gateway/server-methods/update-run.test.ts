import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../../agents/tools/gateway-tool.js";
import { createMacosAppInstallOwner } from "../../commands/test-runtime-config-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { getUpdateRunAsync, listUpdateRunsAsync } from "../../infra/update-run-reader.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { resolvePrefix } from "../../update/store.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveGatewayScopedTools } from "../tool-resolution.js";

const prepareUpdate = vi.hoisted(() => vi.fn(async () => ({ status: "failed" })));
const install = vi.hoisted((): { root: string; kind: "git" | "package" | "unknown" } => ({
  root: "/tmp/openclaw-checkout",
  kind: "git",
}));
vi.mock("../../update/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../update/run.js")>()),
  prepareUpdate,
}));
const scheduleGatewayRestart = vi.hoisted(() => vi.fn());
vi.mock("../../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart.js")>()),
  scheduleGatewayRestart,
}));
vi.mock("../../infra/update-install-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-install-status.js")>()),
  resolveStartupInstallStatus: async () => ({
    root: install.root,
    status: { root: install.root, installKind: install.kind, packageManager: "pnpm" },
    installReceipt: null,
  }),
}));
// mock-isolation: no OCM manager owns this host's updates; admission otherwise runs for real.
vi.mock("../../infra/ocm-update-client.js", () => ({ resolveOcmUpdateManager: async () => null }));

type PolicyContext = {
  getRuntimeConfig: () => OpenClawConfig;
  broadcast: ReturnType<typeof vi.fn>;
};
const policyHost = vi.hoisted(() => ({
  context: undefined as PolicyContext | undefined,
  payload: undefined as unknown,
}));
// mock-isolation: Keep tool dispatch on this suite's isolated current update handler.
vi.mock("../server-plugin-in-process-dispatch.js", () => ({
  getInProcessGatewayRequestContext: () => policyHost.context,
  dispatchGatewayMethodInProcess: async (_method: string, params: Record<string, unknown>) => {
    const context = expectDefined(policyHost.context, "policy Gateway context");
    const result = await invoke(params, null, context);
    policyHost.payload = result.payload;
    return result.payload;
  },
}));

let policyConfig: OpenClawConfig;
let lifecycle: UpdateCheckLifecycle;
let home: TempHomeEnv;
beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-run-git-");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  install.root = "/tmp/openclaw-checkout";
  install.kind = "git";
  scheduleGatewayRestart.mockClear();
  policyHost.context = undefined;
  policyHost.payload = undefined;
  policyConfig = {};
});
afterEach(async () => {
  await lifecycle.stop();
  clearRuntimeConfigSnapshot();
  await home.restore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  prepareUpdate.mockClear();
});

async function invoke(
  params: object,
  client: unknown = null,
  context: PolicyContext = { getRuntimeConfig: () => ({}), broadcast: vi.fn() },
) {
  const { updateRunHandler } = await import("./update-run.js");
  const respond = vi.fn();
  const { broadcast } = context;
  await updateRunHandler({
    req: { type: "req", id: "1", method: "update.run" },
    params,
    client,
    isWebchatConnect: () => false,
    respond,
    context,
  } as unknown as Parameters<typeof updateRunHandler>[0]);
  expect(respond).toHaveBeenCalledOnce();
  return { respond, payload: respond.mock.calls[0]?.[1], broadcast };
}

async function invokeInstalledUpdate(prepare: (root: string) => Promise<void>) {
  install.root = await fs.mkdtemp(path.join(home.home, "host-owned-"));
  vi.spyOn(
    await import("../../infra/openclaw-root.js"),
    "resolveOpenClawPackageRoot",
  ).mockResolvedValue(install.root);
  const resolveManager = vi.spyOn(
    await import("../../infra/ocm-update-client.js"),
    "resolveOcmUpdateManager",
  );
  await prepare(install.root);

  const { respond, broadcast } = await invoke({});
  expect(resolveManager).not.toHaveBeenCalled();
  expect(await listUpdateRunsAsync()).toEqual([]);
  expect(prepareUpdate).not.toHaveBeenCalled();
  expect(scheduleGatewayRestart).not.toHaveBeenCalled();
  expect(broadcast).not.toHaveBeenCalled();
  return respond;
}

it("refuses an app-owned Gateway update before delegation, history, or restart effects", async () => {
  const installOwner = createMacosAppInstallOwner();
  const respond = await invokeInstalledUpdate(async (root) => {
    await fs.writeFile(
      path.join(root, "openclaw-install-owner.json"),
      JSON.stringify(installOwner),
    );
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
    code: "UNAVAILABLE",
    message: "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    details: { reason: "host-owned-install", installOwner },
    retryable: false,
  });
});

it("refuses immutable activation before manager delegation, history, or preparation", async () => {
  const respond = await invokeInstalledUpdate(async (root) => {
    vi.spyOn(
      await import("../../infra/update-immutable-install.js"),
      "inspectImmutableInstall",
    ).mockResolvedValue({
      root,
      currentPath: path.join(root, "releases", "a".repeat(40)),
      currentSha: "a".repeat(40),
    });
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      details: { reason: "immutable-native-updater-required" },
      message: expect.stringContaining(
        "root installation owner outside the Gateway service cgroup",
      ),
    }),
  );
});

it("refuses before preparing a release when the Gateway may not replace its process", async () => {
  vi.stubEnv("OPENCLAW_NO_RESPAWN", "1");
  const { payload } = await invoke({});
  expect(payload).toMatchObject({ runId: null, ok: false, code: "restart-unavailable" });
  expect(prepareUpdate).not.toHaveBeenCalled();
});

it("shows a Control UI update in the app instead of the conversation", async () => {
  const { payload, broadcast } = await invoke(
    { requester: { channel: INTERNAL_MESSAGE_CHANNEL } },
    {
      connect: {
        client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT },
      },
    },
  );
  expect(payload).toMatchObject({ ok: true, noticeInApp: true });
  expect(payload.acknowledgement).toBeUndefined();
  expect((await getUpdateRunAsync(payload.runId))?.origin.noticeSurface).toBe("app");
  expect(broadcast).toHaveBeenCalledWith(
    "update.run.changed",
    expect.objectContaining({ runId: payload.runId, status: "running" }),
  );
});

it.each(["git", "package"] as const)(
  "applies the %s target a scheduled campaign pinned",
  async (kind) => {
    install.kind = kind;
    const sha = "c".repeat(40);
    const version = "2026.11.6";
    const target =
      kind === "git"
        ? { kind: "git", upstreamRef: "origin/main", upstreamSha: sha, commitsBehind: 1 }
        : { kind: "package", version };
    const bindRun = vi.fn();
    lifecycle.campaign = {
      adopt: () => ({
        status: "adopted",
        campaignId: "campaign-1",
        target,
      }),
      bindRun,
      clear: vi.fn(),
    } as unknown as NonNullable<UpdateCheckLifecycle["campaign"]>;
    const { payload } = await invoke({});
    expect(payload).toMatchObject({ ok: true });
    const run = await getUpdateRunAsync(payload.runId);
    expect(run).toMatchObject({
      trigger: "campaign",
      origin: { campaignId: "campaign-1" },
      target: kind === "git" ? { sha } : { version },
    });
    expect(bindRun).toHaveBeenCalledWith("campaign-1", payload.runId);
    await vi.waitFor(() =>
      expect(prepareUpdate).toHaveBeenCalledWith(
        expect.objectContaining(kind === "git" ? { sha } : { tag: version }),
      ),
    );
  },
);

it("restarts into the prepared release after the requested delay", async () => {
  prepareUpdate.mockResolvedValueOnce({
    status: "pending",
    target: { version: "2.0.0" },
    releaseRoot: "/tmp/release",
  } as never);
  const { payload } = await invoke({ restartDelayMs: 7000 });
  expect(payload).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(scheduleGatewayRestart).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "update.run", delayMs: 7000 }),
    ),
  );
});

it.each(["git", "package"] as const)(
  "refuses a different checkout on a %s Gateway before recording any run",
  async (kind) => {
    install.root = path.join(home.home, "installation-a");
    install.kind = kind;
    await fs.mkdir(install.root);
    if (kind === "git") {
      await runCommandWithTimeout(["git", "init", install.root], { timeoutMs: 10_000 });
    }
    const { payload } = await invoke({
      checkout: { gitCommonDir: path.join(home.home, "installation-b", ".git") },
      acceptCapabilities: true,
    });
    expect(payload).toMatchObject({ runId: null, ok: false, code: "installation-mismatch" });
    expect(payload.message).toContain(install.root);
    expect(payload.message).toContain("Nothing changed.");
    expect(payload.message).toContain(`${install.root}/openclaw.mjs update`);
    expect(await listUpdateRunsAsync()).toEqual([]);
    expect(prepareUpdate).not.toHaveBeenCalled();
  },
);

it("accepts the same Git common directory and passes capability consent to preparation", async () => {
  install.root = path.join(home.home, "installation-a");
  await fs.mkdir(install.root);
  await runCommandWithTimeout(["git", "init", install.root], { timeoutMs: 10_000 });
  await runCommandWithTimeout(
    [
      "git",
      "-C",
      install.root,
      "-c",
      "user.name=Identity Fixture",
      "-c",
      "user.email=identity@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { timeoutMs: 10_000 },
  );
  const commonDir = await fs.realpath(path.join(install.root, ".git"));
  const release = path.join(home.home, "release-worktree");
  await runCommandWithTimeout(["git", "-C", install.root, "worktree", "add", "--detach", release], {
    timeoutMs: 10_000,
  });
  install.root = release;
  const { payload } = await invoke({
    checkout: { gitCommonDir: commonDir },
    acceptCapabilities: true,
  });
  expect(payload).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(prepareUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ acceptCapabilities: true }),
    ),
  );
});

it("retains package identity across release roots and forwards consent", async () => {
  install.kind = "package";
  install.root = path.join(resolvePrefix(), "releases", "installed", "openclaw");
  await fs.mkdir(install.root, { recursive: true });
  const { payload } = await invoke({
    checkout: { packageRoot: path.join(await fs.realpath(resolvePrefix()), "openclaw") },
    acceptCapabilities: true,
  });
  expect(payload).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(prepareUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ runningRoot: install.root, acceptCapabilities: true }),
    ),
  );
});

it("matches a forwarding installation whose launcher marker names a symlinked state path", async () => {
  const prefix = await fs.realpath(
    await fs.mkdir(resolvePrefix(), { recursive: true }).then(() => resolvePrefix()),
  );
  await fs.writeFile(path.join(prefix, "openclaw-launcher.mjs"), "");
  const alias = path.join(home.home, "state-alias");
  await fs.symlink(path.dirname(prefix), alias);
  install.kind = "package";
  install.root = path.join(home.home, "global", "openclaw");
  await fs.mkdir(install.root, { recursive: true });
  await fs.writeFile(
    path.join(install.root, ".openclaw-launcher"),
    path.join(alias, path.basename(prefix), "openclaw-launcher.mjs"),
  );
  const { payload } = await invoke({
    checkout: { packageRoot: path.join(prefix, "openclaw") },
    acceptCapabilities: true,
  });
  expect(payload).toMatchObject({ ok: true });
});
it("prepares package installs through the release path on the stable channel", async () => {
  install.kind = "package";
  const { payload } = await invoke({});
  expect(payload).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(prepareUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        runningRoot: "/tmp/openclaw-checkout",
        channel: "stable",
      }),
    ),
  );
});

it("refuses an unrecognized installation before recording or preparing an update", async () => {
  install.kind = "unknown";
  const { payload } = await invoke({});
  expect(payload).toMatchObject({
    ok: false,
    runId: null,
    code: "unmanaged-package-install",
  });
  expect(prepareUpdate).not.toHaveBeenCalled();
});

async function preparePolicyCase(config: OpenClawConfig) {
  policyConfig = config;
  setRuntimeConfigSnapshot(config);
  install.root = path.join(home.home, "policy-install");
  await fs.mkdir(install.root);
  vi.spyOn(
    await import("../../infra/openclaw-root.js"),
    "resolveOpenClawPackageRoot",
  ).mockResolvedValue(install.root);
  policyHost.context = { getRuntimeConfig: () => policyConfig, broadcast: vi.fn() };
  return vi
    .spyOn(await import("../update-run-notice.runtime.js"), "createUpdateRunNotifier")
    .mockResolvedValue(async () => ({ delivered: false, owned: false }));
}

async function expectPolicyRefusal(payload: unknown, reason: string) {
  expect(payload).toMatchObject({
    runId: null,
    ok: false,
    code: reason,
    result: { status: "skipped", reason },
  });
  expect(await listUpdateRunsAsync()).toEqual([]);
  expect(prepareUpdate).not.toHaveBeenCalled();
  expect(scheduleGatewayRestart).not.toHaveBeenCalled();
  expect(policyHost.context?.broadcast).not.toHaveBeenCalled();
}

async function expectPolicyAccepted(
  payload: unknown,
  requester: object,
  trigger: string,
  sessionKey?: string,
) {
  await vi.waitFor(() => expect(prepareUpdate).toHaveBeenCalledOnce());
  await prepareUpdate.mock.results[0]?.value;
  const runs = await listUpdateRunsAsync();
  expect(runs).toHaveLength(1);
  const run = expectDefined(runs[0], "accepted update run");
  expect(payload).toMatchObject({ ok: true, runId: run.runId });
  expect(run).toMatchObject({ status: "running", trigger, origin: { requester } });
  expect(run.origin.sessionKey).toBe(sessionKey);
  expect(prepareUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ runId: run.runId, runningRoot: install.root }),
  );
  expect(scheduleGatewayRestart).not.toHaveBeenCalled();
}

it.each(["revoked", "reassigned", "unchanged", "webchat", "channel-less"])(
  "uses current owner policy after tool construction: %s",
  async (change) => {
    const notifier = await preparePolicyCase({ commands: { ownerAllowFrom: ["slack:owner"] } });
    const tool = createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" });
    policyConfig = {
      commands: {
        ownerAllowFrom:
          change === "unchanged" ? ["owner"] : change === "revoked" ? [] : ["replacement"],
      },
    };
    setRuntimeConfigSnapshot(policyConfig);
    const channel = change === "webchat" ? "webchat" : "slack";
    const sessionKey = "agent:main:slack:dm:owner:thread:123";
    const result =
      change === "channel-less"
        ? await tool.execute("update", { action: "update.run" })
        : await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey,
              turnSourceChannel: channel,
              turnSourceAccountId: "primary",
              turnSourceTo: "owner",
            },
            () => tool.execute("update", { action: "update.run" }),
          );
    if (change === "revoked" || change === "reassigned") {
      await expectPolicyRefusal(policyHost.payload, "owner_required");
      expect(result.details).toMatchObject({
        ok: false,
        reason: "owner_required",
        message: expect.stringContaining("commands.ownerAllowFrom"),
      });
      expect(notifier).not.toHaveBeenCalled();
    } else {
      await expectPolicyAccepted(
        policyHost.payload,
        change === "channel-less"
          ? { senderId: "owner" }
          : { channel, accountId: "primary", senderId: "owner" },
        change === "channel-less" ? "api" : change === "webchat" ? "control-ui" : "chat",
        change === "channel-less" ? undefined : sessionKey,
      );
      expect(result.details).toMatchObject({ ok: true, status: "ok" });
    }
  },
);

it.each(["slack", "discord"] as const)(
  "executes the prompt-advertised update with the trusted %s requester",
  async (channel) => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { profile: "coding" },
      commands: { ownerAllowFrom: [channel + ":owner"] },
    };
    await preparePolicyCase(config);
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      const sessionKey = "agent:main:" + channel + ":dm:owner";
      const { tools } = await resolveGatewayScopedTools({
        cfg: config,
        sessionKey,
        messageProvider: channel,
        accountId: "primary",
        agentTo: "owner",
        senderIsOwner: true,
        channelContext: { sender: { id: "owner" } },
        surface: "loopback",
      });
      const prompt = buildAgentSystemPrompt({
        workspaceDir: home.home,
        toolNames: tools.map((candidate) => candidate.name),
        runtimeInfo: { channel },
      });
      const action = expectDefined(
        prompt.match(/`gateway`\s+([\w.]+)\s+only for built-in-updater installs/u)?.[1],
        "prompt-advertised update action",
      );
      expect(action).toBe("update.run");
      const tool = expectDefined(
        tools.find((candidate) => candidate.name === "gateway"),
        "Gateway update tool",
      );
      const result = await tool.execute("update", {
        action,
        requesterSenderId: "model-supplied-sender",
      });
      expect(result.details).toMatchObject({ ok: true, status: "ok" });
      await expectPolicyAccepted(
        policyHost.payload,
        { channel, accountId: "primary", senderId: "owner" },
        "chat",
        sessionKey,
      );
    });
  },
);

it.each([
  { source: "chat", restart: true },
  { source: "chat", restart: false },
  { source: "chat", restart: undefined },
  { source: "webchat", restart: false },
  { source: "api", restart: false },
])("honors current commands.restart=$restart for $source", async ({ source, restart }) => {
  const notifier = await preparePolicyCase({
    commands: { ownerAllowFrom: source === "chat" ? ["slack:owner"] : [], restart },
  });
  const requester =
    source === "chat"
      ? { channel: "slack", senderId: "owner" }
      : source === "webchat"
        ? { channel: "webchat" }
        : {};
  const sessionKey = source === "api" ? undefined : "agent:main:slack:dm:owner:thread:123";
  const { payload } = await invoke(
    { requester, sessionKey, deliveryContext: { channel: "slack", to: "owner" } },
    null,
    expectDefined(policyHost.context, "policy Gateway context"),
  );
  if (source === "chat" && restart === false) {
    await expectPolicyRefusal(payload, "restart-disabled");
    expect(payload.message).toContain("commands.restart");
    expect(notifier).not.toHaveBeenCalled();
  } else {
    await expectPolicyAccepted(
      payload,
      requester,
      source === "chat" ? "chat" : source === "api" ? "api" : "control-ui",
      sessionKey,
    );
  }
});

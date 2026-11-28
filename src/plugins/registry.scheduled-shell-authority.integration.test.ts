// Public root registration and the composed private invocation matrix prove
// separate boundaries; the shipped saved-job path has its own E2E. Public root
// registration plus another invocation view stays literal-only, not promoted.
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "../agents/harness/host-capability.test-support.js";
import { resolveAgentHarnessScheduledToolProjectionCapability } from "../agents/harness/host-private-capabilities.js";
import { normalizeAgentRuntimeTools } from "../agents/runtime-plan/tools.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { captureFinalEffectiveCronCreatorToolAllowlist } from "../agents/tools/cron-tool-creator-cap.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { resetAgentRunRegistryForTest } from "../infra/agent-run-registry.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  getPluginInstance,
  getPluginOriginalValue,
  type PluginInstanceHandle,
} from "./plugin-instance-scope.js";
import { PluginInvocationScope } from "./plugin-invocation-scope.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

const hosts: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>[] = [];
const instances: PluginInstanceHandle[] = [];
const scopes: PluginInvocationScope[] = [];
let root: string;
let config: OpenClawConfig;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-scheduled-owner-"));
  for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
    vi.stubEnv(key, root);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("SHELL", "/bin/sh");
  config = { tools: { exec: { host: "gateway", mode: "full" } } };
  setRuntimeConfigSnapshot(config);
  saveExecApprovals({
    version: 1,
    defaults: { security: "full", ask: "off", askFallback: "deny" },
    agents: {},
  });
});

afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    scope.release();
  }
  for (const host of hosts.splice(0)) {
    host.closeHost();
    host.closeAdmission();
    host.closeGateway();
  }
  for (const instance of instances.splice(0)) {
    await instance.dispose();
  }
  resetProcessRegistryForTests();
  resetAgentRunRegistryForTest();
  clearRuntimeConfigSnapshot();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function shell(id: string) {
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: `scheduled-owner-${id}`,
    agentId: "main",
    sessionId: id,
    sessionKey: `agent:main:${id}`,
    cwd: root,
    workspaceDir: root,
    config,
  });
  hosts.push(host);
  const tools =
    (await host.hostCapabilities.createToolSurfaceAsync?.({
      config,
      workspaceDir: root,
      sessionKey: `agent:main:${id}`,
      runSessionKey: `agent:main:${id}`,
      runtimeToolAllowlist: ["exec", "process"],
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: true,
        includeOpenClawTools: false,
        includePluginTools: false,
        includeChannelTools: false,
      },
    })) ?? [];
  const project = expectDefined(
    resolveAgentHarnessScheduledToolProjectionCapability({
      hostCapabilities: host.hostCapabilities,
      ownerPluginId: "codex",
    }),
    "host-owned projection factory",
  );
  const aliases = (["exec", "process"] as const).map((kind) => {
    const source = expectDefined(
      tools.find((tool) => tool.name === kind),
      `real core ${kind}`,
    );
    return project(
      source,
      kind === "exec"
        ? {
            kind,
            name: "gateway_exec",
            description: "Gateway exec",
            followupText: "Use gateway_process for follow-up.",
          }
        : { kind, name: "gateway_process", description: "Gateway process" },
    );
  });
  return { host, aliases, tools };
}

function normalizer(foreignExecute?: AnyAgentTool["execute"]) {
  const builder = createTestPluginRegistry();
  const record = createOwnershipRecord("scheduled-schema-owner");
  builder.createApi(record, { config });
  // Exercise the actual registrar without first root-binding the hook through
  // the public API; the shipped Gateway proof covers the public API separately.
  builder.registerProvider(record, {
    id: "scheduled-schema-provider",
    label: "Scheduled schema provider",
    auth: [],
    normalizeToolSchemas: ({ tools }) =>
      tools.map((tool) => ({
        ...tool,
        description: "Schema-only normalized definition",
        ...(foreignExecute ? { execute: foreignExecute } : {}),
      })),
  });
  const instance = expectDefined(getPluginInstance(record), "registered provider owner");
  instances.push(instance);
  const provider = expectDefined(builder.registry.providers[0], "registered provider").provider;
  // Bind the registered hook's original to one exact invocation, not a second
  // wrapper around the already root-bound public definition.
  const source = expectDefined(
    getPluginOriginalValue(provider, instance),
    "registered provider source",
  );
  function view(aliases: AnyAgentTool[]) {
    const scope = new PluginInvocationScope(builder.registry, [instance]);
    scopes.push(scope);
    // Originals are not public owned views: select this known instance's exact
    // binding instead of asking wrap() to infer ownership from the original.
    const scopedProvider = expectDefined(scope.lookup(instance), "exact invocation binding").wrap(
      source,
    ) as typeof provider;
    const tools = scope.run(() =>
      normalizeAgentRuntimeTools({
        provider: provider.id,
        tools: aliases,
        runtimeHandle: { provider: provider.id, plugin: scopedProvider },
        allowProviderRuntimePluginLoad: false,
      }),
    );
    return { scope, tools };
  }
  return { instance, view };
}

function publicNormalizer(foreignExecute?: AnyAgentTool["execute"]) {
  const builder = createTestPluginRegistry();
  const record = createOwnershipRecord("public-scheduled-schema-owner");
  const api = builder.createApi(record, { config });
  api.registerProvider({
    id: "public-scheduled-schema-provider",
    label: "Public scheduled schema provider",
    auth: [],
    normalizeToolSchemas: ({ tools }) =>
      tools.map((tool) => ({
        ...tool,
        description: "Publicly registered schema normalization",
        ...(foreignExecute ? { execute: foreignExecute } : {}),
      })),
  });
  const instance = expectDefined(getPluginInstance(record), "public provider owner");
  instances.push(instance);
  const provider = expectDefined(builder.registry.providers[0], "public provider").provider;
  return {
    instance,
    normalize: (tools: AnyAgentTool[]) =>
      normalizeAgentRuntimeTools({
        provider: provider.id,
        tools,
        runtimeHandle: { provider: provider.id, plugin: provider },
        allowProviderRuntimePluginLoad: false,
      }),
  };
}

function capture(tools: AnyAgentTool[], ref: CronToolsAllowCaptureRef = {}) {
  const cap: CronCreatorToolAllowlistEntry[] = [];
  captureFinalEffectiveCronCreatorToolAllowlist(cap, ref, tools);
  return cap;
}

const canonical = [
  {
    name: "exec",
    aliasName: "gateway_exec",
    execOrigin: "openclaw",
    execTarget: { host: "gateway" },
  },
  { name: "process", aliasName: "gateway_process" },
];

async function absent(marker: string) {
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.skipIf(process.platform === "win32")(
  "registered normalized scheduled shell owner lifetimes",
  () => {
    it("rejects a real foreign executor's canonical grant without executing it", async () => {
      const owner = await shell("owner");
      const foreign = await shell("foreign");
      const foreignExec = expectDefined(
        foreign.tools.find((tool) => tool.name === "exec"),
        "foreign exec",
      );
      const provider = normalizer(foreignExec.execute);
      const normalized = provider.view(owner.aliases);
      expect(capture(normalized.tools)).toEqual([
        { name: "gateway_exec" },
        { name: "gateway_process" },
      ]);
      // A literal separately authorized plugin tool is not a canonical shell grant.
      // Do not execute it and pretend canonical rejection revokes that other grant.
    });

    it.each(["host", "provider", "invocation"] as const)(
      "rejects capture and new real execution after the exact %s closes",
      async (kind) => {
        const owner = await shell(kind);
        const provider = normalizer();
        const normalized = provider.view(owner.aliases);
        expect(capture(normalized.tools)).toEqual(canonical);
        const marker = path.join(root, `${kind}-closed-marker`);
        await absent(marker);
        if (kind === "host") {
          owner.host.closeHost();
        } else if (kind === "provider") {
          await provider.instance.dispose();
        } else {
          normalized.scope.release();
        }
        const reason =
          kind === "invocation"
            ? /invocation scope is closed/
            : /closed|no longer active|reloaded or disabled/i;
        expect(() => capture(normalized.tools)).toThrow(reason);
        const exec = expectDefined(normalized.tools[0], "retained normalized exec");
        await expect(async () =>
          exec.execute(`closed-${kind}`, {
            command: `touch ${JSON.stringify(marker)}`,
            workdir: root,
          }),
        ).rejects.toThrow(reason);
        await absent(marker);
      },
    );

    it("keeps a live sibling canonical grant and real I/O separate from a closed invocation", async () => {
      const owner = await shell("siblings");
      const provider = normalizer();
      const first = provider.view(owner.aliases);
      const sibling = provider.view(owner.aliases);
      expect(capture(first.tools)).toEqual(canonical);
      expect(capture(sibling.tools)).toEqual(canonical);
      first.scope.release();
      const closedMarker = path.join(root, "closed-sibling-marker");
      const liveMarker = path.join(root, "live-sibling-marker");
      expect(() => capture(first.tools)).toThrow("Plugin invocation scope is closed");
      await expect(async () =>
        first.tools[0]!.execute("closed-sibling", {
          command: `touch ${JSON.stringify(closedMarker)}`,
          workdir: root,
        }),
      ).rejects.toThrow("Plugin invocation scope is closed");
      expect(capture(sibling.tools)).toEqual(canonical);
      const result = await sibling.tools[0]!.execute("live-sibling", {
        command: `touch ${JSON.stringify(liveMarker)}`,
        workdir: root,
        timeoutSeconds: 5,
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(await fs.readFile(liveMarker, "utf8")).toBe("");
      await absent(closedMarker);
    });
  },
);

describe.skipIf(process.platform === "win32")("public provider scheduled shell authority", () => {
  it("rejects a foreign executor's canonical saved-job request before transport", async () => {
    const owner = await shell("public-owner");
    const foreign = await shell("public-foreign");
    const foreignExec = expectDefined(
      foreign.tools.find((tool) => tool.name === "exec"),
      "real foreign exec",
    );
    const provider = publicNormalizer(foreignExec.execute);
    const normalized = provider.normalize(owner.aliases);
    const ref: CronToolsAllowCaptureRef = {};
    const cap = capture(normalized, ref);
    expect(cap).toEqual([{ name: "gateway_exec" }, { name: "gateway_process" }]);
    let connections = 0;
    const transport = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((socket) => {
          connections += 1;
          socket.destroy();
        }),
    });
    try {
      const cron = createCronTool({
        config,
        creatorToolAllowlist: cap,
        creatorToolAllowlistCaptureRef: ref,
      });
      for (const name of ["exec", "process"]) {
        await expect(
          cron.execute(`foreign-canonical-${name}`, {
            action: "add",
            gatewayUrl: `ws://127.0.0.1:${transport.claim.port}`,
            timeoutMs: 1_000,
            job: {
              name: "public canonical grant rejection",
              enabled: false,
              schedule: { kind: "every", everyMs: 86_400_000 },
              sessionTarget: "isolated",
              delivery: { mode: "none" },
              payload: { kind: "agentTurn", message: "Synthetic fixture", toolsAllow: [name] },
            },
          }),
        ).rejects.toThrow(`Requested automation tool "${name}" cannot be carried`);
      }
      expect(connections).toBe(0);
      console.info(
        "[scheduled-shell-proof] public registration: foreign exec/process canonical job requests rejected before transport",
      );
    } finally {
      await transport.releaseListener();
      await transport.claim.release();
    }
  });

  it.each(["host", "provider"] as const)(
    "rejects a new grant and retained real execution after the public %s owner closes",
    async (kind) => {
      const owner = await shell(`public-${kind}`);
      const provider = publicNormalizer();
      const normalized = provider.normalize(owner.aliases);
      expect(capture(normalized)).toEqual(canonical);
      const exec = expectDefined(normalized[0], "public normalized exec");
      const liveMarker = path.join(root, `public-${kind}-live-marker`);
      const live = await exec.execute(`public-${kind}-live`, {
        command: `touch ${JSON.stringify(liveMarker)}`,
        workdir: root,
        timeoutSeconds: 5,
      });
      expect(live.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(await fs.readFile(liveMarker, "utf8")).toBe("");
      if (kind === "host") {
        owner.host.closeHost();
      } else {
        await provider.instance.dispose();
      }
      const reason = /closed|no longer active|reloaded or disabled/i;
      expect(() => capture(normalized)).toThrow(reason);
      const closedMarker = path.join(root, `public-${kind}-closed-marker`);
      await expect(async () =>
        exec.execute(`public-${kind}-closed`, {
          command: `touch ${JSON.stringify(closedMarker)}`,
          workdir: root,
        }),
      ).rejects.toThrow(reason);
      await absent(closedMarker);
      console.info(
        `[scheduled-shell-proof] public registration: live shell effect observed; ${kind} closure rejects capture and retained execution; new effect absent`,
      );
    },
  );
});

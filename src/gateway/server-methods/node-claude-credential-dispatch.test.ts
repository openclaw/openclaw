import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  upsertAuthProfileAsync,
} from "../../agents/auth-profiles/profiles.js";
import {
  CliCredentialRemovedError,
  createCliCredentialUseCheck,
} from "../../agents/cli-runner/auth-profile-preparation-error.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../../infra/node-commands.js";
import { resolveNodeHostGatewayPlatformIdentity } from "../../node-host/gateway-platform-identity.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { invokeNodeClaudeCliRun } from "../node-agent-cli-runtime.js";
import { NodeRegistry } from "../node-registry.js";
import { createTestNodeSocket } from "../node-registry.test-helpers.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { GatewayRequestContext } from "./types.js";

const profileId = "anthropic:node-proof";
const temps = useAutoCleanupTempDirTracker(afterEach);
const registries = new Set<NodeRegistry>();

afterEach(() => {
  for (const registry of registries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  registries.clear();
  vi.unstubAllEnvs();
});

async function pairedNode() {
  const root = temps.make("node-credential-dispatch-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const agentDir = path.join(root, "agents", "main", "agent");
  await upsertAuthProfileAsync({
    profileId,
    agentDir,
    credential: createApiKeyCredential("anthropic", "sk-test"),
  });
  const frames: string[] = [];
  const registry = new NodeRegistry();
  registries.add(registry);
  registry.register(
    {
      connId: "connection-1",
      socket: createTestNodeSocket(frames),
      connect: {
        client: {
          id: "node-host",
          mode: "node",
          version: "test",
          ...resolveNodeHostGatewayPlatformIdentity(process.platform),
        },
        device: { id: "node-1" },
        caps: [],
        commands: [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND],
      },
    } as unknown as GatewayWsClient,
    { pairingIdentity: "node-1", pairingGeneration: "generation-1" },
  );
  const gateway = {
    nodeRegistry: registry,
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
  return { agentDir, frames, registry, gateway };
}

function dispatch(params: {
  gateway: GatewayRequestContext;
  agentDir: string;
  assertReadable?: () => Promise<void>;
}) {
  return withPluginRuntimeGatewayRequestScope(
    { context: params.gateway, isWebchatConnect: () => false },
    () =>
      invokeNodeClaudeCliRun({
        nodeId: "node-1",
        argv: ["-p"],
        stdin: "hello",
        timeoutMs: 5_000,
        idleTimeoutMs: 1_000,
        onProgress: () => {},
        prepareCredentialUse: createCliCredentialUseCheck(profileId, params.agentDir),
        ...(params.assertReadable ? { assertReadable: params.assertReadable } : {}),
      }),
  );
}

it("dispatches a paired-node Claude turn while the saved account remains", async () => {
  const { agentDir, frames, registry, gateway } = await pairedNode();
  const pending = dispatch({ gateway, agentDir });
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  const frame = JSON.parse(frames[0]!) as { payload?: { id?: string }; id?: string };
  const id = frame.payload?.id ?? frame.id;
  expect(id).toBeTruthy();
  expect(
    registry.handleInvokeResult({
      id: id!,
      nodeId: "node-1",
      connId: "connection-1",
      ok: true,
      payload: { exitCode: 0 },
    }),
  ).toBe(true);
  await expect(pending).resolves.toMatchObject({ ok: true });
});

it("does not dispatch after the saved account is removed during history authorization", async () => {
  const { agentDir, frames, gateway } = await pairedNode();
  const pending = dispatch({
    gateway,
    agentDir,
    assertReadable: async () => {
      expect(await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: [profileId] })).toBe(
        true,
      );
    },
  });
  await expect(pending).rejects.toBeInstanceOf(CliCredentialRemovedError);
  expect(frames).toEqual([]);
});

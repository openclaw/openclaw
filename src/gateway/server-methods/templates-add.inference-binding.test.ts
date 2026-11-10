import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { writeConfigFile } from "../../config/io.runtime.js";
import { registerRuntimeConfigWriteListener } from "../../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { acquireCronInferenceAuthorization } from "../../cron/inference-binding.runtime.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../../infra/device-pairing-identity.js";
import { revokeDeviceToken } from "../../infra/device-pairing-tokens.js";
import { clawHubSecurityResponse } from "../../plugins/clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "../../plugins/clawhub.test-support.js";
import { ensureCanonicalGatewayOwnerProfile } from "../../state/user-profile-writes.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "../openclaw-id/tunnel-principal.js";
import { restoreGatewayOperatorSource } from "../operator-run-recovery.js";
import { pairedOperator, persistDevices } from "../operator-run-recovery.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { platformId, withFixture } from "./cron.inference-binding.test-support.js";
import { templatesAddHandlers } from "./templates-add.js";
import type { GatewayClient, RespondFn } from "./types.js";

const registry = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  security: vi.fn(),
  download: vi.fn(),
}));
// mock-isolation: Only remote registry I/O is fixed. Template planning, Add,
// runtime-write receipts, account authorization and scheduler persistence stay real.
vi.mock("../../infra/clawhub-packages.js", async (original) => ({
  ...(await original<typeof import("../../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: registry.detail,
  fetchClawHubPackageArtifact: registry.artifact,
  fetchClawHubPackageSecurity: registry.security,
}));
vi.mock("../../infra/clawhub-artifacts.js", async (original) => ({
  ...(await original<typeof import("../../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: registry.download,
}));
const createArchive = createClawHubArchiveFactory(afterEach);
const packageName = "@openclaw/inference-binding-template";
const version = "1.0.0";
const agentId = "inference-binding-template";
const manifest = `---
schemaVersion: 1
agent: { id: ${agentId} }
automations:
  - id: weekly
    enabled: false
    schedule: { cron: "0 9 * * 1", timezone: UTC }
    session: isolated
    message: Compare public sources.
---
Research public sources.
`;

async function remoteTemplate(files: Record<string, string> = { "CLAW.md": manifest }) {
  const archive = await createArchive({
    "package.json": JSON.stringify({
      name: packageName,
      version,
      openclaw: { template: "CLAW.md" },
    }),
    ...files,
  });
  const sha256 = createHash("sha256")
    .update(await fs.readFile(archive.archivePath))
    .digest("hex");
  registry.detail.mockResolvedValue({
    package: {
      name: packageName,
      displayName: "Inference binding Template",
      updatedAt: 0,
      family: "template",
      channel: "official",
      isOfficial: true,
      ownerHandle: "openclaw",
      latestVersion: version,
    },
    owner: { handle: "openclaw" },
  });
  registry.artifact.mockResolvedValue({
    package: { name: packageName, family: "template" },
    version,
    artifact: { kind: "npm-pack", sha256, npmIntegrity: "sha512-template-fixture" },
  });
  registry.security.mockResolvedValue({
    ...clawHubSecurityResponse(packageName, version, { moderationState: "approved" }),
    package: { name: packageName, family: "template" },
    release: {
      version,
      artifactKind: "npm-pack",
      artifactSha256: sha256,
      npmIntegrity: "sha512-template-fixture",
    },
  });
  registry.download.mockResolvedValue({
    ...archive,
    artifact: "clawpack",
    sha256Hex: sha256,
    npmIntegrity: "sha512-template-fixture",
    cleanup: async () => {},
  });
  return { ...archive, sha256 };
}

type Fixture = Parameters<Parameters<typeof withFixture>[0]>[0];

async function withTemplateRuntime(fixture: Fixture, run: () => Promise<void>) {
  const cfg = fixture.getConfig();
  fixture.publish({
    gateway: { mode: "local", controlUi: { experimental: { templates: true } } },
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        workspace: path.join(process.env.OPENCLAW_STATE_DIR!, "workspaces"),
      },
    },
  });
  await writeConfigFile(fixture.getConfig());
  // Consume the native receipt as the active runtime owner before scheduling.
  const unsubscribe = registerRuntimeConfigWriteListener((event) => {
    const application = getRuntimeConfigWriteApplication(event)?.claim();
    fixture.publish(event.sourceConfig);
    application?.settle("applied");
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
}

function templateContext(fixture: Fixture, client: GatewayClient) {
  const context = createDirectChatContext({
    cron: fixture.getCron(),
    getRuntimeConfig: fixture.getConfig,
    getClientConnIds: (filter) =>
      new Set(
        client.connId && !client.invalidated && (!filter || filter(client)) ? [client.connId] : [],
      ),
  });
  context.resolveGatewayContext = () => context;
  return context;
}

async function addTemplate(
  fixture: Fixture,
  client: GatewayClient,
  context = templateContext(fixture, client),
) {
  // Direct handler fixtures represent an admitted socket; real handshakes are covered by Gateway E2E.
  await ensureCanonicalGatewayOwnerProfile("Synthetic Template owner");
  client.internal = {
    authenticatedOperator: true,
    operatorAccessAuthority: null,
    ...client.internal,
  };
  client.authPolicy ??= captureGatewayAuthPolicy(fixture.getConfig(), {
    role: "operator",
    authMethod: "token",
  });
  if (!client.authenticatedUserProfile) {
    client.internal.operatorRoleActor = { kind: "system" };
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = "template-shared-generation";
    context.sharedGatewaySessionGenerationState = new SharedGatewaySessionGenerationState({
      current: client.sharedGatewaySessionGeneration,
      required: null,
    });
  }
  const params = { source: { packageName, version } };
  const respond = vi.fn<RespondFn>();
  await templatesAddHandlers["templates.add.apply"]!({
    req: { type: "req", id: "template-inference", method: "templates.add.apply", params },
    params,
    respond,
    client,
    context,
    hasCurrentClientAuthority: () => !client.invalidated,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, result, error] = respond.mock.calls[0]!;
  expect(ok, JSON.stringify(error)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /inferenceBinding|authorizationId|synthetic-|openai:platform|model:/,
  );
  return result;
}

it.each([false, true])(
  "fresh Template Add captures the host account privately and refuses replaced authority (replace: %s)",
  async (replace) => {
    await withFixture(async (fixture) => {
      const archive = await remoteTemplate();
      await withTemplateRuntime(fixture, async () => {
        if (replace) {
          fixture.replaceAccountBeforeMutation("add");
        }
        const client: GatewayClient = {
          connId: "template-inference-owner",
          invalidated: false,
          connect: gatewayConnect(["operator.admin"]),
        };
        const result = await addTemplate(fixture, client);
        expect(result, JSON.stringify(result)).toMatchObject({
          agentId,
          status: replace ? "partial" : "complete",
        });
        expect(
          createHash("sha256")
            .update(await fs.readFile(archive.archivePath))
            .digest("hex"),
        ).toBe(archive.sha256);
        if (replace) {
          expect(await fixture.status()).toMatchObject({ jobs: 0 });
          return;
        }
        const stored = await fixture.reload();
        expect(stored).toMatchObject({
          agentId,
          enabled: false,
          inferenceBinding: {
            provider: "openai",
            profileId: platformId,
            authRequirement: "api-key",
            source: "auto",
          },
        });
        expect(stored.payload).not.toHaveProperty("model");
        const publicJob = await fixture.invoke("cron.get", { id: stored.id });
        expect(JSON.stringify(publicJob)).not.toMatch(
          /inferenceBinding|authorizationId|synthetic-/,
        );
        const authority = await acquireCronInferenceAuthorization({
          binding: stored.inferenceBinding!,
          cfg: fixture.getConfig(),
          agentDir: resolveAgentDir(fixture.getConfig(), agentId),
        });
        try {
          await authority.revalidate();
          authority.assertCurrent();
        } finally {
          authority.dispose();
        }
      });
    });
  },
);

it.each([
  "enabled",
  "paused",
  "lost-add-reply",
  "changed-owner",
  "unowned-changed-owner",
  "foreign-account",
] as const)(
  "native profile Template heartbeat preserves captured ownership (%s)",
  async (scenario) => {
    await withFixture(async (fixture) => {
      const personal = await fixture.personalAccount();
      const unowned = scenario === "unowned-changed-owner";
      const ownerChanged = scenario === "changed-owner" || unowned;
      if (!unowned) {
        fixture.setDefaultProfile(personal.profileId);
      }
      const paused = scenario === "paused";
      const scratch = "# Research\n\n- Check public sources.\n";
      await remoteTemplate({
        "CLAW.md": `---\n${JSON.stringify({
          schemaVersion: 1,
          agent: {
            id: agentId,
            heartbeat: { isolatedSession: true, ...(paused ? { every: "0m" } : {}) },
          },
          workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
        })}\n---\nResearch public sources.\n`,
        "HEARTBEAT.md": scratch,
      });
      await withTemplateRuntime(fixture, async () => {
        const cron = fixture.getCron();
        if (scenario === "lost-add-reply") {
          const add = cron.add.bind(cron);
          vi.spyOn(cron, "add").mockImplementationOnce(async (...args) => {
            await add(...args);
            throw new Error("Scheduler reply lost after commit");
          });
        }
        if (ownerChanged) {
          const writeScratch = cron.writeScratch.bind(cron);
          vi.spyOn(cron, "writeScratch").mockImplementationOnce(async (id, params) => {
            const result = await writeScratch(id, params);
            await cron.update(id, {
              ownerProfileId: personal.other.authenticatedUserProfile!.profileId,
            });
            return result;
          });
        }
        const result = await addTemplate(
          fixture,
          unowned
            ? { connId: "unprofiled-owner", connect: gatewayConnect(["operator.admin"]) }
            : scenario === "foreign-account"
              ? personal.other
              : personal.owner,
        );
        if (scenario === "foreign-account") {
          expect(result).toMatchObject({
            status: "partial",
            error: {
              code: "add_failed",
              message:
                "This account action requires a current authorized connection; reconnect and try again.",
            },
          });
          expect(await fixture.status()).toMatchObject({ jobs: 0 });
          return;
        }
        expect(result, JSON.stringify(result)).toMatchObject({
          status: ownerChanged ? "partial" : "complete",
        });
        const stored = await fixture.reload();
        expect(stored).toMatchObject({
          agentId,
          enabled: !paused && !ownerChanged,
          ownerProfileId: (ownerChanged ? personal.other : personal.owner).authenticatedUserProfile!
            .profileId,
          schedule: { kind: "every", everyMs: 1_800_000 },
        });
        expect((await fixture.getCron().readScratch(stored.id)).scratch).toMatchObject({
          content: scratch,
          revision: 1,
        });
        if (!ownerChanged) {
          expect(stored.inferenceBinding).toMatchObject({ profileId: personal.profileId });
        }
        expect(stored.payload).not.toHaveProperty("model");
      });
    });
  },
);

it.each([false, true])(
  "native profile rollback preserves changed ownership (%s)",
  async (change) => {
    await withFixture(async (fixture) => {
      const personal = await fixture.personalAccount();
      await remoteTemplate({
        "CLAW.md": `---\n${JSON.stringify({
          schemaVersion: 1,
          agent: { id: agentId },
          automations: ["first", "second"].map((id) => ({
            id,
            enabled: false,
            schedule: { cron: "0 9 * * 1", timezone: "UTC" },
            session: "isolated",
            message: "Compare public sources.",
          })),
        })}\n---\nResearch public sources.\n`,
      });
      await withTemplateRuntime(fixture, async () => {
        const cron = fixture.getCron();
        const add = cron.add.bind(cron);
        vi.spyOn(cron, "add").mockImplementation(async (input, options) => {
          if (input.name === "second") {
            if (change) {
              const [first] = await cron.list({ includeDisabled: true });
              await cron.update(first!.id, {
                ownerProfileId: personal.other.authenticatedUserProfile!.profileId,
              });
            }
            throw new Error("Second schedule rejected before commit");
          }
          return add(input, options);
        });
        const result = await addTemplate(fixture, personal.owner);
        expect(result).toMatchObject({
          status: "partial",
          error: { code: change ? "add_rollback_incomplete" : "add_failed" },
        });
        expect(await fixture.status()).toMatchObject({ jobs: change ? 1 : 0 });
        expect(fixture.getConfig().agents?.entries?.[agentId] !== undefined).toBe(change);
        if (change) {
          expect(await fixture.reload()).toMatchObject({
            enabled: false,
            ownerProfileId: personal.other.authenticatedUserProfile!.profileId,
          });
        }
      });
    });
  },
);

it.each(["ocid", "paired device"])(
  "native Template Add retains %s source until revocation",
  async (source) => {
    await withFixture(async (fixture) => {
      const owner = await ensureCanonicalGatewayOwnerProfile("Synthetic Template owner");
      const principal: OpenClawIdTunnelPrincipal = {
        kind: "owner",
        peerKey: `iroh:${"da".repeat(32)}`,
        authority: { clawId: "template-claw", rootPub: "template-root", listedSeq: 1 },
      };
      setOpenClawIdTunnelPrincipalLookup(() => principal);
      try {
        await remoteTemplate();
        await withTemplateRuntime(fixture, async () => {
          const client: GatewayClient = {
            connId: "native-template-source",
            connect: gatewayConnect(["operator.admin"]),
            authenticatedUserProfile: gatewayProfile(owner.id),
          };
          client.internal = {
            authenticatedOperator: true,
            ...(source === "ocid" ? { openclawIdPrincipal: principal } : {}),
            // Socket admission classified this source as independent of plugin access grants.
            operatorAccessAuthority: null,
          };
          client.authPolicy = captureGatewayAuthPolicy(fixture.getConfig(), {
            role: "operator",
            authMethod: source === "ocid" ? "trusted-proxy" : "token",
          });
          const device = pairedOperator();
          const stateDir = process.env.OPENCLAW_STATE_DIR!;
          if (source === "paired device") {
            persistDevices(stateDir, [device], "both");
            client.connect.device = {
              id: device.deviceId,
              publicKey: device.publicKey,
              signature: "fixture-signature",
              signedAt: 1,
              nonce: "fixture-nonce",
            };
            assert(device.tokens?.operator);
            client.internal.operatorDeviceTokenIdentity = resolveAuthenticatedDeviceTokenIdentity(
              device,
              {
                role: "operator",
                publicKey: device.publicKey,
                token: device.tokens.operator.token,
                scopes: client.connect.scopes ?? [],
              },
            );
            assert(client.internal.operatorDeviceTokenIdentity);
          }
          const context = templateContext(fixture, client);
          const result = await addTemplate(fixture, client, context);
          expect(result, JSON.stringify(result)).toMatchObject({ status: "complete" });
          const stored = await fixture.reload();
          context.cron = fixture.getCron();
          expect(stored.operatorSource?.source).toMatchObject({
            kind: "gateway",
            agentId,
            snapshot: {
              profileId: client.authenticatedUserProfile!.profileId,
              ...(source === "ocid"
                ? { openclawIdPrincipal: principal }
                : { device: { deviceId: device.deviceId } }),
            },
          });
          const restore = () =>
            restoreGatewayOperatorSource({
              snapshot: stored.operatorSource!.source.snapshot,
              context,
              assertCurrent: () => {},
            });
          const restored = await restore();
          try {
            restored.authority.assertCurrent();
            setOpenClawIdTunnelPrincipalLookup(undefined);
            if (source === "paired device") {
              expect(
                await revokeDeviceToken({ deviceId: device.deviceId, role: "operator" }),
              ).toMatchObject({ ok: true });
              // Native device RPC also publishes revocation to the retained Gateway source.
              invalidateGatewayDeviceRevocation(context, device.deviceId, "operator");
            }
            expect(() => restored.authority.assertCurrent()).toThrow();
            await expect(restore()).rejects.toThrow();
          } finally {
            restored.release();
          }
        });
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
      }
    });
  },
);

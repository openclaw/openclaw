import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { writeConfigFile } from "../../config/io.runtime.js";
import { registerRuntimeConfigWriteListener } from "../../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { acquireCronInferenceAuthorization } from "../../cron/inference-binding.runtime.js";
import { clawHubSecurityResponse } from "../../plugins/clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "../../plugins/clawhub.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
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

async function remoteTemplate() {
  const archive = await createArchive({
    "package.json": JSON.stringify({
      name: packageName,
      version,
      openclaw: { template: "CLAW.md" },
    }),
    "CLAW.md": manifest,
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

it.each([false, true])(
  "fresh Template Add captures the host account privately and refuses replaced authority (replace: %s)",
  async (replace) => {
    await withFixture(async (fixture) => {
      const archive = await remoteTemplate();
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
      // Consume the native config receipt as the active runtime owner, before
      // Add may schedule work for the newly published agent.
      const unsubscribe = registerRuntimeConfigWriteListener((event) => {
        const application = getRuntimeConfigWriteApplication(event)?.claim();
        fixture.publish(event.sourceConfig);
        application?.settle("applied");
      });
      try {
        if (replace) {
          fixture.replaceAccountBeforeMutation("add");
        }
        const client: GatewayClient = {
          connId: "template-inference-owner",
          invalidated: false,
          connect: gatewayConnect(["operator.admin"]),
        };
        const params = { source: { packageName, version } };
        const respond = vi.fn<RespondFn>();
        await templatesAddHandlers["templates.add.apply"]!({
          req: { type: "req", id: "template-inference", method: "templates.add.apply", params },
          params,
          respond,
          client,
          context: createDirectChatContext({
            cron: fixture.getCron(),
            getRuntimeConfig: fixture.getConfig,
          }),
          hasCurrentClientAuthority: () => !client.invalidated,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledOnce();
        const [ok, result, error] = respond.mock.calls[0]!;
        expect(ok, JSON.stringify(error)).toBe(true);
        expect(result).toMatchObject({ agentId, status: replace ? "partial" : "complete" });
        expect(JSON.stringify(result)).not.toMatch(
          /inferenceBinding|authorizationId|synthetic-|openai:platform|model:/,
        );
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
      } finally {
        unsubscribe();
      }
    });
  },
);

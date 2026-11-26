import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../test/helpers/openai-responses-model-fixture.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createLocalNetworkControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// The read-only App route has no publisher; invalid signing data prevents any real authentication.
// Rerunnable count/byte workload: select an already-qualified built checkout, never rebuild it.
// OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_GITHUB_TOOL_BUILD_ROOT=<root> OPENCLAW_GITHUB_TOOL_STAGE=base|fix
// node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/chat-github-tool-surface.real-gateway.e2e.test.ts
const buildRoot = path.resolve(process.env.OPENCLAW_GITHUB_TOOL_BUILD_ROOT ?? ".");
const baseline = process.env.OPENCLAW_GITHUB_TOOL_STAGE === "base";
const reply = "GitHub tool surface captured.";
let owner: OpenClawTestInstance;
let artifactDir: string;
let scenario = "empty";
const captures: Array<{
  scenario: string;
  bytes: number;
  names: string[];
  actions: string[];
}> = [];
const suite = createControlUiE2eSuite({
  name: "GitHub tool surface on the built transport",
  startServerBeforeBrowser: true,
  async startServer() {
    const model = await startOpenAiResponsesModelServer({
      modelId: "tool-surface-fixture",
      bindError: "Tool fixture did not bind",
      onRequest: async (request, response) => {
        const raw = await buffer(request);
        await writeFile(path.join(artifactDir, scenario + "-" + captures.length + ".bin"), raw); // Original transport bytes, before decoding.
        const body: {
          tools: Array<{
            name: string;
            parameters: { properties: { action?: { enum: string[] } } };
          }>;
        } = JSON.parse(raw.toString("utf8"));
        captures.push({
          scenario,
          bytes: raw.length,
          names: body.tools.map((tool) => tool.name),
          actions:
            body.tools.find((tool) => tool.name === "github_publish")?.parameters.properties.action
              ?.enum ?? [],
        });
        writeOpenAiResponsesText(response, {
          text: reply,
          messageId: "fixture-message-" + scenario,
          responseId: "fixture-response-" + scenario,
        });
      },
    });
    const modelConfig = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "openai",
      modelId: "tool-surface-fixture",
      reasoning: false,
      toolProfile: "full",
    });
    const config: OpenClawConfig = {
      ...modelConfig,
      agents: { defaults: { ...modelConfig.agents?.defaults, utilityModel: "" } },
      gateway: { controlUi: { enabled: true } },
      update: { checkOnStart: false },
      models: { ...modelConfig.models, catalogRefresh: { enabled: false } },
      tools: {
        profile: "full",
        codeMode: { enabled: false },
        toolSearch: false,
        github: {
          profileId: "ghp_00000000000000000000000000000001",
          kind: "app-installation",
          app: {
            appId: 1,
            installationId: 2,
            accountId: 3,
            repositories: [{ id: 4, fullName: "fixture/repository" }],
            permissions: { contents: "read" },
            privateKey: "synthetic-invalid-signing-key",
            keyVersion: "fixture",
          },
        },
      },
      plugins: {
        allow: ["openai", "github", "skill-workshop"],
        entries: { github: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    const close = () =>
      runQaGatewayFixture(
        () => owner?.cleanup(),
        () => model.close(),
      );
    try {
      owner = await createOpenClawTestInstance({
        name: "github-tool-surface",
        cwd: buildRoot,
        entrypoint: [path.join(buildRoot, "dist/index.js")],
        stopTimeoutMs: 5000,
        config,
        env: {
          VITEST: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(buildRoot, "dist/extensions"),
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          GH_ENTERPRISE_TOKEN: undefined,
          GITHUB_ENTERPRISE_TOKEN: undefined,
          GH_CONFIG_DIR: undefined,
          GH_HOST: undefined,
        },
      });
      ensureGatewayOwnerProfile("Synthetic GitHub tool viewer", { env: owner.env });
      await owner.startGateway();
      return { baseUrl: "http://127.0.0.1:" + owner.port + "/", close };
    } catch (error) {
      return runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});
suite.define(() => {
  it("emits receipt-only absent declarations but retains configured-unhealthy actions", async (test) => {
    artifactDir = suite.artifactDir;
    const client = await connectChatGateway(owner, test.signal);
    try {
      await suite.withPage(createLocalNetworkControlUiContextOptions(), async ({ page }) => {
        await pairFixture(page, owner);
        for (scenario of ["empty", "unfit"]) {
          if (scenario === "unfit") {
            const config: OpenClawConfig = JSON.parse(await readFile(owner.configPath, "utf8"));
            config.tools = {
              ...config.tools,
              github: { profileId: "ghp_11111111111111111111111111111111", kind: "oauth" },
            };
            await owner.state.writeConfig(config);
          }
          await expect
            .poll(() =>
              client.request("tools.github.status", { agentId: "main", selectedScope: "agent" }),
            )
            .toMatchObject({
              effective: {
                credentialKind: scenario === "empty" ? "app-installation" : "managed-oauth",
              },
            });
          const key = "agent:main:github-surface-" + scenario;
          await client.request("sessions.create", {
            key,
            agentId: "main",
            label: "GitHub tool surface " + scenario,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
          await waitForControlUiGatewayReady(page);
          await assertServedUi(page, suite.server.baseUrl, buildRoot);
          const count = captures.length;
          const { pane, composer, send } = chatControls(page);
          await composer.fill("List GitHub capabilities for this synthetic fixture.");
          await send.click();
          await pane.locator("p", { hasText: reply }).waitFor({ state: "visible" });
          await expect
            .poll(() => client.request("chat.history", { sessionKey: key }))
            .toMatchObject({ sessionInfo: { hasActiveRun: false } });
          expect(captures).toHaveLength(count + 1);
          const observed = captures[count]!;
          expect(observed.names).toEqual(
            expect.arrayContaining([
              "github_publish",
              "github_identity_status",
              "github_read",
              "github_search",
            ]),
          );
          if (scenario === "empty" && !baseline) {
            expect(observed.actions).toEqual(["readiness"]);
          } else {
            expect(observed.actions).toContain("publish");
          }
        }
      });
    } finally {
      await client.stopAndWait();
      await writeFile(path.join(artifactDir, "counts.json"), JSON.stringify(captures, null, 2));
    }
  });
});

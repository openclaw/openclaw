import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeSetupCapability } from "../app/native-setup.ts";
import type { SetupAutoResult } from "../pages/model-setup/automatic-setup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Automatic Model Setup" });
const options = {
  locale: "en-US",
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
  serviceWorkers: "block" as const,
  viewport: { width: 1280, height: 1000 },
};
const codex = {
  kind: "codex-cli",
  label: "Codex",
  detail: "ChatGPT account",
  modelRef: "openai/default",
};
const local = {
  kind: "ollama",
  label: "Local model",
  detail: "Already running on this Gateway",
  modelRef: "ollama/local-model",
};
const configured: SetupAutoResult = {
  status: "configured",
  selected: codex,
  firstAgent: { agentId: "main", sessionKey: "agent:main:main", bootstrapPending: true },
  alternatives: [local],
  attempts: [],
  installedPlugins: [],
};
const shared: SetupAutoResult = {
  ...configured,
  selected: { ...codex, shared: true },
  separateSignIn: { authOptionId: "codex-separate-sign-in", label: "ChatGPT" },
};
const needsSignIn: SetupAutoResult = {
  status: "needs-sign-in",
  alternatives: [],
  attempts: [],
  signIn: { authOptionId: "openai-codex", label: "ChatGPT" },
  installedPlugins: ["codex"],
};
const unavailable: SetupAutoResult = {
  status: "unavailable",
  alternatives: [],
  attempts: [
    { kind: "ollama", label: "Local model", error: "No running model was available." },
    { kind: "codex", label: "Codex", error: "The download could not be completed." },
  ],
  installedPlugins: [],
};

function install(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installMockGateway(page, {
    ...scenario,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "openclaw.chat",
      "openclaw.setup.auto",
      "openclaw.setup.detect",
      "openclaw.setup.activate",
      "openclaw.setup.auth.start",
      "wizard.next",
      ...(scenario.featureMethods ?? []),
    ],
    methodResponses: {
      "openclaw.setup.auto": configured,
      "openclaw.setup.detect": {
        candidates: [],
        unavailableCandidates: [],
        manualProviders: [],
        authOptions: [],
        prepareOptions: [],
        recommendedInstalls: [],
        workspace: "/fixture/workspace",
        setupComplete: false,
      },
      "openclaw.chat": {
        sessionId: "setup-proof",
        reply: "Your AI is ready. Let’s get to know each other.",
        action: "none",
      },
      ...scenario.methodResponses,
    },
  });
}

async function nativeSetup(page: Page) {
  await page.addInitScript(() => {
    const actions: string[] = [];
    Object.assign(window, {
      setupProofActions: actions,
      __OPENCLAW_NATIVE_SETUP__: {
        currentGateway: { name: "This Mac", kind: "local" },
        openAiSetup: () => actions.push("ai"),
        openGateways: () => actions.push("gateways"),
        reviewPermissions: () => actions.push("permissions"),
      } satisfies NativeSetupCapability,
    });
  });
}

async function capture(page: Page, name: string, surface: Locator, content: Locator[]) {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR;
  if (!parent) {
    return;
  }
  await page.mouse.move(0, 0);
  const artifacts = createControlUiE2eArtifactDir(name, parent);
  const frame = await takeControlUiScreenshotFrame(page, surface, content, {
    elements: [surface],
    animations: "disabled",
    scrollTo: surface,
  });
  await writeFile(path.join(artifacts, "page.png"), frame.png);
  await writeFile(path.join(artifacts, "card.png"), frame.elements[0]!.png);
}

suite.define(() => {
  it("keeps the existing greeting when automatic setup is not advertised", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat"],
        methodResponses: {
          "openclaw.chat": { sessionId: "before", reply: "Welcome to OpenClaw.", action: "none" },
        },
      });
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
      const greeting = page.getByText("Welcome to OpenClaw.", { exact: true });
      await greeting.waitFor();
      expect(await page.locator(".custodian-setup").count()).toBe(0);
      expect(await gateway.getRequests("openclaw.setup.auto")).toHaveLength(0);
      await capture(page, "before-automatic-setup", page.locator("openclaw-custodian-page"), [
        greeting,
      ]);
    });
  });

  it("shows pending, preserves a failed choice, activates an alternative, and retains dismissal", async () => {
    await suite.withPage(options, async ({ page }) => {
      await nativeSetup(page);
      const gateway = await install(page, { deferredMethods: ["openclaw.setup.auto"] });
      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=auto`);
      const card = page.locator(".custodian-setup");
      const connecting = card.getByRole("heading", { name: "Connecting your AI…" });
      await connecting.waitFor();
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await capture(page, "pending-automatic-setup", card, [connecting]);
      await gateway.resolveDeferred("openclaw.setup.auto", configured);
      const selected = card.getByRole("heading", {
        name: "Using Codex (openai/default) on This Mac",
      });
      await selected.waitFor();
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.setup.auto")).toHaveLength(1);
      await capture(page, "configured-automatic-setup", card, [selected]);
      await card.getByRole("button", { name: "Use a different Gateway" }).click();
      await card.getByRole("button", { name: "Review permissions" }).click();
      expect(await page.evaluate(() => Reflect.get(window, "setupProofActions"))).toEqual([
        "gateways",
        "permissions",
      ]);

      await gateway.setMethodResponse("openclaw.setup.activate", {
        ok: false,
        error: "The local model stopped.",
      });
      await card.getByRole("button", { name: "Local model", exact: true }).click();
      expect((await gateway.waitForRequest("openclaw.setup.activate")).params).toEqual({
        kind: "ollama",
        modelRef: "ollama/local-model",
        completeFirstAgent: true,
      });
      await card.getByText("The local model stopped.", { exact: true }).waitFor();
      await selected.waitFor();
      await capture(page, "failed-alternative-automatic-setup", card, [
        selected,
        card.getByRole("alert"),
      ]);
      await gateway.setMethodResponse("openclaw.setup.activate", {
        ok: true,
        modelRef: local.modelRef,
      });
      await card.getByRole("button", { name: "Local model", exact: true }).click();
      const activated = card.getByRole("heading", {
        name: "Using Local model (ollama/local-model) on This Mac",
      });
      await activated.waitFor();
      await capture(page, "activated-automatic-setup", card, [activated]);
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
      await card.waitFor({ state: "detached" });
      await page.reload();
      await gateway.waitForRequest("openclaw.setup.auto");
      expect(await card.count()).toBe(0);
    });
  });

  it.each([false, true])("runs ChatGPT sign-in and refreshes setup (shared=%s)", async (reuse) => {
    await suite.withPage(options, async ({ page }) => {
      await nativeSetup(page);
      const gateway = await install(page, {
        methodResponses: {
          "openclaw.setup.auto": {
            sequence: [reuse ? shared : needsSignIn, { ...configured, status: "activated" }],
          },
          "openclaw.setup.auth.start": { sessionId: "sign-in", done: false, status: "running" },
          "wizard.next": {
            sequence: [
              {
                done: false,
                status: "running",
                step: {
                  id: "confirmation",
                  type: "text",
                  title: "ChatGPT sign-in",
                  message: "Enter the confirmation code",
                  executor: "client",
                },
              },
              { done: true, status: "done" },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=auto`);
      const card = page.locator(".custodian-setup");
      const signIn = card.getByRole("button", {
        name: reuse ? "Sign in separately" : "Sign in with ChatGPT",
      });
      await signIn.waitFor();
      const sharedNotice = card.getByText(
        "Using your existing Codex login · sessions shared with Codex",
        { exact: true },
      );
      if (reuse) {
        await sharedNotice.waitFor();
        await capture(page, "shared-codex-login", card, [signIn, sharedNotice]);
      } else {
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
        await capture(page, "needs-sign-in-automatic-setup", card, [signIn]);
      }
      await signIn.click();
      expect((await gateway.waitForRequest("openclaw.setup.auth.start")).params).toMatchObject({
        authChoice: reuse ? "codex-separate-sign-in" : "openai-codex",
      });
      const confirmation = card.getByRole("textbox", { name: "Enter the confirmation code" });
      await confirmation.fill("DEMO-CONFIRMATION");
      await capture(page, "sign-in-wizard-automatic-setup", card, [confirmation]);
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      expect(
        (
          await gateway.waitForRequest("wizard.next", {
            match: { answer: { stepId: "confirmation", value: "DEMO-CONFIRMATION" } },
          })
        ).params,
      ).toMatchObject({ answer: { stepId: "confirmation", value: "DEMO-CONFIRMATION" } });
      await gateway.waitForRequest("openclaw.setup.auto", { after: 1 });
      const selected = card.getByRole("heading", { name: /Using Codex/ });
      await selected.waitFor();
      await sharedNotice.waitFor({ state: "detached" });
      expect(await card.getByRole("button", { name: "Sign in separately" }).count()).toBe(0);
      if (reuse) {
        await capture(page, "separate-codex-login", card, [selected]);
      }
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
    });
  });

  it("confirms utility setup visibly and stays available for primary setup", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await install(page, {
        featureMethods: ["openclaw.setup.activate.start"],
        methodResponses: {
          "openclaw.setup.detect": {
            candidates: [
              {
                kind: "provider-auto:local",
                label: "Local utility",
                detail: "Lightweight tasks",
                modelRef: "local/utility",
                modelTarget: "utility",
                credentials: true,
                recommended: false,
              },
            ],
            unavailableCandidates: [],
            manualProviders: [],
            authOptions: [],
            prepareOptions: [],
            recommendedInstalls: [],
            workspace: "/fixture/workspace",
            setupComplete: false,
          },
          "openclaw.setup.activate.start": {
            done: true,
            status: "done",
            modelActivation: { modelRef: "local/utility", modelTarget: "utility" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
      await page.locator('[data-candidate-kind="provider-auto:local"] button').click();
      const success = page.locator(".model-setup-success");
      await success.getByRole("heading", { name: "Setup & utility model ready" }).waitFor();
      await capture(page, "utility-only-confirmed", success, [
        success.getByRole("button", { name: "Connect a primary model" }),
      ]);
      await success.getByRole("button", { name: "Connect a primary model" }).click();
      await success.waitFor({ state: "detached" });
      expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
    });
  });

  it("hatches in regular Home and sends only the user's chosen first message", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await install(page, { historyMessages: [] });
      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=auto`);
      await page.getByRole("button", { name: "Start talking to your agent" }).click();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      expect(new URL(page.url()).pathname).toBe("/chat/main");
      expect(await composer.inputValue()).toBe("Wake up, my friend!");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await capture(page, "first-agent-home", page.locator("openclaw-chat-page"), [composer]);
      await composer.fill("Help me draft a short launch checklist.");
      await page.getByRole("button", { name: "Send message" }).click();
      expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
        sessionKey: "agent:main:main",
        message: "Help me draft a short launch checklist.",
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });

  it("verifies a native model choice before first-agent handoff", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await install(page, {
        historyMessages: [],
        deferredMethods: ["openclaw.setup.activate.start"],
        featureMethods: ["openclaw.setup.activate.start"],
        methodResponses: {
          "models.list": {
            models: [
              {
                provider: "fixture",
                id: "native",
                name: "Native fixture",
                available: true,
                agentRuntime: { id: "fixture-native", source: "implicit" },
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
      const native = page.locator("[data-native-model-setup]");
      await native.locator(".picker-select__trigger").click();
      await native.locator('[role="option"][data-value="fixture/native"]').click();
      await native.locator("button.primary").click();
      expect((await gateway.waitForRequest("openclaw.setup.activate.start")).params).toMatchObject({
        agentId: "main",
        kind: "native-model",
        modelRef: "fixture/native",
        agentRuntime: "fixture-native",
        completeFirstAgent: true,
      });
      expect(await gateway.getRequests("agents.update")).toHaveLength(0);
      expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
      await gateway.resolveDeferred("openclaw.setup.activate.start", {
        done: true,
        status: "done",
        modelActivation: { modelRef: "fixture/native", firstAgent: configured.firstAgent },
      });
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      expect(new URL(page.url()).pathname).toBe("/chat/main");
      expect(await composer.inputValue()).toBe("Wake up, my friend!");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each([false, true])(
    "explains unavailable inference and routes recovery (native=%s)",
    async (native) => {
      await suite.withPage(options, async ({ page }) => {
        if (native) {
          await nativeSetup(page);
        }
        await install(page, { methodResponses: { "openclaw.setup.auto": unavailable } });
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=auto`);
        const card = page.locator(".custodian-setup");
        const failure = card.getByText("The download could not be completed.", { exact: false });
        await failure.waitFor();
        await card.getByText("No running model was available.", { exact: false }).waitFor();
        await capture(
          page,
          native ? "unavailable-native-automatic-setup" : "unavailable-web-automatic-setup",
          card,
          [failure],
        );
        if (native) {
          await card.getByRole("button", { name: "Open AI setup" }).click();
          expect(await page.evaluate(() => Reflect.get(window, "setupProofActions"))).toEqual([
            "ai",
          ]);
          expect(await card.getByText("openclaw onboard", { exact: true }).count()).toBe(0);
        } else {
          await card.getByText("openclaw onboard", { exact: true }).waitFor();
          expect(await card.getByRole("button", { name: "Use a different Gateway" }).count()).toBe(
            0,
          );
          expect(await card.getByRole("button", { name: "Review permissions" }).count()).toBe(0);
        }
      });
    },
  );
});

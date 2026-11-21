import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeSetupCapability } from "../app/native-setup.ts";
import type { SetupAutoResult } from "../pages/custodian/custodian-auto-setup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Custodian automatic AI setup" });
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
function detection(setupComplete: boolean, candidates: object[] = []) {
  return { setupComplete, candidates, manualProviders: [], authOptions: [] };
}
const detectedCodex = { ...codex, recommended: true, credentials: true };
const detectedLocal = { ...local, recommended: false };
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
      "openclaw.setup.detect",
      "openclaw.setup.auto",
      "openclaw.setup.activate",
      "openclaw.setup.auth.start",
      "wizard.next",
      ...(scenario.featureMethods ?? []),
    ],
    methodResponses: {
      "openclaw.setup.detect": detection(true),
      "openclaw.setup.auto": configured,
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
  await page.mouse.click(0, 0);
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
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
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
      await page
        .getByText("Your AI is ready. Let’s get to know each other.", { exact: true })
        .waitFor();
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
        modelRef: local.modelRef,
      });
      await card
        .getByText("Couldn’t connect Local model: The local model stopped.", { exact: true })
        .waitFor();
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

  it("offers detected AI without turning any on and keeps the other choice after a failure", async () => {
    await suite.withPage(options, async ({ page }) => {
      await nativeSetup(page);
      const gateway = await install(page, {
        methodResponses: {
          "openclaw.setup.detect": detection(false, [detectedLocal, detectedCodex]),
          "openclaw.setup.activate": {
            cases: [
              {
                match: { kind: local.kind },
                response: { ok: false, error: "No running model was available." },
              },
              { match: { kind: codex.kind }, response: { ok: true, modelRef: codex.modelRef } },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
      const card = page.locator(".custodian-setup");
      const choose = card.getByRole("heading", { name: "Choose your AI" });
      await choose.waitFor();
      const choices = card.locator(".custodian-setup__alternatives button");
      expect(await choices.allTextContents()).toEqual(["Codex", "Local model"]);
      await card.getByRole("button", { name: "Set up automatically" }).waitFor();
      expect(await gateway.getRequests("openclaw.setup.auto")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.setup.activate")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await capture(page, "choose-detected-ai", card, [choose]);

      await card.getByRole("button", { name: "Local model", exact: true }).click();
      const failure = card.getByText(
        "Couldn’t connect Local model: No running model was available.",
        { exact: true },
      );
      await failure.waitFor();
      await choose.waitFor();
      await card.getByRole("button", { name: "Retry", exact: true }).click();
      await gateway.waitForRequest("openclaw.setup.activate", { after: 1 });
      await failure.waitFor();
      const attempts = await gateway.getRequests("openclaw.setup.activate");
      expect(attempts.map(({ params }) => params)).toEqual([
        { kind: local.kind, modelRef: local.modelRef },
        { kind: local.kind, modelRef: local.modelRef },
      ]);
      expect(await gateway.getRequests("openclaw.setup.auto")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await capture(page, "failed-choice-keeps-other-option", card, [choose, failure]);

      await card.getByRole("button", { name: "Codex", exact: true }).click();
      const activated = card.getByRole("heading", {
        name: "Using Codex (openai/default) on This Mac",
      });
      await activated.waitFor();
      expect(
        (await gateway.getRequests("openclaw.setup.activate")).map(({ params }) => params).at(-1),
      ).toEqual({ kind: codex.kind, modelRef: codex.modelRef });
      await page
        .getByText("Your AI is ready. Let’s get to know each other.", { exact: true })
        .waitFor();
      await capture(page, "chosen-ai-activated", card, [activated]);
    });
  });

  it.each([false, true])("runs ChatGPT sign-in and refreshes setup (shared=%s)", async (reuse) => {
    await suite.withPage(options, async ({ page }) => {
      await nativeSetup(page);
      const gateway = await install(page, {
        methodResponses: {
          "openclaw.setup.detect": { sequence: [detection(reuse), detection(true)] },
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
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
      const card = page.locator(".custodian-setup");
      if (!reuse) {
        await card.getByRole("button", { name: "Set up automatically" }).click();
      }
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
      await page
        .getByText("Your AI is ready. Let’s get to know each other.", { exact: true })
        .waitFor();
    });
  });

  it.each([
    {
      status: "unavailable",
      error: "The local model needs more memory. Load a smaller model.",
      title: "Couldn’t connect your AI",
    },
    {
      status: "needs-sign-in",
      error: "The saved login expired. Sign in again.",
      title: "Connect ChatGPT to get started",
    },
  ] as const)(
    "shows $status attempts and offers ChatGPT sign-in",
    async ({ status, error, title }) => {
      await suite.withPage(options, async ({ page }) => {
        const gateway = await install(page, {
          methodResponses: {
            "openclaw.setup.detect": detection(false, [detectedLocal]),
            "openclaw.setup.auto": {
              ...needsSignIn,
              status,
              attempts: [{ kind: local.kind, label: local.label, error }],
            },
            "openclaw.setup.auth.start": { sessionId: "recovery", done: true, status: "done" },
          },
        });
        await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
        const card = page.locator(".custodian-setup");
        await card.getByRole("button", { name: "Set up automatically" }).click();
        await card.getByRole("heading", { name: title }).waitFor();
        const failure = card.getByText(error, { exact: false });
        await failure.waitFor();
        const signIn = card.getByRole("button", { name: "Sign in with ChatGPT" });
        await signIn.waitFor();
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
        await capture(page, `${status}-failure-with-sign-in`, card, [failure, signIn]);
        await signIn.click();
        expect((await gateway.waitForRequest("openclaw.setup.auth.start")).params).toMatchObject({
          authChoice: needsSignIn.signIn!.authOptionId,
        });
      });
    },
  );

  it.each([false, true])(
    "explains unavailable inference and routes recovery (native=%s)",
    async (native) => {
      await suite.withPage(options, async ({ page }) => {
        if (native) {
          await nativeSetup(page);
        }
        await install(page, {
          methodResponses: {
            "openclaw.setup.detect": detection(false),
            "openclaw.setup.auto": unavailable,
          },
        });
        await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
        const card = page.locator(".custodian-setup");
        await card.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await capture(page, native ? "no-detected-ai-native" : "no-detected-ai-web", card, [
          card.getByRole("heading", { name: "Connect your AI" }),
        ]);
        await card.getByRole("button", { name: "Set up automatically" }).click();
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

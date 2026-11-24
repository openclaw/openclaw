import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SystemAgentSetupDetectResult } from "../api/types.ts";
import type { NativeSetupCapability } from "../app/native-setup.ts";
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
  // Tall enough for the whole Connect your AI page in one screenshot.
  viewport: { width: 1280, height: 1600 },
};
type Detection = SystemAgentSetupDetectResult;
const codex = {
  kind: "codex-cli",
  brandId: "openai",
  label: "Codex",
  detail: "installed; stored credentials found; login status unverified",
  modelRef: "openai/default",
  recommended: true,
  credentials: true,
} satisfies Detection["candidates"][number];
const local = {
  kind: "provider-auto:ollama",
  brandId: "ollama",
  label: "Local model",
  detail: "Already running on this Gateway",
  modelRef: "ollama/local-model",
  recommended: false,
} satisfies Detection["candidates"][number];
const chatgpt = {
  id: "openai-token-sharing",
  brandId: "openai",
  label: "Sign in with ChatGPT",
  kind: "oauth",
  featured: true,
} satisfies NonNullable<Detection["authOptions"]>[number];
const deviceCode = {
  id: "openai-device-code",
  brandId: "openai",
  label: "Codex login (device code)",
  kind: "device-code",
  featured: false,
} satisfies NonNullable<Detection["authOptions"]>[number];
const anthropic = {
  id: "anthropic-cli",
  brandId: "anthropic",
  label: "Claude",
  kind: "oauth",
  featured: false,
} satisfies NonNullable<Detection["authOptions"]>[number];
const install = (
  id: string,
  brandId: string | undefined,
  label: string,
  hint: string,
  website: string,
) => ({
  id,
  ...(brandId ? { brandId } : {}),
  label,
  hint,
  website,
  icon: "https://cdn.simpleicons.org/openclaw",
});
// The Gateway's bundled install catalog (scripts/lib/recommended-tool-installs.json).
const recommendedInstalls = [
  install("ollama", "ollama", "Ollama", "Run open models locally", "https://ollama.com/download"),
  install(
    "lmstudio",
    undefined,
    "LM Studio",
    "Local model desktop app",
    "https://lmstudio.ai/download",
  ),
  install(
    "claude-code",
    "claude",
    "Claude Code",
    "Anthropic's coding agent CLI",
    "https://code.claude.com/docs/en/quickstart",
  ),
  install(
    "codex-cli",
    "openai",
    "Codex CLI",
    "OpenAI's coding agent CLI",
    "https://developers.openai.com/codex/cli/",
  ),
];
// Shaped like what a clean Mac's Gateway offers (see the Mac welcome screenshots).
const detected: Detection = {
  candidates: [codex, local],
  manualProviders: [
    { id: "openai-api-key", brandId: "openai", groupLabel: "OpenAI", label: "API key" },
    { id: "anthropic-api-key", brandId: "anthropic", groupLabel: "Anthropic", label: "API key" },
  ],
  authOptions: [chatgpt, deviceCode, anthropic],
  prepareOptions: [
    {
      id: "lmstudio",
      brandId: "lmstudio",
      label: "LM Studio",
      hint: "Connect to a running LM Studio server and use an already loaded model",
      actionLabel: "Connect server",
    },
  ],
  recommendedInstalls,
  workspace: "/workspace",
  setupComplete: false,
};
const nothingDetected: Detection = { ...detected, candidates: [] };
const activated = (modelRef: string) => ({
  done: true,
  status: "done",
  modelActivation: { modelRef },
});
// Real text a failed first-run ChatGPT sign-in showed on the setup card (Control UI, 2026-11-19).
const realSignInError =
  "Credentials saved; default unchanged. OAuth token refresh failed for openai: Auth profile credential authority is unavailable; retry after owner recovery. Please try again or re-authenticate. Choose the saved sign-in in Model Setup to retry without signing in again. Choose whether OpenClaw can use your ChatGPT plan for eligible Responses API requests. Token sharing does not grant access to conversations, Codex history, or connected apps.";

function installGateway(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installMockGateway(page, {
    ...scenario,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "openclaw.chat",
      "openclaw.setup.detect",
      "openclaw.setup.activate.start",
      "openclaw.setup.auth.start",
      "openclaw.setup.prepare.start",
      "wizard.next",
      ...(scenario.featureMethods ?? []),
    ],
    methodResponses: {
      "openclaw.setup.detect": detected,
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

async function nextStep(card: Locator, heading: string) {
  await card.getByRole("button", { name: "Next", exact: true }).click();
  await card.getByRole("heading", { name: heading }).waitFor();
}

suite.define(() => {
  it("keeps the existing greeting when setup is not advertised", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat"],
        methodResponses: {
          "openclaw.chat": { sessionId: "before", reply: "Welcome to OpenClaw.", action: "none" },
        },
      });
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
      await page.getByText("Welcome to OpenClaw.", { exact: true }).waitFor();
      expect(await page.locator(".custodian-setup").count()).toBe(0);
      expect(await gateway.getRequests("openclaw.setup.detect")).toHaveLength(0);
    });
  });

  it("walks the macOS welcome steps and tests only the AI the user picks", async () => {
    await suite.withPage(options, async ({ page }) => {
      await nativeSetup(page);
      const gateway = await installGateway(page, {
        // Each listing holds one call: the local model test, then the ChatGPT login test.
        deferredMethods: [
          "openclaw.setup.detect",
          "openclaw.setup.activate.start",
          "openclaw.setup.activate.start",
        ],
      });
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
      const card = page.locator(".custodian-setup");
      const welcome = card.getByRole("heading", { name: "Welcome to OpenClaw" });
      await welcome.waitFor();
      await capture(page, "setup-1-welcome", card, [welcome]);
      await nextStep(card, "Where should your assistant run?");
      const where = card.getByRole("button", { name: /On this computer/ });
      await capture(page, "setup-2-where", card, [where]);
      await card.getByRole("button", { name: "Use a different Gateway" }).click();
      await nextStep(card, "Connect your AI");
      const detecting = card.getByText("Looking for AI you already use…", { exact: true });
      await detecting.waitFor();
      await capture(page, "setup-3-detecting", card, [detecting]);
      await gateway.resolveDeferred("openclaw.setup.detect", detected);
      const codexRow = card.getByRole("button", { name: "ChatGPT", exact: true });
      await codexRow.waitFor();
      expect(await card.getByText(/openai\/default|ollama\/local-model/).count()).toBe(0);
      // The Codex login and the ChatGPT sign-ins show as one ChatGPT choice.
      expect(await card.getByRole("button", { name: /ChatGPT|Codex/ }).count()).toBe(1);
      await capture(page, "setup-4-detected", card, [codexRow]);
      expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);

      // One row per provider: ChatGPT first, as on main.
      expect(await card.locator(".option-card__choice").allTextContents()).toEqual([
        "ChatGPT",
        "Claude",
        "Run a model locally",
        "Another provider",
      ]);
      // A model already running on the Gateway sits on the local models card.
      await card.getByRole("button", { name: "Run a model locally", exact: true }).click();
      await card.getByRole("button", { name: /^Local model/ }).click();
      expect((await gateway.waitForRequest("openclaw.setup.activate.start")).params).toMatchObject({
        kind: local.kind,
        modelRef: local.modelRef,
      });
      await gateway.resolveDeferred("openclaw.setup.activate.start", {
        done: true,
        status: "error",
        error: "provider-auto:ollama: model runner exited with code 137 (ECONNRESET)",
      });
      const failed = card.getByText("AI setup didn’t complete", { exact: true });
      await failed.waitFor();
      expect(await card.getByText(/ECONNRESET/).isVisible()).toBe(false);
      await capture(page, "setup-5-test-failed", card, [failed]);

      // As on main, picking ChatGPT tests the login the Gateway already has.
      await card.getByRole("button", { name: "All choices" }).click();
      await codexRow.click();
      const checking = card.getByText("Checking a real conversation. This may take a minute.", {
        exact: true,
      });
      await checking.waitFor();
      expect(await card.getByRole("button", { name: "All choices" }).isDisabled()).toBe(true);
      await capture(page, "setup-13-chatgpt-checking", card, [checking]);
      expect(
        (
          await gateway.waitForRequest("openclaw.setup.activate.start", {
            match: { kind: codex.kind },
          })
        ).params,
      ).toMatchObject({ kind: codex.kind });
      await gateway.resolveDeferred("openclaw.setup.activate.start", activated(codex.modelRef));
      const done = card.getByRole("heading", { name: "You’re all set!" });
      await done.waitFor();
      expect(await card.getByText(/openai\/default/).count()).toBe(0);
      await page
        .getByText("Your AI is ready. Let’s get to know each other.", { exact: true })
        .waitFor();
      await capture(page, "setup-6-done", card, [done]);
      expect(await page.evaluate(() => Reflect.get(window, "setupProofActions"))).toEqual([
        "gateways",
      ]);
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
      await card.waitFor({ state: "detached" });
      await page.reload();
      await gateway.waitForRequest("openclaw.setup.detect");
      expect(await card.count()).toBe(0);
    });
  });

  it("connects a Claude API key from the Claude card", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await installGateway(page, {
        methodResponses: { "openclaw.setup.activate.start": activated("anthropic/claude-sonnet") },
      });
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
      const card = page.locator(".custodian-setup");
      await nextStep(card, "Where should your assistant run?");
      await nextStep(card, "Connect your AI");
      await card.getByRole("button", { name: "Claude", exact: true }).click();
      const key = card.getByLabel("API key", { exact: true });
      await key.fill("sk-test-not-real");
      await capture(page, "setup-9-claude-card", card, [key]);
      await card.getByRole("button", { name: "Connect", exact: true }).click();
      expect((await gateway.waitForRequest("openclaw.setup.activate.start")).params).toMatchObject({
        kind: "api-key",
        authChoice: "anthropic-api-key",
        apiKey: "sk-test-not-real",
      });
      await card.getByRole("heading", { name: "You’re all set!" }).waitFor();
    });
  });

  it.each([true, false])("signs in with ChatGPT from the AI step (succeeds=%s)", async (ok) => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await installGateway(page, {
        methodResponses: {
          "openclaw.setup.detect": nothingDetected,
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
              ok
                ? { done: true, status: "done", modelActivation: { modelRef: "openai/gpt-5.5" } }
                : { done: true, status: "error", error: realSignInError },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);
      const card = page.locator(".custodian-setup");
      await nextStep(card, "Where should your assistant run?");
      await nextStep(card, "Connect your AI");
      const signIn = card.getByRole("button", { name: "ChatGPT", exact: true });
      await signIn.waitFor();
      expect(await card.locator(".option-card__choice").allTextContents()).toEqual([
        "ChatGPT",
        "Claude",
        "Run a model locally",
        "Another provider",
      ]);
      await capture(page, "setup-7-nothing-detected", card, [signIn]);
      if (!ok) {
        const back = card.getByRole("button", { name: "All choices" });
        await card.getByRole("button", { name: "Claude", exact: true }).click();
        const claudeKey = card.getByLabel("API key", { exact: true });
        await claudeKey.waitFor();
        await capture(page, "setup-10-claude-card", card, [claudeKey]);
        await back.click();
        await card.getByRole("button", { name: "Run a model locally", exact: true }).click();
        const ollama = card.getByRole("link", { name: /^Ollama/ });
        expect(await ollama.getAttribute("href")).toBe("https://ollama.com/download");
        await card.getByRole("button", { name: /^LM Studio/ }).waitFor();
        await capture(page, "setup-11-local-card", card, [ollama]);
        await back.click();
        await card.getByRole("button", { name: "Another provider", exact: true }).click();
        const provider = card.getByLabel("Provider and access method");
        await provider.waitFor();
        await capture(page, "setup-12-other-card", card, [provider]);
        await back.click();
        expect(await gateway.getRequests("openclaw.setup.prepare.start")).toHaveLength(0);
      }
      await signIn.click();
      // One sign-in, as on main: no Codex alternatives inside the ChatGPT card.
      const chatgptSignIn = card.getByRole("button", { name: "Sign in with ChatGPT", exact: true });
      await chatgptSignIn.waitFor();
      expect(await card.getByRole("link").count()).toBe(0);
      if (!ok) {
        await capture(page, "setup-14-chatgpt-card", card, [chatgptSignIn]);
      }
      await chatgptSignIn.click();
      expect((await gateway.waitForRequest("openclaw.setup.auth.start")).params).toMatchObject({
        authChoice: chatgpt.id,
      });
      const confirmation = card.getByRole("textbox", { name: "Enter the confirmation code" });
      await confirmation.waitFor();
      // The provider's card replaces the list while it signs in.
      expect(await card.getByRole("button", { name: "Claude", exact: true }).count()).toBe(0);
      if (!ok) {
        await capture(page, "setup-15-chatgpt-signing-in", card, [confirmation]);
      }
      await confirmation.fill("DEMO-CONFIRMATION");
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      if (ok) {
        await card.getByRole("heading", { name: "You’re all set!" }).waitFor();
        return;
      }
      const alert = card.getByRole("alert");
      await alert.getByText("Sign-in didn’t complete", { exact: true }).waitFor();
      expect(await alert.getByText(/OAuth token refresh failed/).isVisible()).toBe(false);
      await card.getByRole("button", { name: "Try again", exact: true }).last().waitFor();
      await capture(page, "setup-8-sign-in-failed", card, [alert]);
      await alert.getByText("Show details", { exact: true }).click();
      await alert.getByText(/OAuth token refresh failed/).waitFor();
    });
  });
});

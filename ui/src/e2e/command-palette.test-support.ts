import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { controlUiSessionUrl } from "./new-session-page.test-support.ts";

export const foregroundKey = "agent:main:dashboard:palette-foreground";
export const appearanceKey = "agent:main:dashboard:palette-appearance";
export const foregroundDraft = "Keep this unsent foreground draft exactly as it is.";
const caret = 10;
const workspace = "/workspace/palette-fixture";

export function scenario(
  methodResponses: Record<string, unknown> = {},
): ControlUiMockGatewayScenario {
  return {
    sessionKey: foregroundKey,
    workspace,
    workspaceGit: true,
    operatorScopes: ["operator.read", "operator.write"],
    featureMethods: [
      "agent.wait",
      "chat.metadata",
      "chat.startup",
      "sessions.create",
      "sessions.dispatch",
      "sessions.search",
    ],
    sessions: [
      createControlUiSessionRow(foregroundKey, "Foreground planning", Date.now() - 60_000),
      createControlUiSessionRow(appearanceKey, "Appearance audit", Date.now() - 120_000),
    ],
    historyMessages: [
      { role: "assistant", content: [{ type: "text", text: "The foreground task stays here." }] },
    ],
    methodResponses: {
      "sessions.list": {
        cases: [
          {
            match: { search: "appearance" },
            response: {
              ts: 1,
              path: "",
              defaults: {},
              count: 1,
              sessions: [
                createControlUiSessionRow(appearanceKey, "Appearance audit", Date.now() - 60_000),
              ],
            },
          },
        ],
      },
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          {
            id: "main",
            name: "Main",
            workspace,
            workspaceGit: true,
            model: { primary: "openai/gpt-5.5" },
          },
          {
            id: "reviewer",
            name: "Reviewer",
            workspace,
            workspaceGit: true,
            model: { primary: "openai/gpt-5.5" },
          },
        ],
      },
      "agent.identity.get": {
        cases: [
          { match: { agentId: "main" }, response: { agentId: "main", name: "Main" } },
          { match: { agentId: "reviewer" }, response: { agentId: "reviewer", name: "Reviewer" } },
        ],
      },
      "environments.list": {
        environments: [
          {
            id: "node:palette-runner",
            type: "node",
            label: "Palette runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
        profiles: [],
      },
      "worktrees.branches": {
        branches: [{ kind: "local", name: "main" }],
        defaultBranch: "main",
        repositoryStatus: "git",
      },
      ...methodResponses,
    },
  };
}

export async function openFromForeground(page: Page, baseUrl: string) {
  await page.goto(controlUiSessionUrl(baseUrl, foregroundKey));
  const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
  await composer.fill(foregroundDraft);
  await composer.evaluate((element: HTMLTextAreaElement, offset) => {
    element.focus();
    element.setSelectionRange(offset, offset);
  }, caret);
  const url = page.url();
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.locator("openclaw-command-palette");
  const input = palette.locator(".cmd-palette__input");
  await input.waitFor({ state: "visible" });
  await expect
    .poll(() => input.evaluate((element) => document.activeElement === element))
    .toBe(true);
  return { composer, url, palette, input };
}

export async function expectForegroundUnchanged(page: Page, composer: Locator, url: string) {
  expect(page.url()).toBe(url);
  expect(await composer.inputValue()).toBe(foregroundDraft);
  await expect
    .poll(() =>
      composer.evaluate((element: HTMLTextAreaElement) => ({
        focused: document.activeElement === element,
        start: element.selectionStart,
        end: element.selectionEnd,
      })),
    )
    .toEqual({ focused: true, start: caret, end: caret });
}

import { afterEach, beforeEach, expect, it, vi } from "vitest";

let restoreI18n: (() => Promise<void>) | undefined;

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await restoreI18n?.();
});

it.each([
  { surface: "tool panel", load: () => import("../pages/agents/panels-tools-skills.ts") },
  { surface: "skills panel", load: () => import("../pages/agents/panels-skills.ts") },
])("loads agent tool fallback copy with the $surface, preserving GitHub copy", async ({ load }) => {
  const { captureI18nStateForTesting, createI18nManagerForTesting } =
    await import("./lib/translate.test-support.ts");
  restoreI18n = captureI18nStateForTesting();
  const { en } = await import("./locales/en.ts");
  const agentTools = en.agentTools;
  expect(agentTools.disableAll).toBeUndefined();

  const { registerGitHubEnglish } = await import("./locales/en-github.ts");
  registerGitHubEnglish();
  const manager = createI18nManagerForTesting(async () => ({
    agentTools: { title: "Werkzeugzugriff" },
  }));
  await manager.setLocale("de");
  await load();

  expect(en.agentTools).toBe(agentTools);
  expect(manager.t("agentTools.title")).toBe("Werkzeugzugriff");
  expect(manager.t("agentTools.disableAll")).toBe("Disable All");
  expect(manager.t("agentTools.previewTitle")).toBe("Tool preview");
  expect(manager.t("agentTools.githubVerify")).toBe("Verify");

  registerGitHubEnglish();
  expect(en.agentTools).toBe(agentTools);
  expect(manager.t("agentTools.disableAll")).toBe("Disable All");
});

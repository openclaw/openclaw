import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  { surface: "tool panel", load: () => import("../pages/agents/panels-tools-skills.ts") },
  { surface: "skills panel", load: () => import("../pages/agents/panels-skills.ts") },
])("loads agent tool fallback copy with the $surface, preserving GitHub copy", async ({ load }) => {
  const { en, manager } = await loadI18n({ agentTools: { title: "Werkzeugzugriff" } });
  const agentTools = en.agentTools;
  expect(agentTools.disableAll).toBeUndefined();

  const { registerGitHubEnglish } = await import("./locales/en-github.ts");
  registerGitHubEnglish();
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

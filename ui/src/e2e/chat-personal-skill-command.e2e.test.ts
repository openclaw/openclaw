import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { listChatCommands } from "../../../src/auto-reply/commands-registry-list.js";
import { resolveSkillCommandInvocation } from "../../../src/skills/discovery/chat-command-invocation.js";
import { buildWorkspaceSkillCommandSpecs } from "../../../src/skills/discovery/command-specs.js";
import { createFixtureSkillEntry } from "../../../src/skills/test-support/test-helpers.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal skill short commands" });

suite.define(() => {
  it("completes a short command and sends its arguments to the pinned skill", async () => {
    const entry = createFixtureSkillEntry("s_review_0123456789abcdef0123", {
      source: "openclaw-library",
    });
    entry.frontmatter.name = "review";
    entry.skill.displayName = "Review a change";
    entry.skill.description = "Review a pull request or issue using your selected procedure.";
    const specs = buildWorkspaceSkillCommandSpecs("/workspace", { entries: [entry] });
    expect(specs[0]?.name).toBe("review");
    const artifactDir = createControlUiE2eArtifactDir("personal-skill-short-command");

    // The UI is unchanged. Compare its old identity-only payload with the new
    // production command projection, using the same synthetic selected skill.
    for (const stage of ["before", "after"] as const) {
      const visibleSpecs = structuredClone(specs);
      if (stage === "before") {
        for (const spec of visibleSpecs) {
          spec.name = spec.skillName;
          delete spec.aliases;
        }
      }
      const commands = listChatCommands({ skillCommands: visibleSpecs })
        .filter((command) => command.key.startsWith("skill:"))
        .map((command) => ({
          name: command.nativeName,
          nativeName: command.nativeName,
          description: command.description,
          acceptsArgs: command.acceptsArgs,
          textAliases: command.textAliases,
          scope: command.scope,
          category: command.category,
          source: "skill",
          skillDisplayName: entry.skill.displayName,
          skillModelVisible: true,
        }));
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          methodResponses: {
            "chat.startup": {
              agentsList: {
                agents: [{ id: "main", name: "OpenClaw" }],
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
              },
              messages: [],
              metadata: { commands, models: [] },
              sessionId: "personal-skill-command-session",
              thinkingLevel: null,
            },
            "chat.metadata": { commands, models: [] },
            "commands.list": { commands },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("/review");
        const picker = page.locator(".slash-menu[role='listbox']");
        const option = picker.getByRole("option").filter({ hasText: entry.skill.description });
        await option.waitFor({ state: "visible" });
        await expect
          .poll(() => option.locator(".slash-menu-name").textContent())
          .toContain("/" + visibleSpecs[0]!.name);
        await page.screenshot({
          path: path.join(artifactDir, stage + ".png"),
          animations: "disabled",
        });
        if (stage === "after") {
          await option.click();
          await expect.poll(() => composer.inputValue()).toBe("/review ");
          await composer.fill("/review #123");
          await page.getByRole("button", { name: "Send message" }).click();
          const request = await gateway.waitForRequest("chat.send");
          const message = asNullableRecord(request.params)?.message;
          expect(message).toBe("/review #123");
          expect(
            resolveSkillCommandInvocation({
              commandBodyNormalized: String(message),
              skillCommands: specs,
            }),
          ).toEqual({ command: specs[0], args: "#123" });
        }
      });
    }
  });
});

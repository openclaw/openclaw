import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Meta Muse source-response picker" });

// Gateway catalog projection; producer semantics stay in models-list-result.muse.test.ts.
const models = [
  {
    id: "muse-spark-1.2",
    name: "Muse Spark 1.2",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "implicit",
    },
    contextWindow: 1048576,
  },
  {
    id: "muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "implicit",
    },
    contextWindow: 1048576,
  },
  {
    id: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "model",
    },
    contextWindow: 1048576,
    recommended: true,
  },
  {
    id: "muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "implicit",
    },
    contextWindow: 1048576,
  },
  {
    id: "muse-wonder-1.0",
    name: "Muse Wonder",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "implicit",
    },
    contextWindow: 1048576,
    recommended: true,
  },
  {
    id: "muse-wonder-1.0-contributor",
    name: "Muse Wonder Contributor",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "implicit",
    },
  },
  {
    id: "muse-wonder-full-1.0",
    name: "Muse Wonder Full",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "implicit",
    },
  },
  {
    id: "muse-wonder-full-1.0-contributor",
    name: "Muse Wonder Full Contributor",
    provider: "meta",
    available: true,
    agentRuntime: {
      id: "muse",
      source: "implicit",
    },
  },
  {
    id: "meta/muse-wonder",
    name: "Meta: Muse Wonder",
    provider: "openrouter",
    available: true,
    contextWindow: 1048576,
  },
  {
    id: "meta/muse-spark-1.3-contributor",
    name: "Meta: Muse Spark 1.3 Contributor",
    provider: "openrouter",
    available: true,
    contextWindow: 1048576,
  },
  {
    id: "meta/muse-spark-1.3",
    name: "Meta: Muse Spark 1.3",
    provider: "openrouter",
    available: true,
    contextWindow: 1048576,
  },
] satisfies ModelCatalogEntry[];

suite.define(() => {
  it("renders available recommended Wonder and sends exact native and different-slug router identities", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const key = "agent:main:main";
      const row = {
        key,
        sessionId: "meta-proof",
        kind: "direct",
        model: "muse-spark-1.3",
        modelProvider: "meta",
        updatedAt: 1,
      };
      const gateway = await installMockGateway(page, {
        agentModel: "meta/muse-spark-1.3",
        models,
        sessions: [row],
        sessionInfo: row,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const picker = page.locator(".chat-controls__model-picker").first();
      await picker.locator("[data-chat-model-select]").click();
      const meta = page.getByRole("region", { name: "Meta models", exact: true });
      const wonder = picker.locator('[data-chat-model-option="meta/muse-wonder-1.0"]').first();
      await revealChatModelOption(picker, "meta/muse-wonder-1.0");
      expect(await wonder.locator(".chat-controls__model-option-name").textContent()).toBe(
        "Muse Wonder",
      );
      const menu = picker.locator(".chat-controls__model-menu");
      const recommendedFrame = await takeControlUiScreenshotFrame(page, menu, [wonder], {
        elements: [menu],
        animations: "disabled",
      });
      await writeFile(
        path.join(suite.artifactDir, "meta-muse-after-recommended.png"),
        recommendedFrame.elements[0]!.png,
      );
      const all = meta.getByRole("button", { name: /All models/ });
      if (await all.count()) {
        await all.click();
      }
      const full = meta
        .locator('[data-chat-model-option="meta/muse-wonder-full-1.0-contributor"]')
        .first();
      await revealChatModelOption(picker, "meta/muse-wonder-full-1.0-contributor");
      expect(await full.textContent()).toContain("Muse Wonder Full Contributor");
      expect(await meta.locator("[data-chat-model-option]").count()).toBe(8);
      const frame = await takeControlUiScreenshotFrame(page, menu, [full], {
        elements: [menu],
        scrollTo: full,
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "meta-muse-after.png"), frame.elements[0]!.png);
      await selectChatModelOption(picker, "meta/muse-wonder-full-1.0-contributor");
      expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
        key,
        model: "meta/muse-wonder-full-1.0-contributor",
      });
      await picker.locator("[data-chat-model-select]").click();
      const router = picker
        .locator('[data-chat-model-option="openrouter/meta/muse-wonder"]')
        .first();
      await revealChatModelOption(picker, "openrouter/meta/muse-wonder");
      expect(await router.textContent()).toContain("Meta: Muse Wonder");
      await selectChatModelOption(picker, "openrouter/meta/muse-wonder");
      await expect.poll(async () => (await gateway.getRequests("sessions.patch")).length).toBe(2);
      expect((await gateway.getRequests("sessions.patch"))[1]?.params).toMatchObject({
        model: "openrouter/meta/muse-wonder",
      });
    });
  });
});

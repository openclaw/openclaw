import { expect, it } from "vitest";
import type { CyberAccessProgram } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { selectChatModel } from "../test-helpers/select-picker-e2e.ts";
import { sendChat } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Daybreak chat controls" });
const key = "agent:main:main";
const models = (
  [
    { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", programs: ["standard", "daybreak_blue"] },
    { id: "gpt-6-cyber", name: "GPT-6 Cyber", programs: ["daybreak_red"] },
    { id: "sample-standard", name: "Sample Standard", programs: ["standard"] },
    { id: "sample-unknown", name: "Sample Unknown" },
  ] satisfies { id: string; name: string; programs?: CyberAccessProgram[] }[]
).map(({ id, name, programs }) => ({
  id,
  name,
  provider: "openai",
  reasoning: true,
  available: true,
  supportsFastMode: true,
  availableAccessPrograms: programs ? { cyber: programs } : undefined,
  cyberAccessProgramDefault: "standard" as const,
}));

suite.define(() => {
  it.each([
    { model: "gpt-6.2-sol", selected: "standard", scenario: "toggle" },
    { model: "gpt-6-cyber", selected: "daybreak_red", scenario: "required" },
    { model: "gpt-6-cyber", selected: "daybreak_blue", scenario: "repair" },
    { model: "gpt-6.2-sol", selected: "daybreak_blue", scenario: "switch model" },
    { model: "gpt-6.2-sol", selected: "daybreak_blue", scenario: "clear on switch" },
    { model: "sample-standard", selected: "standard", scenario: "hide" },
    { model: "sample-standard", selected: "daybreak_blue", scenario: "hide stale" },
    { model: "sample-unknown", selected: "daybreak_blue", scenario: "preserve unknown" },
    { model: "gpt-6-cyber", selected: "daybreak_blue", scenario: "remap on send" },
  ] satisfies { model: string; selected: CyberAccessProgram; scenario: string }[])(
    "Daybreak: $scenario",
    ({ model, selected, scenario }) =>
      suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "openai/" + model,
          models,
          sessions: [
            {
              key,
              label: "Synthetic Daybreak chat",
              model,
              modelProvider: "openai",
              cyberAccessProgram: selected,
              thinkingLevel: "medium",
              thinkingLevels: [{ id: "medium", label: "Medium" }],
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const composer = page.locator(".agent-chat__input");
        if (scenario === "switch model") {
          await selectChatModel(composer, "openai/gpt-6-cyber");
          await gateway.waitForRequest("sessions.patch");
          await expect
            .poll(() => composer.locator("[data-chat-model-select]").textContent())
            .toContain("GPT-6 Cyber");
          expect(await gateway.getRequests("sessions.patch")).toEqual([
            expect.objectContaining({
              params: expect.objectContaining({
                key,
                model: "openai/gpt-6-cyber",
                cyberAccessProgram: "daybreak_red",
              }),
            }),
          ]);
          return;
        }

        const picker = composer.locator(".chat-controls__effort-picker");
        const trigger = picker.locator("summary");
        await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
        await trigger.click();
        const menu = picker.locator(".chat-controls__effort-menu");
        const toggle = menu.getByRole("switch", { name: "Daybreak", exact: true });
        const sendAndReceive = async (program?: CyberAccessProgram, patched = true) => {
          const request = await sendChat(page, gateway, "Check the selected model.");
          expect(
            (await gateway.getRequests())
              .map(({ method }) => method)
              .filter((method) => method === "sessions.patch" || method === "chat.send"),
          ).toEqual(patched ? ["sessions.patch", "chat.send"] : ["chat.send"]);
          expect((await gateway.getSessionRow(key)).cyberAccessProgram).toBe(program);
          expect(typeof request.idempotencyKey).toBe("string");
          const text = "The selected model replied.";
          await gateway.emitChatFinal({ runId: String(request.idempotencyKey), text });
          await page.locator(".chat-group.assistant", { hasText: text }).waitFor();
        };

        if (scenario === "preserve unknown" || scenario === "remap on send") {
          await menu.waitFor();
          const unknown = scenario === "preserve unknown";
          expect(await toggle.count()).toBe(unknown ? 0 : 1);
          await trigger.click();
          await sendAndReceive(unknown ? "daybreak_blue" : "daybreak_red", !unknown);
          return;
        }

        if (scenario === "hide" || scenario === "hide stale") {
          await menu.waitFor();
          if (scenario === "hide stale" && process.env.DAYBREAK_PROOF_IMAGE) {
            await page.screenshot({
              path: process.env.DAYBREAK_PROOF_IMAGE,
              animations: "disabled",
            });
          }
          expect(await toggle.count()).toBe(0);
          if (scenario === "hide stale") {
            await trigger.click();
            await sendAndReceive();
            expect(
              (await gateway.getRequests("sessions.patch")).map(({ params }) => params),
            ).toEqual([expect.objectContaining({ key, cyberAccessProgram: null })]);
          }
          return;
        }

        if (scenario === "clear on switch") {
          expect(await toggle.isChecked()).toBe(true);
          await trigger.click();
          await selectChatModel(composer, "openai/sample-standard");
          const patch = await gateway.waitForRequest("sessions.patch");
          expect(patch.params).toMatchObject({
            key,
            model: "openai/sample-standard",
            cyberAccessProgram: null,
          });
          await trigger.click();
          await menu.waitFor();
          expect(await toggle.count()).toBe(0);
          await trigger.click();
          await sendAndReceive();
          return;
        }

        if (scenario === "required" || scenario === "repair") {
          const required = "Required by this model";
          await toggle.waitFor();
          expect(await toggle.getAttribute("aria-description")).toBe(required);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
          if (scenario === "repair") {
            expect(await toggle.isChecked()).toBe(false);
            expect(await toggle.isEnabled()).toBe(true);
            expect(await menu.getByText("Red", { exact: true }).count()).toBe(0);
            await menu.getByText(required, { exact: true }).waitFor();
            await toggle.check();
            await gateway.waitForRequest("sessions.patch", {
              match: { key, cyberAccessProgram: "daybreak_red" },
            });
          }
          await menu.getByText("Red", { exact: true }).waitFor();
          expect(await toggle.isChecked()).toBe(true);
          await expect.poll(() => toggle.getAttribute("disabled")).not.toBeNull();
          expect(await toggle.getAttribute("aria-description")).toBe(required);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(
            scenario === "repair" ? 1 : 0,
          );
          return;
        }

        await toggle.waitFor();
        expect(await toggle.isChecked()).toBe(false);
        expect(await menu.getByText("Blue", { exact: true }).count()).toBe(0);
        await toggle.check();
        await gateway.waitForRequest("sessions.patch", {
          match: { cyberAccessProgram: "daybreak_blue" },
        });
        await menu.getByText("Blue", { exact: true }).waitFor();
        await expect.poll(() => toggle.isEnabled()).toBe(true);

        const bounds = (await toggle.boundingBox())!;
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        try {
          // A peer refresh can arrive between pointer down and native activation.
          const historyRequests = await gateway.deferNext("chat.history");
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: key,
            session: await gateway.getSessionRow(key),
            messageId: "daybreak-peer-message",
            messageSeq: 1,
            message: {
              role: "user",
              content: [{ type: "text", text: "A peer updated the synthetic test plan." }],
              __openclaw: { id: "daybreak-peer-message", seq: 1 },
            },
          });
          await gateway.waitForRequest("chat.history", { after: historyRequests });
        } finally {
          await page.mouse.up();
          await gateway.resolveDeferred("chat.history");
        }
        await gateway.waitForRequest("sessions.patch", {
          match: { cyberAccessProgram: "standard" },
        });
        await expect.poll(() => toggle.isChecked()).toBe(false);
        await menu.getByText("Blue", { exact: true }).waitFor({ state: "detached" });
      }),
  );

  it("omits Daybreak from a new-session draft on a Standard-only default", () =>
    suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        agentModel: "openai/sample-standard",
        models,
        sessions: [],
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator('[data-chat-thinking-select="true"]').click();
      const menu = page.locator(".chat-controls__effort-menu");
      await menu.locator('[data-chat-speed-option="on"]').waitFor();
      expect(await menu.getByRole("switch", { name: "Daybreak", exact: true }).count()).toBe(0);
    }));
});

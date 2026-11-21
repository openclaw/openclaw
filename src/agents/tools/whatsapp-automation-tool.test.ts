import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createWhatsAppAutomationTool } from "./whatsapp-automation-tool.js";

it("requires the configured private session to advertise reminders and a native turn to use them", async () => {
  const sessionKey = "agent:main:whatsapp:default:direct:+15550000001";
  const config: OpenClawConfig = {
    session: { dmScope: "per-account-channel-peer" },
  };
  expect(createWhatsAppAutomationTool({}, undefined, sessionKey)).toBeNull();
  expect(createWhatsAppAutomationTool(config, undefined, "agent:main:main")).toBeNull();
  const tool = createWhatsAppAutomationTool(config, "synthetic-run", sessionKey);
  expect(tool?.name).toBe("whatsapp_automations");
  const result = await tool?.execute("synthetic-call", { action: "list" });
  expect(result?.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("fresh private WhatsApp request") }),
    ]),
  );
});

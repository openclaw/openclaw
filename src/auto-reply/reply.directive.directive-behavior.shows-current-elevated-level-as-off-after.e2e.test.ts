import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  AUTHORIZED_WHATSAPP_COMMAND,
  installDirectiveBehaviorE2EHooks,
  makeElevatedDirectiveConfig,
  replyText,
  makeRestrictedElevatedDisabledConfig,
  runEmbeddedPiAgent,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

async function runAuthorizedCommand(home: string, body: string) {
  return getReplyFromConfig(
    {
      ...AUTHORIZED_WHATSAPP_COMMAND,
      Body: body,
    },
    {},
    makeElevatedDirectiveConfig(home),
  );
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("shows current elevated level as off after toggling it off", async () => {
    await withTempHome(async (home) => {
      await runAuthorizedCommand(home, "/elevated off");
      const res = await runAuthorizedCommand(home, "/elevated");
      const text = replyText(res);
      expect(text).toContain("Current elevated level: off");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("can toggle elevated off then back on (status reflects on)", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);
      await runAuthorizedCommand(home, "/elevated off");
      await runAuthorizedCommand(home, "/elevated on");
      const res = await runAuthorizedCommand(home, "/status");
      const text = replyText(res);
      const optionsLine = text?.split("\n").find((line) => line.trim().startsWith("⚙️"));
      expect(optionsLine).toBeTruthy();
      expect(optionsLine).toContain("elevated");

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBe("on");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("rejects per-agent elevated when disabled", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:restricted:main",
          CommandAuthorized: true,
        },
        {},
        makeRestrictedElevatedDisabledConfig(home),
      );

      const text = replyText(res);
      expect(text).toContain("agents.list[].tools.elevated.enabled");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../../ui/src/components/config-form.shared.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { OpenClawSchema } from "./zod-schema.js";

const scalarDefaults = {
  theme: "claw",
  themeMode: "system",
  chatShowThinking: true,
  chatShowToolCalls: true,
  chatPersistCommentary: true,
  chatSendShortcut: "enter",
};

describe("UI preference display defaults", () => {
  it("publishes effective constant defaults without materializing authored preferences", () => {
    const response = computeBaseConfigSchemaResponse();
    const prefs = (response.schema as JsonSchema).properties!.ui!.properties!.prefs!;
    for (const [key, value] of Object.entries(scalarDefaults)) {
      expect(prefs.properties![key]!.default, key).toBe(value);
    }
    expect(OpenClawSchema.parse({ ui: { prefs: {} } }).ui?.prefs).toEqual({});
    expect(prefs.properties!.chatFollowUpMode!.default).toBeUndefined();
    expect(prefs.properties!.locale!.default).toBeUndefined();
    expect(response.uiHints["ui.prefs.chatFollowUpMode"]).toMatchObject({
      inheritedDefault: true,
      placeholder: "Default: server queue mode",
    });
    expect(response.uiHints["ui.prefs.locale"]).toMatchObject({
      inheritedDefault: true,
      placeholder: "Default: browser language",
    });
  });
});

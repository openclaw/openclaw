import { expect, it, vi } from "vitest";
import { PluginInstance } from "../plugin-instance.js";
import { warnMentionInboxDeprecation } from "./mention-inbox-deprecation.js";

it("warns once per plugin and released Inbox method, including after a plugin reload", async () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const first = new PluginInstance("mention-compat-first");
  const second = new PluginInstance("mention-compat-second");
  const reloaded = new PluginInstance("mention-compat-first");
  const methods = ["list", "dismiss", "recordCommittedInput", "invalidate"] as const;
  try {
    first.run(() => {
      for (const method of methods) {
        warnMentionInboxDeprecation(method);
        warnMentionInboxDeprecation(method);
      }
    });
    second.run(() => {
      warnMentionInboxDeprecation("list");
      warnMentionInboxDeprecation("list");
    });
    reloaded.run(() => {
      for (const method of methods) {
        warnMentionInboxDeprecation(method);
      }
    });
    expect(warning).toHaveBeenCalledTimes(5);
    for (const { plugin, method } of [
      ...methods.map((name) => ({ plugin: "mention-compat-first", method: name })),
      { plugin: "mention-compat-second", method: "list" },
    ]) {
      const calls = warning.mock.calls.filter(
        ([message]) =>
          String(message).includes(plugin) && String(message).includes(`mentionInbox.${method} `),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toContain(`mentionInbox.${method}Async`);
      expect(calls[0]?.[0]).toContain("next Plugin SDK major");
      expect(calls[0]?.[1]).toMatchObject({
        code: "DEP_SESSION_PERSISTENCE",
        type: "DeprecationWarning",
      });
    }
  } finally {
    warning.mockRestore();
    await Promise.all([first.dispose(), second.dispose(), reloaded.dispose()]);
  }
});

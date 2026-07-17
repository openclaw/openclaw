// Registration proof for the full command-handler barrel. Keep barrel-loading
// assertions here so narrow per-command tests do not import every handler.
import { describe, expect, it } from "vitest";
import { loadCommandHandlers } from "./commands-handlers.runtime.js";
import { handleLoginCommand } from "./commands-login.js";
import { handleNameCommand } from "./commands-name.js";
import { handlePluginCommand } from "./commands-plugin.js";

describe("command handler registration", () => {
  it("registers built-in handlers in the runtime handler list", () => {
    const handlers = loadCommandHandlers();
    expect(handlers).toContain(handleNameCommand);
    expect(handlers).toContain(handleLoginCommand);
  });

  it("keeps plugin text commands ahead of built-in /login", () => {
    const handlers = loadCommandHandlers();
    expect(handlers.indexOf(handlePluginCommand)).toBeLessThan(
      handlers.indexOf(handleLoginCommand),
    );
  });
});

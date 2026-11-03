import { vi } from "vitest";
import type {
  ControlUiActionV2 as ControlUiAction,
  ControlUiHostV2 as ControlUiHost,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { createInitializationContext } from "../pages/chat/chat-application-context.test-support.ts";
import { createTestControlUiPluginHost } from "./control-ui-plugin-host.ts";

export function registerSessionPluginAction(
  context: Pick<ApplicationContext, "plugins" | "gateway">,
  action: ControlUiAction,
) {
  const lifetime = new AbortController();
  const open = vi.fn<ControlUiHost["sessions"]["open"]>();
  const hostContext = Object.assign(createInitializationContext(), context);
  const host = createTestControlUiPluginHost(hostContext, "review", lifetime);
  host.sessions.open = open;
  const entry = {
    key: `review/${action.id}`,
    pluginId: "review",
    value: action,
    signal: lifetime.signal,
    host,
  };
  Object.assign(context.plugins, {
    registrations: vi.fn((kind) => (kind === "actions" ? [entry] : [])),
  });
  return { entry, lifetime, open };
}

/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { ChatFloatingProgress } from "./chat-floating-progress.ts";

it("honors the default-collapse preference only for a new card", () => {
  const controller = new ChatFloatingProgress(vi.fn());
  const scope = { gateway: {}, identity: "a", sessionId: "a", lifetime: {} };
  controller.sync(scope, "", true);
  expect(controller.disclosure("card", vi.fn()).expanded).toBe(false);
  controller.disclosure("card", vi.fn()).onToggle();
  controller.sync({ ...scope }, "", true);
  expect(controller.disclosure("card", vi.fn()).expanded).toBe(true);
  controller.sync({ ...scope, lifetime: {} }, "", true);
  expect(controller.disclosure("new-card", vi.fn()).expanded).toBe(false);
});

it("scopes disclosure choices and rejects callbacks from a replaced card", () => {
  const update = vi.fn();
  const hide = vi.fn();
  const controller = new ChatFloatingProgress(update);
  const scope = { gateway: {}, identity: "a", sessionId: "a", lifetime: {} };
  controller.sync(scope, "");
  const first = controller.disclosure("first", hide);
  first.onToggle();
  expect(controller.disclosure("first", hide).expanded).toBe(false);
  controller.sync({ ...scope, identity: "b", sessionId: "b" }, "");
  first.onToggle();
  first.onHide();
  expect(controller.disclosure("second", hide).expanded).toBe(true);
  expect(hide).not.toHaveBeenCalled();
  const second = controller.disclosure("second", hide);
  second.onToggle();
  controller.sync({ ...scope, gateway: {} }, "browser");
  expect(controller.disclosure("third", hide).expanded).toBe(false);
  controller.disclosure("third", hide).onToggle();
  controller.sync({ ...scope, gateway: {} }, "");
  expect(controller.disclosure("fourth", hide).expanded).toBe(true);
});

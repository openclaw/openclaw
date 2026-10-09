import { expect, it, vi } from "vitest";
import { FileCopyController } from "./chat-file-copy-controller.ts";

it("does not schedule detached editor work during teardown", () => {
  const host = {
    isConnected: true,
    addController: vi.fn(),
    removeController: vi.fn(),
    updateComplete: Promise.resolve(true),
    requestUpdate: vi.fn(),
  };
  const controller = new FileCopyController(host, () => null);
  host.isConnected = false;
  controller.hostDisconnected();
  expect(host.requestUpdate).not.toHaveBeenCalled();
});

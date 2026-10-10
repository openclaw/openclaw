import { expect, it, vi } from "vitest";
import { FileCopyController } from "./chat-file-copy-controller.ts";

it("does not schedule detached editor work during teardown", () => {
  const host = {
    isConnected: true,
    requestUpdate: vi.fn(),
  };
  const controller = new FileCopyController(host, () => null);
  host.isConnected = false;
  controller.dispose();
  expect(host.requestUpdate).not.toHaveBeenCalled();
});

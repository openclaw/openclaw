import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { FileCopyController } from "./chat-file-copy-controller.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
vi.mock("../../../lib/clipboard.ts", () => ({ copyToClipboard: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function fixture() {
  const host = {
    isConnected: true,
    addController: vi.fn(),
    removeController: vi.fn(),
    updateComplete: Promise.resolve(true),
    requestUpdate: vi.fn(),
  };
  let content: SidebarContent | null = {
    kind: "file",
    path: "a.txt",
    name: "a.txt",
    content: "Original",
  };
  const controller = new FileCopyController(host, () => content);
  return {
    host,
    controller,
    replace: () => {
      content = { kind: "file", path: "b.txt", name: "b.txt", content: "Other" };
    },
  };
}
describe("file copy lifecycle", () => {
  it("does not schedule detached editor work during teardown", () => {
    const { host, controller } = fixture();
    host.isConnected = false;
    controller.hostDisconnected();
    expect(host.requestUpdate).not.toHaveBeenCalled();
  });
  it.each(["selection", "reconnection"] as const)(
    "ignores copy completion after %s",
    async (change) => {
      const { host, controller, replace } = fixture();
      let complete: (copied: boolean) => void = () => {
        throw new Error("copy not started");
      };
      vi.mocked(copyToClipboard).mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            complete = resolve;
          }),
      );
      controller.copy("path");
      if (change === "selection") {
        replace();
        controller.reset();
      } else {
        host.isConnected = false;
        controller.hostDisconnected();
        host.isConnected = true;
        controller.hostConnected();
      }
      host.requestUpdate.mockClear();
      complete(true);
      await Promise.resolve();
      expect(controller.feedback).toEqual({});
      expect(host.requestUpdate).not.toHaveBeenCalled();
    },
  );
});

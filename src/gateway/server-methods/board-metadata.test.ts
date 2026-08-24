import { describe, expect, it, vi } from "vitest";
import { createBoardHarness as createHarness } from "./board.test-support.js";

describe("board.metadata gateway method", () => {
  it("returns bounded metadata with isolated per-session failures", async () => {
    const { invoke, store } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "agent:main:with-board",
      name: "status",
      content: { kind: "html", html: "<p>ok</p>" },
    });
    const getSnapshotWithHtmlViewMetadata = vi.spyOn(store, "getSnapshotWithHtmlViewMetadata");
    const getSnapshot = store.getSnapshot.bind(store);
    vi.spyOn(store, "getSnapshot").mockImplementation((sessionKey) => {
      if (sessionKey === "agent:main:unavailable") {
        throw new Error("database busy");
      }
      return getSnapshot(sessionKey);
    });

    const response = await invoke("board.metadata", {
      targets: [
        { sessionKey: "agent:main:with-board" },
        { sessionKey: "agent:main:unavailable" },
        { sessionKey: "agent:main:empty" },
      ],
    });

    expect(response).toHaveBeenCalledWith(true, {
      outcomes: [
        {
          ok: true,
          sessionKey: "agent:main:with-board",
          revision: 1,
          hasBoard: true,
        },
        {
          ok: false,
          sessionKey: "agent:main:unavailable",
          error: { code: "UNAVAILABLE", message: "Error: database busy" },
        },
        {
          ok: true,
          sessionKey: "agent:main:empty",
          revision: 0,
          hasBoard: false,
        },
      ],
    });
    expect(getSnapshotWithHtmlViewMetadata).not.toHaveBeenCalled();
  });

  it("rejects oversized requests before reading the store", async () => {
    const { invoke, store } = createHarness();
    const getSnapshot = vi.spyOn(store, "getSnapshot");

    const response = await invoke("board.metadata", {
      targets: Array.from({ length: 101 }, (_, index) => ({
        sessionKey: `agent:main:${index}`,
      })),
    });

    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(getSnapshot).not.toHaveBeenCalled();
  });
});

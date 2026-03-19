import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../process/exec.js", () => ({
  runExec: vi.fn(),
}));

import { runExec } from "../../process/exec.js";
import { dispatchBuiltInMailButtonsInteractiveHandler, parseNextThreadId } from "./mail-buttons.js";

const mockedRunExec = vi.mocked(runExec);

describe("mail buttons built-in interactive handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses next callbacks with the thread id", () => {
    expect(parseNextThreadId("next:19d05a032de0fce7")).toBe("19d05a032de0fce7");
  });

  it("marks the current thread read and returns the next unread thread summary", async () => {
    mockedRunExec.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          id: "19d032aae8dab340",
          from: "Alice <alice@example.com>",
          subject: "Quarterly update",
          date: "2026-03-19 13:20",
          labels: ["INBOX", "UNREAD"],
        },
      ]),
      stderr: "",
    });
    const reply = vi.fn(async () => {});

    const result = await dispatchBuiltInMailButtonsInteractiveHandler({
      channel: "telegram",
      data: "mb:next:19d05a032de0fce7",
      respond: {
        reply,
        editMessage: vi.fn(async () => {}),
        editButtons: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        deleteMessage: vi.fn(async () => {}),
      },
    });

    expect(result).toEqual({ matched: true, handled: true });
    expect(mockedRunExec).toHaveBeenNthCalledWith(
      1,
      "gog",
      ["gmail", "thread", "modify", "19d05a032de0fce7", "--remove", "UNREAD"],
      {
        timeoutMs: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(mockedRunExec).toHaveBeenNthCalledWith(
      2,
      "gog",
      [
        "gmail",
        "search",
        "is:unread",
        "-thread:19d05a032de0fce7",
        "--max",
        "1",
        "--json",
        "--results-only",
      ],
      {
        timeoutMs: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(reply).toHaveBeenCalledWith({
      text:
        "Next unread Gmail thread\n" +
        "Thread: 19d032aae8dab340\n" +
        "From: Alice <alice@example.com>\n" +
        "Subject: Quarterly update\n" +
        "Date: 2026-03-19 13:20\n" +
        "Labels: INBOX, UNREAD",
    });
  });

  it("reports when there are no unread threads left", async () => {
    mockedRunExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" });
    const reply = vi.fn(async () => {});

    const result = await dispatchBuiltInMailButtonsInteractiveHandler({
      channel: "telegram",
      data: "mb:next:19d05a032de0fce7",
      respond: {
        reply,
        editMessage: vi.fn(async () => {}),
        editButtons: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        deleteMessage: vi.fn(async () => {}),
      },
    });

    expect(result).toEqual({ matched: true, handled: true });
    expect(reply).toHaveBeenCalledWith({
      text: "Marked Gmail thread 19d05a032de0fce7 as read. No more unread Gmail threads.",
    });
  });
});

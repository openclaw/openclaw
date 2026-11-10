/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

it.each([false, true])("physically stops only an issued smooth command (issued: %s)", (issued) => {
  installTranscriptDomMocks();
  const host = new ChatSessionVirtualizerHost(vi.fn());
  onTestFinished(() => {
    host.dispose();
    resetTranscriptTestDom();
  });
  const element = document.createElement("div");
  element.scrollTop = 100;
  vi.spyOn(host, "scrollElement", "get").mockReturnValue(element);
  const stop = vi.spyOn(host.virtualizer, "scrollToOffset").mockImplementation(() => {});
  const cancel = vi.spyOn(host.virtualizer, "cancelScroll");
  host.offsetState.scrollCommand = {
    target: "end",
    behavior: "smooth",
    ...(issued ? { offset: 700 } : {}),
  };
  host.cancelScroll();
  expect(host.offsetState.scrollCommand).toBeNull();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(issued ? 1 : 0);
  if (issued) {
    expect(stop).toHaveBeenCalledExactlyOnceWith(100, { behavior: "instant" });
  }
});

it("does not stop a reconnected host at the same native element", () => {
  installTranscriptDomMocks();
  const host = new ChatSessionVirtualizerHost(vi.fn());
  onTestFinished(() => {
    host.dispose();
    resetTranscriptTestDom();
  });
  const element = document.createElement("div");
  vi.spyOn(host, "scrollElement", "get").mockReturnValue(element);
  host.connect();
  const stop = vi.spyOn(host.virtualizer, "scrollToOffset").mockImplementation(() => {});
  host.offsetState.scrollCommand = { target: "end", behavior: "smooth", offset: 700 };
  vi.spyOn(host.initialRange, "finishEnd").mockImplementationOnce(() => {
    host.disconnect();
    host.connect();
  });
  host.cancelScroll();
  expect(host.connected).toBe(true);
  expect(stop).not.toHaveBeenCalled();
});

it.each(
  (["replacement command", "reconnected host"] as const).flatMap((change) =>
    (["settlement", "native write"] as const).map((phase) => ({ change, phase })),
  ),
)("does not overwrite a completed end after $change during $phase", ({ change, phase }) => {
  installTranscriptDomMocks();
  const host = new ChatSessionVirtualizerHost(vi.fn());
  onTestFinished(() => {
    host.dispose();
    resetTranscriptTestDom();
  });
  const element = document.createElement("div");
  vi.spyOn(host, "scrollElement", "get").mockReturnValue(element);
  host.connect();
  const capture = vi.spyOn(TranscriptEndAnchor.prototype, "capture");
  onTestFinished(() => capture.mockRestore());
  const replacement = { target: "end", behavior: "auto", offset: 900 } as const;
  const replace = () => {
    expect(host.offsetState.scrollCommand).toBeNull();
    if (change === "replacement command") {
      host.offsetState.scrollCommand = replacement;
    } else {
      host.disconnect();
      host.connect();
    }
  };
  const settle = vi.spyOn(host.initialRange, "finishEndWhenSettled").mockImplementationOnce(() => {
    if (phase === "settlement") {
      replace();
    }
  });
  const finish = vi.spyOn(host.virtualizer, "scrollToOffset").mockImplementation(() => {
    if (phase === "native write") {
      replace();
    }
  });
  host.offsetState.scrollCommand = { target: "end", behavior: "smooth", offset: 700 };
  host.cancelScroll(true);
  expect(settle).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledTimes(phase === "native write" ? 1 : 0);
  if (phase === "native write") {
    expect(finish).toHaveBeenCalledExactlyOnceWith(element.scrollTop, { behavior: "instant" });
  }
  expect(capture).toHaveBeenCalledTimes(1);
  if (change === "replacement command") {
    expect(host.offsetState.scrollCommand).toBe(replacement);
  } else {
    expect(host.connected).toBe(true);
  }
});

it("retargets automatic following during commandless end settlement", () => {
  installTranscriptDomMocks();
  const host = new ChatSessionVirtualizerHost(vi.fn());
  onTestFinished(() => {
    host.dispose();
    resetTranscriptTestDom();
  });
  host.initialRange.preparingEnd = true;
  const prepare = vi.spyOn(host.initialRange, "prepareEnd").mockImplementation(() => {});
  expect(host.scrollToEnd({ source: "auto", behavior: "auto" })).toBe(true);
  expect(prepare).toHaveBeenCalledOnce();
  const command = host.offsetState.scrollCommand;
  expect(command).toMatchObject({ target: "end", behavior: "auto" });
  host.initialRange.preparingEnd = true;
  expect(host.scrollToEnd({ source: "auto", behavior: "auto" })).toBe(true);
  expect(host.offsetState.scrollCommand).toBe(command);
  expect(prepare).toHaveBeenCalledOnce();
});

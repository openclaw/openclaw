import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  reportCreatedVisibleWorkSession,
  withVisibleWorkSessionReporter,
} from "./visible-work-sessions.js";

const child = {
  requesterSessionKey: "agent:main:parent",
  sessionKey: "agent:main:child",
  visibleSession: { url: "https://example.test/chat/child" },
};

describe("visible work session reporting scope", () => {
  it("isolates unrelated and nested turns from the parent's reporter", async () => {
    const report = vi.fn();
    await withVisibleWorkSessionReporter(
      { requesterSessionKey: child.requesterSessionKey, report },
      async () => {
        await reportCreatedVisibleWorkSession({ ...child, requesterSessionKey: "unrelated" });
        await withVisibleWorkSessionReporter({}, () => reportCreatedVisibleWorkSession(child));
        expect(report).not.toHaveBeenCalled();
        await reportCreatedVisibleWorkSession(child);
      },
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      [{ sessionKey: child.sessionKey, ...child.visibleSession }],
      { createdSessionKey: child.sessionKey },
    );
  });

  it("retires a reporter retained by work after its parent turn ended", async () => {
    const report = vi.fn();
    const resume = createDeferred();
    let lateReport: Promise<void> | undefined;
    await withVisibleWorkSessionReporter(
      { requesterSessionKey: child.requesterSessionKey, report },
      async () => {
        lateReport = resume.promise.then(() => reportCreatedVisibleWorkSession(child));
      },
    );
    resume.resolve();
    await lateReport;
    expect(report).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../version.js", () => ({ VERSION: "2026.3.23" }));
vi.mock("../terminal/note.js", () => ({ note: vi.fn() }));

import { note } from "../terminal/note.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import { runVersionSkewHealth } from "./doctor-version-skew.js";

function makeCtx(lastTouchedVersion: unknown): DoctorHealthFlowContext {
  return {
    cfg: {
      meta: lastTouchedVersion !== undefined ? { lastTouchedVersion } : undefined,
    },
  } as unknown as DoctorHealthFlowContext;
}

describe("runVersionSkewHealth", () => {
  beforeEach(() => {
    vi.mocked(note).mockClear();
  });

  it("emits no warning when versions match", async () => {
    await runVersionSkewHealth(makeCtx("2026.3.23"));
    expect(note).not.toHaveBeenCalled();
  });

  it("warns when config version is newer than the binary", async () => {
    await runVersionSkewHealth(makeCtx("2026.4.1"));
    expect(note).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith(expect.stringContaining("2026.4.1"), "Version skew");
  });

  it("emits no warning when binary version is newer than config", async () => {
    await runVersionSkewHealth(makeCtx("2026.2.1"));
    expect(note).not.toHaveBeenCalled();
  });

  it("emits no warning when lastTouchedVersion is missing", async () => {
    await runVersionSkewHealth(makeCtx(undefined));
    expect(note).not.toHaveBeenCalled();
  });

  it("emits no warning when lastTouchedVersion is a non-string value", async () => {
    await runVersionSkewHealth(makeCtx(12345));
    expect(note).not.toHaveBeenCalled();
  });
});

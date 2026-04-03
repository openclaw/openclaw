import { describe, expect, it, vi } from "vitest";
import { withTempHomeConfig } from "../config/test-helpers.js";
import { note } from "../terminal/note.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

const noteSpy = vi.mocked(note);

describe("doctor include warning", () => {
  it("surfaces include confinement hint for escaped include paths", async () => {
    await withTempHomeConfig({ $include: "/etc/passwd" }, async () => {
      await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });
    });

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("$include paths must stay under:"),
      "Doctor warnings",
    );
  });
});

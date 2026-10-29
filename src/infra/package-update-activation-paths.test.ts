import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPackageActivationControlPath,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
  resolvePackageActivationAnchor,
} from "./package-update-activation-paths.js";

describe("isPackageActivationControlPath", () => {
  it("identifies the activation journal inside a .control directory", () => {
    const anchor = resolvePackageActivationAnchor("npm-global-install-key");
    const journal = resolvePackageActivationJournalPath(anchor);
    expect(isPackageActivationControlPath(journal)).toBe(true);
  });

  it("identifies files inside the .control directory", () => {
    const anchor = resolvePackageActivationAnchor("some-install-key");
    expect(
      isPackageActivationControlPath(
        path.join(resolvePackageActivationControl(anchor), "recovery.mjs"),
      ),
    ).toBe(true);
  });

  it("identifies files inside the anchor directory itself", () => {
    const anchor = resolvePackageActivationAnchor("another-key");
    expect(isPackageActivationControlPath(path.join(anchor, "anything.sqlite"))).toBe(true);
  });

  it("rejects ordinary package files", () => {
    expect(
      isPackageActivationControlPath(
        path.join(path.sep, "lib", "node_modules", "openclaw", "dist", "index.js"),
      ),
    ).toBe(false);
  });

  it("rejects unrelated dot-directories that merely look similar", () => {
    expect(
      isPackageActivationControlPath(
        path.join(path.sep, ".other.package-activation-x", "file.txt"),
      ),
    ).toBe(false);
  });
});

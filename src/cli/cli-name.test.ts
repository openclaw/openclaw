import { describe, expect, it } from "vitest";
import {
  CLAWORKS_CLI_NAME,
  isClaworksCliProduct,
  OPENCLAW_CLI_NAME,
  replaceCliName,
  replaceEmbeddedCliNames,
  resolveCliName,
  resolveCliProductEmoji,
  resolveCliProductTitle,
} from "./cli-name.js";

describe("isClaworksCliProduct", () => {
  it("returns false by default", () => {
    expect(isClaworksCliProduct({})).toBe(false);
  });

  it("returns true when CLAWORKS_PRODUCT=1", () => {
    expect(isClaworksCliProduct({ CLAWORKS_PRODUCT: "1" })).toBe(true);
  });

  it("returns true when CLAWORKS_PRODUCT=true", () => {
    expect(isClaworksCliProduct({ CLAWORKS_PRODUCT: "true" })).toBe(true);
  });
});

describe("resolveCliName", () => {
  it("returns openclaw by default", () => {
    expect(resolveCliName(["node", "/usr/bin/openclaw"], {})).toBe(OPENCLAW_CLI_NAME);
  });

  it("returns claworks when argv1 basename is claworks", () => {
    expect(resolveCliName(["node", "/usr/bin/claworks"], {})).toBe(CLAWORKS_CLI_NAME);
  });

  it("returns claworks from env when argv1 is openclaw.mjs (wrapped)", () => {
    expect(resolveCliName(["node", "/path/to/openclaw.mjs"], { CLAWORKS_PRODUCT: "1" })).toBe(
      CLAWORKS_CLI_NAME,
    );
  });

  it("returns claworks from env when argv is missing", () => {
    expect(resolveCliName([], { CLAWORKS_PRODUCT: "1" })).toBe(CLAWORKS_CLI_NAME);
  });

  it("prefers explicit argv basename over env", () => {
    // When argv1 explicitly says "openclaw", env should not override
    // (env fallback only activates when basename is not in KNOWN_CLI_NAMES)
    expect(resolveCliName(["node", "/usr/bin/openclaw"], { CLAWORKS_PRODUCT: "1" })).toBe(
      OPENCLAW_CLI_NAME,
    );
  });
});

describe("resolveCliProductTitle", () => {
  it("returns ClaWorks for claworks cli name", () => {
    expect(resolveCliProductTitle(CLAWORKS_CLI_NAME)).toBe("ClaWorks");
  });

  it("returns OpenClaw for openclaw cli name", () => {
    expect(resolveCliProductTitle(OPENCLAW_CLI_NAME)).toBe("OpenClaw");
  });
});

describe("resolveCliProductEmoji", () => {
  it("returns hawk emoji for claworks", () => {
    expect(resolveCliProductEmoji(CLAWORKS_CLI_NAME)).toBe("🦅");
  });

  it("returns lobster emoji for openclaw", () => {
    expect(resolveCliProductEmoji(OPENCLAW_CLI_NAME)).toBe("🦞");
  });
});

describe("replaceCliName", () => {
  it("replaces openclaw prefix with current cli name", () => {
    expect(replaceCliName("openclaw doctor", "claworks")).toBe("claworks doctor");
  });

  it("replaces claworks prefix with current cli name", () => {
    expect(replaceCliName("claworks status", "openclaw")).toBe("openclaw status");
  });

  it("preserves runner prefix", () => {
    expect(replaceCliName("pnpm openclaw doctor", "claworks")).toBe("pnpm claworks doctor");
  });

  it("returns unchanged string when no known prefix", () => {
    expect(replaceCliName("doctor --fix", "claworks")).toBe("doctor --fix");
  });
});

describe("replaceEmbeddedCliNames", () => {
  it("replaces embedded openclaw command tokens", () => {
    expect(replaceEmbeddedCliNames("Run `openclaw doctor` next.", "claworks")).toBe(
      "Run `claworks doctor` next.",
    );
    expect(replaceEmbeddedCliNames("Command: openclaw status --probe", "claworks")).toBe(
      "Command: claworks status --probe",
    );
    expect(replaceEmbeddedCliNames("Re-run openclaw.", "claworks")).toBe("Re-run claworks.");
  });

  it("preserves openclaw.ai marketing URLs", () => {
    expect(replaceEmbeddedCliNames("https://openclaw.ai/showcase", "claworks")).toBe(
      "https://openclaw.ai/showcase",
    );
  });
});
